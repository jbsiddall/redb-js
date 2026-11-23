/**
 * Dedicated Web Worker hosting a single-file Redb + RedbFS database on Browser OPFS.
 *
 * Because OPFS FileSystemSyncAccessHandle is only available inside Dedicated Workers,
 * run this worker and talk to it from the main thread via `src/worker/opfs-client.js`.
 */
import { Redb } from "../index.js";
import { RedbFS } from "../vfs.js";

/** @type {Redb | null} */
let db = null;
/** @type {RedbFS | null} */
let fs = null;

function requireOpen() {
  if (!db || !fs) {
    throw new Error("Database is not open. Call open() first.");
  }
}

self.onmessage = async (event) => {
  const { id, method, args = [] } = event.data;
  try {
    let result;
    const transfer = [];

    switch (method) {
      case "open": {
        const [path, options = {}] = args;
        if (db) {
          db.close();
          db = null;
          fs = null;
        }
        db = await Redb.openOpfs(path, options);
        fs = new RedbFS(db, { chunkSize: options.chunkSize });
        result = true;
        break;
      }

      case "close": {
        if (db) {
          db.close();
          db = null;
          fs = null;
        }
        result = true;
        break;
      }

      // --- Raw KV methods ---
      case "kv.get":
        requireOpen();
        result = db.get(args[0], args[1]);
        if (result instanceof Uint8Array) transfer.push(result.buffer);
        break;
      case "kv.getText":
        requireOpen();
        result = db.getText(args[0], args[1]);
        break;
      case "kv.set":
        requireOpen();
        db.set(args[0], args[1], args[2], args[3]);
        result = true;
        break;
      case "kv.delete":
        requireOpen();
        result = db.delete(args[0], args[1], args[2]);
        break;
      case "kv.scan":
        requireOpen();
        result = db.scan(args[0], args[1]);
        break;
      case "kv.listTables":
        requireOpen();
        result = db.listTables();
        break;
      case "kv.batch": {
        requireOpen();
        const [ops, txOptions] = args;
        db.writeTransaction((tx) => {
          for (const op of ops) {
            if (op.op === "set") tx.set(op.table, op.key, op.value);
            else if (op.op === "delete") tx.delete(op.table, op.key);
            else if (op.op === "deleteTable") tx.deleteTable(op.table);
            else throw new Error(`Unknown batch op: ${op.op}`);
          }
        }, txOptions);
        result = true;
        break;
      }

      // --- Virtual Filesystem methods ---
      case "fs.writeFile":
        requireOpen();
        fs.writeFile(args[0], args[1], args[2]);
        result = true;
        break;
      case "fs.appendFile":
        requireOpen();
        fs.appendFile(args[0], args[1], args[2]);
        result = true;
        break;
      case "fs.readFile":
        requireOpen();
        result = fs.readFile(args[0]);
        if (result instanceof Uint8Array) transfer.push(result.buffer);
        break;
      case "fs.readTextFile":
        requireOpen();
        result = fs.readTextFile(args[0]);
        break;
      case "fs.readRange":
        requireOpen();
        result = fs.readRange(args[0], args[1], args[2]);
        if (result instanceof Uint8Array) transfer.push(result.buffer);
        break;
      case "fs.writeRange":
        requireOpen();
        fs.writeRange(args[0], args[1], args[2], args[3]);
        result = true;
        break;
      case "fs.truncate":
        requireOpen();
        fs.truncate(args[0], args[1]);
        result = true;
        break;
      case "fs.stat":
        requireOpen();
        result = fs.stat(args[0]);
        break;
      case "fs.exists":
        requireOpen();
        result = fs.exists(args[0]);
        break;
      case "fs.mkdir":
        requireOpen();
        fs.mkdir(args[0], args[1]);
        result = true;
        break;
      case "fs.readdir":
        requireOpen();
        result = fs.readdir(args[0]);
        break;
      case "fs.unlink":
        requireOpen();
        fs.unlink(args[0]);
        result = true;
        break;
      case "fs.rm":
        requireOpen();
        fs.rm(args[0], args[1]);
        result = true;
        break;
      case "fs.rename":
        requireOpen();
        fs.rename(args[0], args[1]);
        result = true;
        break;

      // --- Snapshots & maintenance ---
      case "snapshot":
        requireOpen();
        result = db.createSavepoint();
        break;
      case "restoreSnapshot":
        requireOpen();
        db.restoreSavepoint(args[0]);
        result = true;
        break;
      case "deleteSnapshot":
        requireOpen();
        result = db.deleteSavepoint(args[0]);
        break;
      case "listSnapshots":
        requireOpen();
        result = db.listSavepoints();
        break;
      case "compact":
        requireOpen();
        result = db.compact();
        break;
      case "checkIntegrity":
        requireOpen();
        result = db.checkIntegrity();
        break;
      case "fileSize":
        requireOpen();
        result = db.backend.len();
        break;

      default:
        throw new Error(`Unknown worker method: ${method}`);
    }

    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
