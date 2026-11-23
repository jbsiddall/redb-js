import fs from "node:fs";
import { Redb, setDefaultWasmModule } from "./index.js";
import { createNodeFileBackend } from "./backends/node.js";

let nodeWasmLoaded = false;

/**
 * Synchronously load and compile the bundled redb WASM module in Node.js, Bun, or Deno.
 */
export function ensureNodeWasmLoadedSync() {
  if (nodeWasmLoaded) return;
  const wasmUrl = new URL("../dist/redb_wasm.wasm", import.meta.url);
  const bytes = fs.readFileSync(wasmUrl);
  setDefaultWasmModule(new WebAssembly.Module(bytes));
  nodeWasmLoaded = true;
}

/**
 * Open (or create) a single-file redb database on disk in Node.js, Bun, or Deno.
 *
 * @param {string} filePath Path to the single .redb file
 * @param {{ cacheSize?: number, readOnly?: boolean, createDirs?: boolean, mode?: number, sync?: boolean, wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module | URL | string }} [options]
 * @returns {Promise<Redb>}
 */
export async function openNode(filePath, options = {}) {
  const backend = createNodeFileBackend(filePath, {
    readOnly: options.readOnly,
    createDirs: options.createDirs,
    mode: options.mode,
    sync: options.sync,
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

/**
 * Synchronously open (or create) a single-file redb database on disk in Node.js, Bun, or Deno.
 *
 * @param {string} filePath Path to the single .redb file
 * @param {{ cacheSize?: number, readOnly?: boolean, createDirs?: boolean, mode?: number, sync?: boolean, wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module }} [options]
 * @returns {Redb}
 */
export function openNodeSync(filePath, options = {}) {
  if (!options.wasm) {
    ensureNodeWasmLoadedSync();
  }
  const backend = createNodeFileBackend(filePath, {
    readOnly: options.readOnly,
    createDirs: options.createDirs,
    mode: options.mode,
    sync: options.sync,
  });
  try {
    return Redb.openSync(backend, options);
  } catch (err) {
    try {
      backend.close();
    } catch {}
    throw err;
  }
}

export { Redb, createNodeFileBackend };
export {
  ReadTransaction,
  WriteTransaction,
  toBytes,
  prefixUpperBound,
  compileWasmSync,
  setDefaultWasmModule,
} from "./index.js";
