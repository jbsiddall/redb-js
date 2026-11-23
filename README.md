# redb-js

A super-thin WebAssembly wrapper around [`redb`](https://github.com/cberner/redb) (pure-Rust, Copy-on-Write, ACID B-tree store) for **Browser OPFS** (`FileSystemSyncAccessHandle`), **Node.js**, **Bun**, and **Deno**, plus an optional chunked **single-file Virtual Filesystem (`RedbFS`)**.

## Supply-Chain & Footprint
- **npm runtime dependencies:** `0` (`dependencies: {}`)
- **Rust WASM dependencies:** `1` (`redb` with `default-features = false`, **0 transitive crates**)
- **No `wasm-bindgen`, no proc-macros, no native C/N-API build matrix** — compiles cleanly with plain `cargo build --target wasm32-unknown-unknown --release`.
- **Same single-file binary format** across Browser OPFS, Node.js, Bun, Deno, and in-memory buffers.

## Features
- **Single file on disk / OPFS** (no WAL/SHM/lock sidecar files)
- **Full ACID transactions** (`writeTransaction` auto-commits or rolls back on error)
- **Sync & async open APIs** (`openNode`, `openNodeSync`, `Redb.open`, `Redb.openSync`, `Redb.openOpfs`, `Redb.openMemory`, `Redb.openMemorySync`)
- **MVCC Snapshot Isolation** (`readTransaction` / `beginRead`) + zero-allocation read helpers (`getInto`, `getView`, `scanEach`)
- **Built-in configurable RAM page cache** (`cacheSize`, default 16 MiB) + sorted write coalescing and sequential read-ahead
- **Flexible commit durability** (`{ durable: true, sync: true }` full fsync/flush, `{ durable: true, sync: false }` OS/OPFS-flushed process-crash-safe commits + explicit `db.sync()`, or `{ durable: false }` `Durability::None`)
- **Copy-on-Write persistent snapshots & rollbacks** (`createSavepoint` / `restoreSavepoint`)
- **Range & prefix scans** (forward, reverse, limit)
- **Chunked Virtual Filesystem (`RedbFS`)**: `writeFile`, O(1) `appendFile`, `readFile`, random-access `readRange` / `writeRange`, `truncate`, `mkdir`, `readdir`, atomic `rename`, `rm`, and whole-FS CoW `snapshot()` / `restoreSnapshot()`.

---

## Quick Start

### Node.js, Bun, and Deno (Single File on Disk)

```js
import { openNode } from "redb-js/node";
import { RedbFS } from "redb-js/vfs";

const db = await openNode("./vault.redb", { cacheSize: 16 * 1024 * 1024 });

// 1. Raw ACID KV store
db.writeTransaction((tx) => {
  tx.set("meta", "version", "1");
  tx.set("meta", "user", "alice");
});
console.log(db.getText("meta", "user")); // "alice"

// 2. Single-file Virtual Filesystem on the same DB
const vfs = new RedbFS(db);
vfs.writeFile("/logs/app.log", "boot\n");
vfs.appendFile("/logs/app.log", "ready\n"); // O(1) tail-chunk append

const snap = vfs.snapshot();
vfs.unlink("/logs/app.log");
vfs.restoreSnapshot(snap); // instant CoW rollback

vfs.close();
```

### Browser OPFS (Main Thread via Built-in Dedicated Worker)

OPFS `FileSystemSyncAccessHandle` only runs inside a Dedicated Web Worker. Use `OpfsRedbClient` from the main thread:

```js
import { OpfsRedbClient } from "redb-js/opfs-client";

const client = await OpfsRedbClient.open("vault.redb", {
  cacheSize: 16 * 1024 * 1024,
});

await client.writeFile("/notes/hello.txt", "Saved in a single OPFS file!");
await client.appendFile("/notes/hello.txt", "\nSurvives page reloads.");
console.log(await client.readTextFile("/notes/hello.txt"));

await client.close();
```

### Browser OPFS (Direct Inside Your Own Dedicated Web Worker)

```js
import { Redb } from "redb-js";
import { RedbFS } from "redb-js/vfs";

const db = await Redb.openOpfs("vault.redb");
const vfs = new RedbFS(db);
vfs.writeFile("/hello.txt", "Direct synchronous OPFS access!");
vfs.close();
```

---

## Build & Verify From Source

```bash
rustup target add wasm32-unknown-unknown
npm run build:wasm   # builds dist/redb_wasm.wasm
npm test             # Node.js KV, ACID, MVCC, savepoint, & RedbFS tests
npm run test:browser # Headless Chrome OPFS persistence test across browser restarts
```
