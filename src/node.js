import { Redb } from "./index.js";
import { createNodeFileBackend } from "./backends/node.js";

/**
 * Open (or create) a single-file redb database on disk in Node.js.
 *
 * @param {string} filePath Path to the single .redb file
 * @param {{ cacheSize?: number, readOnly?: boolean, createDirs?: boolean, mode?: number, wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module | URL | string }} [options]
 * @returns {Promise<Redb>}
 */
export async function openNode(filePath, options = {}) {
  const backend = createNodeFileBackend(filePath, {
    readOnly: options.readOnly,
    createDirs: options.createDirs,
    mode: options.mode,
  });
  try {
    return await Redb.open(backend, options);
  } catch (err) {
    try {
      backend.close();
    } catch {}
    throw err;
  }
}

export { Redb, createNodeFileBackend };
export { ReadTransaction, WriteTransaction, toBytes, prefixUpperBound } from "./index.js";
