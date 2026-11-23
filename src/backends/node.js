import fs from "node:fs";
import path from "node:path";

/**
 * Node.js single-file StorageBackend for redb-wasm using node:fs.
 * Zero external dependencies.
 *
 * @param {string} filePath Path to the single .redb database file
 * @param {{ readOnly?: boolean, createDirs?: boolean, mode?: number }} [options]
 */
export function createNodeFileBackend(filePath, options = {}) {
  const readOnly = Boolean(options.readOnly);
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
      let total = 0;
      while (total < dst.byteLength) {
        const n = fs.readSync(
          fd,
          dst,
          total,
          dst.byteLength - total,
          offset + total
        );
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
      let total = 0;
      while (total < src.byteLength) {
        const n = fs.writeSync(
          fd,
          src,
          total,
          src.byteLength - total,
          offset + total
        );
        if (n === 0) {
          throw new Error("Short write (0 bytes written)");
        }
        total += n;
      }
    },

    /** @returns {number} */
    len() {
      ensureOpen();
      return fs.fstatSync(fd).size;
    },

    /** @param {number} newLen */
    setLen(newLen) {
      ensureOpen();
      if (readOnly) {
        throw new Error("Cannot resize a read-only Node file backend");
      }
      fs.ftruncateSync(fd, newLen);
    },

    sync() {
      ensureOpen();
      if (!readOnly) {
        fs.fsyncSync(fd);
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
