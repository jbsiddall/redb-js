import fs from "node:fs";
import path from "node:path";

const PAGE_ALIGN = 4096;
const WRITE_BUF_LIMIT = 2 * 1024 * 1024; // 2 MiB coalescing buffer cap
const READ_AHEAD_SIZE = 64 * 1024; // 64 KiB sequential read-ahead

/**
 * Node.js single-file StorageBackend for redb-wasm using node:fs.
 * Works on Node.js, Bun, and Deno with zero external dependencies.
 *
 * Includes sorted contiguous write coalescing (`fs.writevSync`, superblock at
 * offset 0 flushed last) and sequential read-ahead while preserving 100% crash
 * safety.
 *
 * @param {string} filePath Path to the single .redb database file
 * @param {{ readOnly?: boolean, createDirs?: boolean, mode?: number, sync?: boolean }} [options]
 */
export function createNodeFileBackend(filePath, options = {}) {
  const readOnly = Boolean(options.readOnly);
  const enableSync = options.sync !== false;
  const mode = options.mode ?? 0o644;

  if (!readOnly && options.createDirs !== false) {
    const dir = path.dirname(filePath);
    if (dir && dir !== ".") {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const flags = readOnly
    ? fs.constants.O_RDONLY
    : fs.constants.O_RDWR | fs.constants.O_CREAT;

  const fd = fs.openSync(filePath, flags, mode);
  let closed = false;
  let cachedLen = fs.fstatSync(fd).size;
  let sizeChangedSinceSync = false;

  // Sorted write-coalescing buffer with zero-alloc reusable slab:
  // - `pendingPages`: Map<pageOffset (multiple of 4096), Uint8Array(4096) slice of writeSlab>
  // - `pendingHeader`: small write at offset 0 (e.g. 320-byte redb superblock)
  /** @type {Map<number, Uint8Array>} */
  const pendingPages = new Map();
  /** @type {Uint8Array | null} */
  let writeSlab = null;
  let slabUsed = 0;
  let pendingMaxEnd = 0;
  /** @type {Uint8Array | null} */
  let pendingHeader = null;
  let pendingHeaderLen = 0;

  // Sequential read-ahead cache (invalidated on any write/setLen/close)
  /** @type {Uint8Array | null} */
  let raBuf = null;
  let raStart = 0;
  let raEnd = 0;
  let lastReadEnd = -1;

  const ensureOpen = () => {
    if (closed) {
      throw new Error("Node file backend is closed");
    }
  };

  const invalidateReadAhead = () => {
    raStart = 0;
    raEnd = 0;
    lastReadEnd = -1;
  };

  const writeDirect = (offset, src, len = src.byteLength) => {
    if (len === 0) return;
    let total = 0;
    try {
      while (total < len) {
        const n = fs.writeSync(fd, src, total, len - total, offset + total);
        if (n === 0) {
          throw new Error("Short write (0 bytes written)");
        }
        total += n;
      }
    } finally {
      if (total > 0) {
        const end = offset + total;
        if (end > cachedLen) {
          cachedLen = end;
          sizeChangedSinceSync = true;
        }
      }
    }
  };

  const writeContiguousRun = (startOffset, bufs) => {
    if (bufs.length === 1) {
      writeDirect(startOffset, bufs[0]);
      return;
    }
    if (typeof fs.writevSync === "function") {
      let expected = 0;
      for (let i = 0; i < bufs.length; i++) expected += bufs[i].byteLength;
      let written = 0;
      try {
        written = fs.writevSync(fd, bufs, startOffset);
      } finally {
        if (written > 0) {
          const end = startOffset + written;
          if (end > cachedLen) {
            cachedLen = end;
            sizeChangedSinceSync = true;
          }
        }
      }
      if (written < expected) {
        // Fallback for rare partial writevSync
        let pos = 0;
        for (let i = 0; i < bufs.length; i++) {
          const b = bufs[i];
          const bLen = b.byteLength;
          if (pos + bLen <= written) {
            pos += bLen;
            continue;
          }
          const skip = pos < written ? written - pos : 0;
          writeDirect(startOffset + pos + skip, b.subarray(skip));
          pos += bLen;
        }
      }
      return;
    }
    let off = startOffset;
    for (let i = 0; i < bufs.length; i++) {
      writeDirect(off, bufs[i]);
      off += bufs[i].byteLength;
    }
  };

  const flushWrites = () => {
    if (pendingPages.size === 0 && pendingHeaderLen === 0) return;
    invalidateReadAhead();
    try {
      /** @type {Uint8Array | null} */
      let page0 = null;
      if (pendingPages.size > 0) {
        if (pendingPages.has(0)) {
          page0 = pendingPages.get(0);
          pendingPages.delete(0);
        }
        if (pendingPages.size > 0) {
          const offsets = Array.from(pendingPages.keys());
          offsets.sort((a, b) => a - b);

          let runStart = offsets[0];
          let runNext = runStart + PAGE_ALIGN;
          /** @type {Uint8Array[]} */
          let runBufs = [pendingPages.get(runStart)];

          for (let i = 1; i < offsets.length; i++) {
            const off = offsets[i];
            const buf = pendingPages.get(off);
            if (off === runNext) {
              runBufs.push(buf);
              runNext += PAGE_ALIGN;
            } else {
              writeContiguousRun(runStart, runBufs);
              runStart = off;
              runNext = off + PAGE_ALIGN;
              runBufs = [buf];
            }
          }
          writeContiguousRun(runStart, runBufs);
        }
      }

      // Write offset 0 (page 0 / redb superblock) strictly LAST after all data pages.
      if (page0 !== null) {
        if (pendingHeaderLen > 0) {
          page0.set(pendingHeader.subarray(0, pendingHeaderLen), 0);
        }
        writeDirect(0, page0);
      } else if (pendingHeaderLen > 0) {
        writeDirect(0, pendingHeader, pendingHeaderLen);
      }
    } finally {
      pendingPages.clear();
      pendingHeaderLen = 0;
      slabUsed = 0;
      pendingMaxEnd = 0;
    }
  };

  const readDirect = (offset, dst) => {
    const len = dst.byteLength;
    let total = 0;
    while (total < len) {
      const n = fs.readSync(fd, dst, total, len - total, offset + total);
      if (n === 0) break;
      total += n;
    }
    return total;
  };

  return {
    /**
     * @param {number} offset
     * @param {Uint8Array} dst
     * @returns {number}
     */
    read(offset, dst) {
      ensureOpen();
      const len = dst.byteLength;
      if (len === 0) return 0;

      if (pendingPages.size > 0 || pendingHeaderLen > 0) {
        flushWrites();
      }

      // Serve from sequential read-ahead cache if covered
      if (raEnd > raStart && offset >= raStart && offset + len <= raEnd) {
        const rel = offset - raStart;
        dst.set(raBuf.subarray(rel, rel + len));
        lastReadEnd = offset + len;
        return len;
      }

      // Trigger sequential read-ahead on the 2nd consecutive adjacent read
      if (len <= 16384 && offset === lastReadEnd && offset < cachedLen) {
        if (!raBuf) raBuf = new Uint8Array(READ_AHEAD_SIZE);
        const want = Math.min(READ_AHEAD_SIZE, cachedLen - offset);
        if (want >= len) {
          const got = readDirect(offset, raBuf.subarray(0, want));
          raStart = offset;
          raEnd = offset + got;
          const copyLen = got < len ? got : len;
          if (copyLen > 0) dst.set(raBuf.subarray(0, copyLen));
          lastReadEnd = offset + copyLen;
          return copyLen;
        }
      }

      const got = readDirect(offset, dst);
      lastReadEnd = offset + got;
      return got;
    },

    /**
     * @param {number} offset
     * @param {Uint8Array} src
     */
    write(offset, src) {
      ensureOpen();
      if (readOnly) {
        throw new Error("Cannot write to a read-only Node file backend");
      }
      const len = src.byteLength;
      if (len === 0) return;

      invalidateReadAhead();

      // Fast path 1: small superblock/header write at offset 0
      if (offset === 0 && len < PAGE_ALIGN) {
        const page0 = pendingPages.get(0);
        if (page0) {
          page0.set(src, 0);
        } else {
          if (!pendingHeader || pendingHeader.byteLength < len) {
            pendingHeader = new Uint8Array(PAGE_ALIGN);
          }
          pendingHeader.set(src, 0);
          pendingHeaderLen = len;
        }
        if (len > pendingMaxEnd) pendingMaxEnd = len;
        return;
      }

      // Fast path 2: 4 KiB-aligned page writes (single or multi-page)
      if ((offset & (PAGE_ALIGN - 1)) === 0 && (len & (PAGE_ALIGN - 1)) === 0 && len <= WRITE_BUF_LIMIT) {
        if (slabUsed + len > WRITE_BUF_LIMIT) {
          flushWrites();
        }
        if (!writeSlab) writeSlab = new Uint8Array(WRITE_BUF_LIMIT);
        for (let rel = 0; rel < len; rel += PAGE_ALIGN) {
          const pageOff = offset + rel;
          let slot = pendingPages.get(pageOff);
          if (!slot) {
            slot = writeSlab.subarray(slabUsed, slabUsed + PAGE_ALIGN);
            slabUsed += PAGE_ALIGN;
            pendingPages.set(pageOff, slot);
          }
          slot.set(src.subarray(rel, rel + PAGE_ALIGN), 0);
          if (pageOff === 0 && pendingHeaderLen > 0) {
            // Full page 0 overwrite supersedes earlier small header write
            pendingHeaderLen = 0;
          }
        }
        const end = offset + len;
        if (end > pendingMaxEnd) pendingMaxEnd = end;
        return;
      }

      // Unaligned / non-page-sized fallback: flush pending writes then write directly
      if (pendingPages.size > 0 || pendingHeaderLen > 0) {
        flushWrites();
      }
      writeDirect(offset, src, len);
    },

    /** @returns {number} */
    len() {
      ensureOpen();
      return pendingMaxEnd > cachedLen ? pendingMaxEnd : cachedLen;
    },

    /** @param {number} newLen */
    setLen(newLen) {
      ensureOpen();
      if (readOnly) {
        throw new Error("Cannot resize a read-only Node file backend");
      }
      flushWrites();
      invalidateReadAhead();
      fs.ftruncateSync(fd, newLen);
      cachedLen = newLen;
      sizeChangedSinceSync = true;
    },

    /**
     * Flush coalesced writes to the OS page cache without calling fsync/fdatasync.
     */
    flushWrites() {
      ensureOpen();
      if (!readOnly) {
        flushWrites();
      }
    },

    sync() {
      ensureOpen();
      if (!readOnly) {
        flushWrites();
        if (enableSync) {
          // fdatasync avoids unnecessary inode mtime journal flushes on Linux when
          // file size is unchanged while preserving full crash/power-loss durability.
          if (!sizeChangedSinceSync && typeof fs.fdatasyncSync === "function") {
            fs.fdatasyncSync(fd);
          } else {
            fs.fsyncSync(fd);
            sizeChangedSinceSync = false;
          }
        }
      }
    },

    close() {
      if (!closed) {
        try {
          if (!readOnly) {
            flushWrites();
          }
        } finally {
          closed = true;
          invalidateReadAhead();
          fs.closeSync(fd);
        }
      }
    },
  };
}
