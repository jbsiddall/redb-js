/**
 * In-memory single-buffer StorageBackend for testing, ephemeral databases,
 * or exporting/importing a database as a single Uint8Array.
 *
 * @param {Uint8Array} [initialBytes]
 */
export function createMemoryBackend(initialBytes) {
  let size = initialBytes ? initialBytes.byteLength : 0;
  let buf = new Uint8Array(Math.max(size, 64 * 1024));
  if (initialBytes && size > 0) {
    buf.set(initialBytes, 0);
  }
  let closed = false;

  const ensureOpen = () => {
    if (closed) {
      throw new Error("Memory backend is closed");
    }
  };

  const ensureCapacity = (needed) => {
    if (needed <= buf.byteLength) return;
    let nextCap = Math.max(buf.byteLength, 64 * 1024);
    while (nextCap < needed) {
      nextCap *= 2;
    }
    const next = new Uint8Array(nextCap);
    next.set(buf.subarray(0, size), 0);
    buf = next;
  };

  return {
    /**
     * @param {number} offset
     * @param {Uint8Array} dst
     * @returns {number}
     */
    read(offset, dst) {
      ensureOpen();
      if (offset >= size) return 0;
      const available = Math.min(dst.byteLength, size - offset);
      dst.set(buf.subarray(offset, offset + available), 0);
      return available;
    },

    /**
     * @param {number} offset
     * @param {Uint8Array} src
     */
    write(offset, src) {
      ensureOpen();
      const end = offset + src.byteLength;
      ensureCapacity(end);
      if (offset > size) {
        buf.fill(0, size, offset);
      }
      buf.set(src, offset);
      if (end > size) {
        size = end;
      }
    },

    /** @returns {number} */
    len() {
      ensureOpen();
      return size;
    },

    /** @param {number} newLen */
    setLen(newLen) {
      ensureOpen();
      ensureCapacity(newLen);
      if (newLen > size) {
        buf.fill(0, size, newLen);
      }
      size = newLen;
    },

    sync() {
      ensureOpen();
    },

    close() {
      closed = true;
    },

    /**
     * Return a copy of the single-file database bytes.
     * Works even after close() so you can export the closed image.
     * @returns {Uint8Array}
     */
    toUint8Array() {
      return buf.slice(0, size);
    },
  };
}
