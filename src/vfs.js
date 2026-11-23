import { toBytes } from "./index.js";

const META_TABLE = "vfs_meta";
const CHUNK_TABLE = "vfs_chunks";
const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Normalize a POSIX-like virtual path to canonical form (leading "/", no trailing "/").
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizePath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  if (rawPath.includes("\0")) {
    throw new Error("Path cannot contain null bytes");
  }
  const parts = rawPath.split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return "/" + stack.join("/");
}

function parentDir(p) {
  if (p === "/") return "/";
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

/**
 * Build key `[path_utf8][0x00][u32_be chunkIndex]`.
 * Big-endian chunkIndex ensures chunks sort in exact numeric order.
 */
function chunkKey(path, chunkIndex) {
  const pathBytes = encoder.encode(path);
  const key = new Uint8Array(pathBytes.length + 5);
  key.set(pathBytes, 0);
  key[pathBytes.length] = 0;
  new DataView(key.buffer).setUint32(pathBytes.length + 1, chunkIndex >>> 0, false);
  return key;
}

function chunkPrefix(path) {
  const pathBytes = encoder.encode(path);
  const prefix = new Uint8Array(pathBytes.length + 1);
  prefix.set(pathBytes, 0);
  prefix[pathBytes.length] = 0;
  return prefix;
}

function encodeMeta(meta) {
  return encoder.encode(JSON.stringify(meta));
}

function decodeMeta(bytes) {
  if (bytes === null) return null;
  return JSON.parse(decoder.decode(bytes));
}

function getMetaTx(tx, path) {
  if (path === "/") {
    return { type: "dir", size: 0, chunkSize: 0, ctime: 0, mtime: 0 };
  }
  return decodeMeta(tx.get(META_TABLE, path));
}

function ensureParentsTx(tx, path, now) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur += "/" + parts[i];
    const existing = getMetaTx(tx, cur);
    if (!existing) {
      tx.set(
        META_TABLE,
        cur,
        encodeMeta({ type: "dir", size: 0, chunkSize: 0, ctime: now, mtime: now })
      );
    } else if (existing.type !== "dir") {
      throw new Error(`ENOTDIR: '${cur}' is not a directory`);
    }
  }
}

function deleteChunksFromTx(tx, path, fromChunkIdx, totalOldChunks) {
  for (let i = fromChunkIdx; i < totalOldChunks; i++) {
    tx.delete(CHUNK_TABLE, chunkKey(path, i));
  }
}

/**
 * Single-file Virtual Filesystem backed by Redb.
 *
 * - Stores files as fixed-size chunks (default 64 KiB) so appends and partial
 *   updates only touch the affected chunk(s).
 * - Every mutation executes inside a single ACID redb transaction.
 * - Supports instant Copy-on-Write whole-filesystem snapshots via redb savepoints.
 */
export class RedbFS {
  /**
   * @param {import("./index.js").Redb} db
   * @param {{ chunkSize?: number }} [options]
   */
  constructor(db, options = {}) {
    this.db = db;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (this.chunkSize < 512) {
      throw new Error("chunkSize must be at least 512 bytes");
    }
  }

  /**
   * Return metadata for a path, or null if it does not exist.
   * @param {string} rawPath
   */
  stat(rawPath) {
    const p = normalizePath(rawPath);
    return this.db.readTransaction((tx) => getMetaTx(tx, p));
  }

  /** @param {string} rawPath */
  exists(rawPath) {
    return this.stat(rawPath) !== null;
  }

  /**
   * Create a directory.
   * @param {string} rawPath
   * @param {{ recursive?: boolean }} [options]
   */
  mkdir(rawPath, options = {}) {
    const p = normalizePath(rawPath);
    if (p === "/") return;
    const recursive = Boolean(options.recursive);
    const now = Date.now();

    this.db.writeTransaction((tx) => {
      const existing = getMetaTx(tx, p);
      if (existing) {
        if (recursive && existing.type === "dir") return;
        throw new Error(`EEXIST: '${p}' already exists`);
      }
      if (recursive) {
        ensureParentsTx(tx, p, now);
      } else {
        const parent = getMetaTx(tx, parentDir(p));
        if (!parent) throw new Error(`ENOENT: parent directory does not exist for '${p}'`);
        if (parent.type !== "dir") throw new Error(`ENOTDIR: parent of '${p}' is not a directory`);
      }
      tx.set(
        META_TABLE,
        p,
        encodeMeta({ type: "dir", size: 0, chunkSize: 0, ctime: now, mtime: now })
      );
    });
  }

