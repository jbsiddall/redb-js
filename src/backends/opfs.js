/**
 * Browser OPFS (Origin Private File System) single-file backend for redb-wasm.
 *
 * Uses FileSystemSyncAccessHandle, which is available inside Dedicated Web Workers
 * in all modern browsers (Chrome, Firefox, Safari, Edge).
 *
 * Includes sorted contiguous write coalescing (superblock at offset 0 flushed last)
 * and sequential read-ahead to minimize Worker<->Storage-process IPC round-trips.
 */

const HAS_SAB = typeof SharedArrayBuffer !== "undefined";
const PAGE_ALIGN = 4096;
const WRITE_BUF_LIMIT = 2 * 1024 * 1024; // 2 MiB coalescing buffer cap
const READ_AHEAD_SIZE = 64 * 1024; // 64 KiB sequential read-ahead

/**
 * Wrap an already-opened FileSystemSyncAccessHandle as a redb-wasm StorageBackend.
 * @param {any} syncHandle
 * @param {{ sync?: boolean }} [options]
 */
export function createOpfsBackendFromHandle(syncHandle, options = {}) {
  let closed = false;
  const enableSync = options.sync !== false;
  let cachedLen = syncHandle.getSize();
  const ioOpts = { at: 0 };
  /** @type {Uint8Array | null} */
  let scratch = null;

  // Sorted write-coalescing buffer with zero-alloc reusable slab
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
      throw new Error("OPFS backend is closed");
    }
  };

  const invalidateReadAhead = () => {
    raStart = 0;
    raEnd = 0;
    lastReadEnd = -1;
  };

  const getScratch = (needed) => {
    if (!scratch || scratch.byteLength < needed) {
      let cap = 65536;
      while (cap < needed) cap *= 2;
      scratch = new Uint8Array(cap);
    }
    return scratch.subarray(0, needed);
  };

  const writeDirect = (offset, src, len = src.byteLength) => {
    if (len === 0) return;
    const isSab = HAS_SAB && src.buffer instanceof SharedArrayBuffer;
    let source = len === src.byteLength ? src : src.subarray(0, len);
    if (isSab) {
      const tmp = getScratch(len);
      tmp.set(source);
      source = tmp;
    }

    let total = 0;
    try {
      while (total < len) {
        ioOpts.at = offset + total;
        const slice = total === 0 ? source : source.subarray(total);
        const n = syncHandle.write(slice, ioOpts);
        if (n === 0) {
          throw new Error("OPFS short write (0 bytes written)");
        }
        total += n;
      }
    } finally {
      if (total > 0) {
        const end = offset + total;
        if (end > cachedLen) cachedLen = end;
      }
    }
  };

  const writeContiguousRun = (startOffset, bufs) => {
    if (bufs.length === 1) {
      writeDirect(startOffset, bufs[0]);
      return;
    }
    const totalLen = bufs.length * PAGE_ALIGN;
    const run = getScratch(totalLen);
    for (let i = 0; i < bufs.length; i++) {
      run.set(bufs[i], i * PAGE_ALIGN);
    }
    writeDirect(startOffset, run, totalLen);
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
    const isSab = HAS_SAB && dst.buffer instanceof SharedArrayBuffer;
    const target = isSab ? getScratch(len) : dst;

    let total = 0;
    while (total < len) {
      ioOpts.at = offset + total;
      const slice = total === 0 ? target : target.subarray(total);
      const n = syncHandle.read(slice, ioOpts);
      if (n === 0) break;
      total += n;
    }

    if (isSab && total > 0) {
      dst.set(target.subarray(0, total), 0);
    }
    return total;
  };

  return {
    /**
     * Read bytes from the OPFS file at `offset` into `dst`.
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
     * Write bytes from `src` into the OPFS file at `offset`.
     * @param {number} offset
     * @param {Uint8Array} src
     */
    write(offset, src) {
      ensureOpen();
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
            pendingHeaderLen = 0;
          }
        }
        const end = offset + len;
        if (end > pendingMaxEnd) pendingMaxEnd = end;
        return;
      }

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
      flushWrites();
      invalidateReadAhead();
      syncHandle.truncate(newLen);
      cachedLen = newLen;
    },

    /**
     * Flush coalesced writes to the OPFS handle without calling syncHandle.flush().
     */
    flushWrites() {
      ensureOpen();
      flushWrites();
    },

    sync() {
      ensureOpen();
      flushWrites();
      if (enableSync) {
        syncHandle.flush();
      }
    },

    close() {
      if (!closed) {
        try {
          flushWrites();
        } finally {
          closed = true;
          invalidateReadAhead();
          syncHandle.close();
        }
      }
    },
  };
}

/**
 * Open (or create) a single file in the browser's Origin Private File System (OPFS)
 * and return a synchronous StorageBackend backed by FileSystemSyncAccessHandle.
 *
 * Must be called inside a Dedicated Web Worker.
 *
 * @param {string} path Relative path inside OPFS (e.g. "app.redb" or "data/app.redb")
 * @param {{ create?: boolean, sync?: boolean }} [options]
 */
export async function createOpfsBackend(path, options = {}) {
  const create = options.create !== false;
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    throw new Error("OPFS is not available in this environment");
  }

  const parts = path.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) {
    throw new Error(`Invalid OPFS file path: ${path}`);
  }

  let dir = await navigator.storage.getDirectory();
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create });
  }

  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create });
  if (typeof fileHandle.createSyncAccessHandle !== "function") {
    throw new Error(
      "FileSystemFileHandle.createSyncAccessHandle() is only available inside a Dedicated Web Worker"
    );
  }

  const syncHandle = await fileHandle.createSyncAccessHandle();
  return createOpfsBackendFromHandle(syncHandle, options);
}
