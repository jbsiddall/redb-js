import fs from "node:fs";
import path from "node:path";

/**
 * Node.js single-file StorageBackend for redb-wasm using node:fs.
 * Works on Node.js, Bun, and Deno with zero external dependencies.
 *
 * @param {string} filePath Path to the single .redb database file
 * @param {{ readOnly?: boolean, createDirs?: boolean, mode?: number }} [options]
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

  const ensureOpen = () => {
    if (closed) {
      throw new Error("Node file backend is closed");
    }
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
      let total = 0;
      while (total < len) {
        const n = fs.readSync(fd, dst, total, len - total, offset + total);
        if (n === 0) break;
        total += n;
      }
      return total;
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
      let total = 0;
      while (total < len) {
        const n = fs.writeSync(fd, src, total, len - total, offset + total);
        if (n === 0) {
          throw new Error("Short write (0 bytes written)");
        }
        total += n;
      }
      const end = offset + total;
      if (end > cachedLen) {
        cachedLen = end;
        sizeChangedSinceSync = true;
      }
    },

    /** @returns {number} */
    len() {
      ensureOpen();
      return cachedLen;
    },

    /** @param {number} newLen */
    setLen(newLen) {
      ensureOpen();
      if (readOnly) {
        throw new Error("Cannot resize a read-only Node file backend");
      }
      fs.ftruncateSync(fd, newLen);
      cachedLen = newLen;
      sizeChangedSinceSync = true;
    },

    sync() {
      ensureOpen();
      if (!readOnly && enableSync) {
        // fdatasync avoids unnecessary inode mtime journal flushes on Linux when
        // file size is unchanged while preserving full crash/power-loss durability.
        if (!sizeChangedSinceSync && typeof fs.fdatasyncSync === "function") {
          fs.fdatasyncSync(fd);
        } else {
          fs.fsyncSync(fd);
          sizeChangedSinceSync = false;
        }
      }
    },

    close() {
      if (!closed) {
        closed = true;
        fs.closeSync(fd);
      }
    },
  };
}