  /**
   * List direct entries inside a directory.
   * @param {string} rawPath
   */
  readdir(rawPath = "/") {
    const dir = normalizePath(rawPath);
    return this.db.readTransaction((tx) => {
      const meta = getMetaTx(tx, dir);
      if (!meta) throw new Error(`ENOENT: no such directory '${dir}'`);
      if (meta.type !== "dir") throw new Error(`ENOTDIR: '${dir}' is not a directory`);

      const prefix = dir === "/" ? "/" : dir + "/";
      const rows = tx.scan(META_TABLE, { prefix });
      const entries = [];
      for (const row of rows) {
        const childPath = decoder.decode(row.key);
        const rel = childPath.slice(prefix.length);
        if (rel.length === 0 || rel.includes("/")) continue;
        const m = decodeMeta(row.value);
        entries.push({
          name: rel,
          path: childPath,
          type: m.type,
          size: m.size,
          ctime: m.ctime,
          mtime: m.mtime,
        });
      }
      return entries;
    });
  }

  /**
   * Create or overwrite a file atomically.
   * @param {string} rawPath
   * @param {string | Uint8Array} data
   * @param {{ createParents?: boolean, durable?: boolean }} [options]
   */
  writeFile(rawPath, data, options = {}) {
    const p = normalizePath(rawPath);
    if (p === "/") throw new Error("EISDIR: cannot write to root directory '/'");
    const bytes = toBytes(data);
    const createParents = options.createParents !== false;
    const now = Date.now();

    this.db.writeTransaction(
      (tx) => {
        const existing = getMetaTx(tx, p);
        if (existing && existing.type === "dir") {
          throw new Error(`EISDIR: '${p}' is a directory`);
        }
        if (createParents) {
          ensureParentsTx(tx, p, now);
        } else {
          const parent = getMetaTx(tx, parentDir(p));
          if (!parent || parent.type !== "dir") {
            throw new Error(`ENOENT: parent directory does not exist for '${p}'`);
          }
        }

        const chunkSize = existing ? existing.chunkSize || this.chunkSize : this.chunkSize;
        const oldChunkCount = existing ? Math.ceil(existing.size / chunkSize) : 0;
        const newChunkCount = Math.ceil(bytes.byteLength / chunkSize);

        for (let i = 0; i < newChunkCount; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, bytes.byteLength);
          tx.set(CHUNK_TABLE, chunkKey(p, i), bytes.subarray(start, end));
        }
        if (oldChunkCount > newChunkCount) {
          deleteChunksFromTx(tx, p, newChunkCount, oldChunkCount);
        }

        tx.set(
          META_TABLE,
          p,
          encodeMeta({
            type: "file",
            size: bytes.byteLength,
            chunkSize,
            ctime: existing ? existing.ctime : now,
            mtime: now,
          })
        );
      },
      { durable: options.durable }
    );
  }

  /**
   * Append data to a file in O(appended_size) time (only touches the tail chunk(s)).
   * Creates the file if it does not exist.
   * @param {string} rawPath
   * @param {string | Uint8Array} data
   * @param {{ createParents?: boolean, durable?: boolean }} [options]
   */
  appendFile(rawPath, data, options = {}) {
    const p = normalizePath(rawPath);
    if (p === "/") throw new Error("EISDIR: cannot append to root directory '/'");
    const bytes = toBytes(data);
    const createParents = options.createParents !== false;
    const now = Date.now();

    this.db.writeTransaction(
      (tx) => {
        let meta = getMetaTx(tx, p);
        if (meta && meta.type === "dir") {
          throw new Error(`EISDIR: '${p}' is a directory`);
        }
        if (!meta) {
          if (createParents) {
            ensureParentsTx(tx, p, now);
          } else {
            const parent = getMetaTx(tx, parentDir(p));
            if (!parent || parent.type !== "dir") {
              throw new Error(`ENOENT: parent directory does not exist for '${p}'`);
            }
          }
          meta = {
            type: "file",
            size: 0,
            chunkSize: this.chunkSize,
            ctime: now,
            mtime: now,
          };
        }

        if (bytes.byteLength > 0) {
          const chunkSize = meta.chunkSize || this.chunkSize;
          let pos = meta.size;
          let srcOff = 0;

          while (srcOff < bytes.byteLength) {
            const chunkIdx = Math.floor(pos / chunkSize);
            const inChunkOff = pos % chunkSize;
            const toWrite = Math.min(chunkSize - inChunkOff, bytes.byteLength - srcOff);

            if (inChunkOff === 0 && toWrite === chunkSize) {
              tx.set(CHUNK_TABLE, chunkKey(p, chunkIdx), bytes.subarray(srcOff, srcOff + toWrite));
            } else {
              const existingChunk = tx.get(CHUNK_TABLE, chunkKey(p, chunkIdx));
              const nextLen = Math.max(existingChunk ? existingChunk.byteLength : 0, inChunkOff + toWrite);
              const merged = new Uint8Array(nextLen);
              if (existingChunk) merged.set(existingChunk, 0);
              merged.set(bytes.subarray(srcOff, srcOff + toWrite), inChunkOff);
              tx.set(CHUNK_TABLE, chunkKey(p, chunkIdx), merged);
            }

            pos += toWrite;
            srcOff += toWrite;
          }
          meta.size = pos;
        }

        meta.mtime = now;
        tx.set(META_TABLE, p, encodeMeta(meta));
      },
      { durable: options.durable }
    );
  }

  /**
   * Read an entire file into a Uint8Array.
   * @param {string} rawPath
   * @returns {Uint8Array}
   */
  readFile(rawPath) {
    const p = normalizePath(rawPath);
    return this.db.readTransaction((tx) => {
      const meta = getMetaTx(tx, p);
      if (!meta) throw new Error(`ENOENT: no such file '${p}'`);
      if (meta.type !== "file") throw new Error(`EISDIR: '${p}' is a directory`);
      if (meta.size === 0) return new Uint8Array(0);

      const chunkSize = meta.chunkSize || this.chunkSize;
      const out = new Uint8Array(meta.size);
      const rows = tx.scan(CHUNK_TABLE, { prefix: chunkPrefix(p) });
      const prefixLen = encoder.encode(p).length + 1;

      for (const row of rows) {
        const idx = new DataView(
          row.key.buffer,
          row.key.byteOffset + prefixLen,
          4
        ).getUint32(0, false);
        const start = idx * chunkSize;
        if (start >= meta.size) continue;
        const sliceLen = Math.min(row.value.byteLength, meta.size - start);
        out.set(row.value.subarray(0, sliceLen), start);
      }
      return out;
    });
  }

  /**
   * Read an entire file decoded as UTF-8 text.
   * @param {string} rawPath
   * @returns {string}
   */
  readTextFile(rawPath) {
    return decoder.decode(this.readFile(rawPath));
  }

  /**
   * Random-access slice read: only loads chunks overlapping [offset, offset + length).
   * @param {string} rawPath
   * @param {number} offset
   * @param {number} length
   * @returns {Uint8Array}
   */
  readRange(rawPath, offset, length) {
    const p = normalizePath(rawPath);
    if (offset < 0 || length < 0) {
      throw new RangeError("offset and length must be non-negative");
    }
    return this.db.readTransaction((tx) => {
      const meta = getMetaTx(tx, p);
      if (!meta) throw new Error(`ENOENT: no such file '${p}'`);
      if (meta.type !== "file") throw new Error(`EISDIR: '${p}' is a directory`);
      if (offset >= meta.size || length === 0) return new Uint8Array(0);

      const actualLen = Math.min(length, meta.size - offset);
      const out = new Uint8Array(actualLen);
      const chunkSize = meta.chunkSize || this.chunkSize;
      let dstOff = 0;
      let pos = offset;

      while (dstOff < actualLen) {
        const idx = Math.floor(pos / chunkSize);
        const inChunk = pos % chunkSize;
        const take = Math.min(chunkSize - inChunk, actualLen - dstOff);
        const chunk = tx.get(CHUNK_TABLE, chunkKey(p, idx));
        if (chunk && inChunk < chunk.byteLength) {
          const avail = Math.min(take, chunk.byteLength - inChunk);
          out.set(chunk.subarray(inChunk, inChunk + avail), dstOff);
        }
        pos += take;
        dstOff += take;
      }
      return out;
    });
  }

  /**
   * Random-access patch/update at `offset`. Only rewrites affected chunk(s).
   * Extends the file (zero-filling any gap) if writing past EOF.
   * @param {string} rawPath
   * @param {number} offset
   * @param {string | Uint8Array} data
   * @param {{ durable?: boolean }} [options]
   */
  writeRange(rawPath, offset, data, options = {}) {
    const p = normalizePath(rawPath);
    if (offset < 0) throw new RangeError("offset must be non-negative");
    const bytes = toBytes(data);
    const now = Date.now();

    this.db.writeTransaction(
      (tx) => {
        const meta = getMetaTx(tx, p);
        if (!meta) throw new Error(`ENOENT: no such file '${p}'`);
        if (meta.type !== "file") throw new Error(`EISDIR: '${p}' is a directory`);

        const chunkSize = meta.chunkSize || this.chunkSize;
        let srcOff = 0;
        let pos = offset;

        while (srcOff < bytes.byteLength) {
          const idx = Math.floor(pos / chunkSize);
          const inChunk = pos % chunkSize;
          const toWrite = Math.min(chunkSize - inChunk, bytes.byteLength - srcOff);

          if (inChunk === 0 && toWrite === chunkSize) {
            tx.set(CHUNK_TABLE, chunkKey(p, idx), bytes.subarray(srcOff, srcOff + toWrite));
          } else {
            const existing = tx.get(CHUNK_TABLE, chunkKey(p, idx));
            const nextLen = Math.max(existing ? existing.byteLength : 0, inChunk + toWrite);
            const merged = new Uint8Array(nextLen);
            if (existing) merged.set(existing, 0);
            merged.set(bytes.subarray(srcOff, srcOff + toWrite), inChunk);
            tx.set(CHUNK_TABLE, chunkKey(p, idx), merged);
          }

          pos += toWrite;
          srcOff += toWrite;
        }

        if (pos > meta.size) meta.size = pos;
        meta.mtime = now;
        tx.set(META_TABLE, p, encodeMeta(meta));
      },
      { durable: options.durable }
    );
  }

  /**
   * Resize a file (truncating trailing data or extending with zeros).
   * @param {string} rawPath
   * @param {number} newSize
   */
  truncate(rawPath, newSize) {
    const p = normalizePath(rawPath);
    if (newSize < 0) throw new RangeError("newSize must be non-negative");
    const now = Date.now();

    this.db.writeTransaction((tx) => {
      const meta = getMetaTx(tx, p);
      if (!meta) throw new Error(`ENOENT: no such file '${p}'`);
      if (meta.type !== "file") throw new Error(`EISDIR: '${p}' is a directory`);

      const chunkSize = meta.chunkSize || this.chunkSize;
      if (newSize < meta.size) {
        const oldChunks = Math.ceil(meta.size / chunkSize);
        const newChunks = Math.ceil(newSize / chunkSize);
        const tailLen = newSize % chunkSize;
        if (tailLen > 0) {
          const lastIdx = newChunks - 1;
          const existing = tx.get(CHUNK_TABLE, chunkKey(p, lastIdx));
          if (existing && existing.byteLength > tailLen) {
            tx.set(CHUNK_TABLE, chunkKey(p, lastIdx), existing.subarray(0, tailLen));
          }
        }
        deleteChunksFromTx(tx, p, newChunks, oldChunks);
      }

      meta.size = newSize;
      meta.mtime = now;
      tx.set(META_TABLE, p, encodeMeta(meta));
    });
  }

  /**
   * Delete a single file.
   * @param {string} rawPath
   */
  unlink(rawPath) {
    const p = normalizePath(rawPath);
    this.db.writeTransaction((tx) => {
      const meta = getMetaTx(tx, p);
      if (!meta) throw new Error(`ENOENT: no such file '${p}'`);
      if (meta.type !== "file") throw new Error(`EISDIR: '${p}' is a directory`);
      const chunkCount = Math.ceil(meta.size / (meta.chunkSize || this.chunkSize));
      deleteChunksFromTx(tx, p, 0, chunkCount);
      tx.delete(META_TABLE, p);
    });
  }

  /**
   * Delete a file or directory (pass `{ recursive: true }` for non-empty directories).
   * @param {string} rawPath
   * @param {{ recursive?: boolean, force?: boolean }} [options]
   */
  rm(rawPath, options = {}) {
    const p = normalizePath(rawPath);
    if (p === "/") throw new Error("EPERM: cannot remove root directory '/'");
    const recursive = Boolean(options.recursive);
    const force = Boolean(options.force);

    this.db.writeTransaction((tx) => {
      const meta = getMetaTx(tx, p);
      if (!meta) {
        if (force) return;
        throw new Error(`ENOENT: no such path '${p}'`);
      }

      if (meta.type === "file") {
        const chunkCount = Math.ceil(meta.size / (meta.chunkSize || this.chunkSize));
        deleteChunksFromTx(tx, p, 0, chunkCount);
        tx.delete(META_TABLE, p);
        return;
      }

      const children = tx.scan(META_TABLE, { prefix: p + "/" });
      if (children.length > 0 && !recursive) {
        throw new Error(`ENOTEMPTY: directory '${p}' is not empty`);
      }

      for (const row of children) {
        const childPath = decoder.decode(row.key);
        const childMeta = decodeMeta(row.value);
        if (childMeta.type === "file") {
          const chunks = tx.scan(CHUNK_TABLE, { prefix: chunkPrefix(childPath) });
          for (const c of chunks) tx.delete(CHUNK_TABLE, c.key);
        }
        tx.delete(META_TABLE, childPath);
      }
      tx.delete(META_TABLE, p);
    });
  }

  /**
   * Atomically rename/move a file or directory within a single ACID transaction.
   * @param {string} oldRawPath
   * @param {string} newRawPath
   */
  rename(oldRawPath, newRawPath) {
    const src = normalizePath(oldRawPath);
    const dst = normalizePath(newRawPath);
    if (src === "/" || dst === "/") throw new Error("EINVAL: cannot rename root directory");
    if (src === dst) return;
    if (dst.startsWith(src + "/")) {
      throw new Error("EINVAL: cannot move a directory into itself");
    }
    const now = Date.now();

    this.db.writeTransaction((tx) => {
      const srcMeta = getMetaTx(tx, src);
      if (!srcMeta) throw new Error(`ENOENT: no such path '${src}'`);
      ensureParentsTx(tx, dst, now);

      const moveFile = (fromPath, toPath, meta) => {
        const oldDst = getMetaTx(tx, toPath);
        if (oldDst) {
          if (oldDst.type === "dir") throw new Error(`EISDIR: destination '${toPath}' is a directory`);
          const oldDstChunks = tx.scan(CHUNK_TABLE, { prefix: chunkPrefix(toPath) });
          for (const c of oldDstChunks) tx.delete(CHUNK_TABLE, c.key);
        }
        const prefixLen = encoder.encode(fromPath).length + 1;
        const chunks = tx.scan(CHUNK_TABLE, { prefix: chunkPrefix(fromPath) });
        for (const c of chunks) {
          const idx = new DataView(c.key.buffer, c.key.byteOffset + prefixLen, 4).getUint32(0, false);
          tx.set(CHUNK_TABLE, chunkKey(toPath, idx), c.value);
          tx.delete(CHUNK_TABLE, c.key);
        }
        tx.set(META_TABLE, toPath, encodeMeta({ ...meta, mtime: now }));
        tx.delete(META_TABLE, fromPath);
      };

      if (srcMeta.type === "file") {
        moveFile(src, dst, srcMeta);
        return;
      }

      const dstMeta = getMetaTx(tx, dst);
      if (dstMeta) {
        throw new Error(`EEXIST: destination '${dst}' already exists`);
      }

      const children = tx.scan(META_TABLE, { prefix: src + "/" });
      tx.set(META_TABLE, dst, encodeMeta({ ...srcMeta, mtime: now }));
      for (const row of children) {
        const childSrc = decoder.decode(row.key);
        const childDst = dst + childSrc.slice(src.length);
        const childMeta = decodeMeta(row.value);
        if (childMeta.type === "file") {
          moveFile(childSrc, childDst, childMeta);
        } else {
          tx.set(META_TABLE, childDst, row.value);
          tx.delete(META_TABLE, childSrc);
        }
      }
      tx.delete(META_TABLE, src);
    });
  }

  /**
   * Create an instant Copy-on-Write snapshot of the entire virtual filesystem.
   * @returns {number} Snapshot ID
   */
  snapshot() {
    return this.db.createSavepoint();
  }

  /**
   * Atomically restore the entire virtual filesystem to a previous snapshot.
   * @param {number} snapshotId
   */
  restoreSnapshot(snapshotId) {
    this.db.restoreSavepoint(snapshotId);
  }

  /** @param {number} snapshotId */
  deleteSnapshot(snapshotId) {
    return this.db.deleteSavepoint(snapshotId);
  }

  listSnapshots() {
    return this.db.listSavepoints();
  }

  compact() {
    return this.db.compact();
  }

  checkIntegrity() {
    return this.db.checkIntegrity();
  }

  close() {
    this.db.close();
  }
}
