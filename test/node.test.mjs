import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Redb } from "../src/index.js";
import { openNode, openNodeSync } from "../src/node.js";
import { RedbFS } from "../src/vfs.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redb-wasm-test-"));
}

const dec = new TextDecoder();

test("Node.js single-file persistence, reopen, and read-only mode", async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "store.redb");

  try {
    const db = await openNode(dbPath, { cacheSize: 4 * 1024 * 1024 });
    db.set("kv", "hello", "world");
    db.set("kv", "bin", new Uint8Array([0, 1, 2, 255]));
    assert.equal(db.getText("kv", "hello"), "world");
    assert.deepEqual(db.get("kv", "bin"), new Uint8Array([0, 1, 2, 255]));
    assert.equal(db.checkIntegrity(), true);
    db.close();

    // Verify strictly a single file exists on disk (no WAL/SHM/lock sidecars)
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ["store.redb"]);

    // Reopen read-write
    const db2 = await openNode(dbPath);
    assert.equal(db2.getText("kv", "hello"), "world");
    assert.deepEqual(db2.get("kv", "bin"), new Uint8Array([0, 1, 2, 255]));
    assert.deepEqual(db2.listTables(), ["kv"]);
    db2.close();

    // Reopen read-only
    const ro = await openNode(dbPath, { readOnly: true });
    assert.equal(ro.getText("kv", "hello"), "world");
    assert.throws(() => ro.set("kv", "x", "y"));
    ro.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ACID transactions: atomicity, rollback on error, and MVCC snapshot isolation", async () => {
  const db = await Redb.openMemory();
  try {
    db.writeTransaction((tx) => {
      tx.set("accounts", "alice", "100");
      tx.set("accounts", "bob", "50");
    });

    // Rollback on thrown error leaves database untouched
    assert.throws(() => {
      db.writeTransaction((tx) => {
        tx.set("accounts", "alice", "0");
        tx.set("accounts", "bob", "150");
        throw new Error("simulated crash mid-tx");
      });
    }, /simulated crash mid-tx/);

    assert.equal(db.getText("accounts", "alice"), "100");
    assert.equal(db.getText("accounts", "bob"), "50");

    // MVCC snapshot isolation: reader sees consistent old state during & after concurrent write
    const rtx = db.beginRead();
    try {
      assert.equal(rtx.getText("accounts", "alice"), "100");
      db.set("accounts", "alice", "200");
      // Snapshot reader still sees 100!
      assert.equal(rtx.getText("accounts", "alice"), "100");
    } finally {
      rtx.close();
    }
    // New read sees 200
    assert.equal(db.getText("accounts", "alice"), "200");
  } finally {
    db.close();
  }
});

test("Range, prefix, reverse, and limited scans", async () => {
  const db = await Redb.openMemory();
  try {
    db.writeTransaction((tx) => {
      tx.set("docs", "a/1", "one");
      tx.set("docs", "a/2", "two");
      tx.set("docs", "a/3", "three");
      tx.set("docs", "b/1", "bee");
    });

    const aPrefix = db.scan("docs", { prefix: "a/" });
    assert.deepEqual(
      aPrefix.map((r) => [dec.decode(r.key), dec.decode(r.value)]),
      [
        ["a/1", "one"],
        ["a/2", "two"],
        ["a/3", "three"],
      ]
    );

    const revLimited = db.scan("docs", { prefix: "a/", reverse: true, limit: 2 });
    assert.deepEqual(
      revLimited.map((r) => dec.decode(r.key)),
      ["a/3", "a/2"]
    );

    const range = db.scan("docs", { start: "a/2", end: "b/1" });
    assert.deepEqual(
      range.map((r) => dec.decode(r.key)),
      ["a/2", "a/3"]
    );
  } finally {
    db.close();
  }
});

test("Persistent Copy-on-Write savepoints survive reopen", async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "cow.redb");

  try {
    const db = await openNode(dbPath);
    db.set("state", "version", "v1");
    const sp = db.createSavepoint();

    db.set("state", "version", "v2");
    db.set("state", "extra", "should-disappear");
    assert.equal(db.getText("state", "version"), "v2");
    db.close();

    // Reopen and restore savepoint from before close
    const db2 = await openNode(dbPath);
    assert.ok(db2.listSavepoints().includes(sp));
    db2.restoreSavepoint(sp);
    assert.equal(db2.getText("state", "version"), "v1");
    assert.equal(db2.get("state", "extra"), null);
    assert.equal(db2.deleteSavepoint(sp), true);
    db2.compact();
    assert.equal(db2.checkIntegrity(), true);
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Byte-for-byte portability between Memory/Browser format and Node.js file", async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "portable.redb");

  try {
    const mem = await Redb.openMemory();
    mem.set("portable", "origin", "wasm-memory");
    mem.close();
    const rawFileBytes = mem.backend.toUint8Array();

    fs.writeFileSync(dbPath, rawFileBytes);
    const nodeDb = await openNode(dbPath);
    assert.equal(nodeDb.getText("portable", "origin"), "wasm-memory");
    nodeDb.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RedbFS single-file virtual filesystem: files, O(1) appends, random-access slices, rename, CoW snapshots", async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "vfs.redb");

  try {
    const db = await openNode(dbPath);
    // Small chunkSize (1 KiB) to thoroughly exercise multi-chunk logic
    const vfs = new RedbFS(db, { chunkSize: 1024 });

    // Create files & directories
    vfs.writeFile("/logs/app.log", "line-0\n");
    for (let i = 1; i <= 300; i++) {
      vfs.appendFile("/logs/app.log", `line-${i}-payload-0123456789\n`, {
        durable: i === 300,
      });
    }

    const logText = vfs.readTextFile("/logs/app.log");
    assert.ok(logText.startsWith("line-0\nline-1-payload"));
    assert.ok(logText.endsWith("line-300-payload-0123456789\n"));
    assert.ok(vfs.stat("/logs/app.log").size > 7000);

    // Random-access readRange & writeRange across chunk boundaries
    const binary = new Uint8Array(3000);
    for (let i = 0; i < binary.length; i++) binary[i] = i & 0xff;
    vfs.writeFile("/data/blob.bin", binary);

    const patch = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
    vfs.writeRange("/data/blob.bin", 1021, patch); // straddles chunk 0 -> chunk 1 boundary (1024)
    assert.deepEqual(vfs.readRange("/data/blob.bin", 1021, 6), patch);
    assert.equal(vfs.readRange("/data/blob.bin", 1020, 1)[0], 1020 & 0xff);
    assert.equal(vfs.readRange("/data/blob.bin", 1027, 1)[0], 1027 & 0xff);

    // Truncate down and verify
    vfs.truncate("/data/blob.bin", 1500);
    assert.equal(vfs.stat("/data/blob.bin").size, 1500);
    assert.equal(vfs.readFile("/data/blob.bin").byteLength, 1500);

    // Directory listing
    const rootEntries = vfs.readdir("/").map((e) => e.name).sort();
    assert.deepEqual(rootEntries, ["data", "logs"]);

    // CoW whole-filesystem snapshot before destructive edits
    const snap = vfs.snapshot();

    // Atomic directory rename & delete
    vfs.rename("/data", "/archive");
    assert.equal(vfs.exists("/data/blob.bin"), false);
    assert.equal(vfs.exists("/archive/blob.bin"), true);
    vfs.rm("/logs", { recursive: true });
    assert.equal(vfs.exists("/logs/app.log"), false);

    // Restore CoW snapshot -> everything instantly comes back
    vfs.restoreSnapshot(snap);
    assert.equal(vfs.exists("/data/blob.bin"), true);
    assert.equal(vfs.exists("/archive/blob.bin"), false);
    assert.equal(vfs.readTextFile("/logs/app.log"), logText);

    vfs.deleteSnapshot(snap);
    vfs.compact();
    assert.equal(vfs.checkIntegrity(), true);
    vfs.close();

    // Still strictly ONE single file on disk!
    assert.deepEqual(fs.readdirSync(dir), ["vfs.redb"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Synchronous openNodeSync, openMemorySync, getInto, and scanEach", () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "sync.redb");

  try {
    const db = openNodeSync(dbPath, { cacheSize: 2 * 1024 * 1024 });
    db.writeTransaction((tx) => {
      tx.set("chunks", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), new Uint8Array([10, 20, 30]));
      tx.set("chunks", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1]), new Uint8Array([40, 50]));
      tx.set("chunks", new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0]), new Uint8Array([99]));
    });

    db.readTransaction((rtx) => {
      const target = new Uint8Array(8).fill(0xff);
      const len = rtx.getInto("chunks", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), target, 2);
      assert.equal(len, 3);
      assert.deepEqual([...target], [0xff, 0xff, 10, 20, 30, 0xff, 0xff, 0xff]);
      assert.equal(rtx.getInto("chunks", new Uint8Array([9, 9]), target, 0), -1);

      const seen = [];
      const count = rtx.scanEach(
        "chunks",
        {
          start: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]),
          end: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2]),
        },
        (k, v) => {
          seen.push({ page: k[7], data: [...v] });
        }
      );
      assert.equal(count, 2);
      assert.deepEqual(seen, [
        { page: 0, data: [10, 20, 30] },
        { page: 1, data: [40, 50] },
      ]);
    });
    db.close();

    const mem = Redb.openMemorySync(fs.readFileSync(dbPath));
    assert.deepEqual([...mem.get("chunks", new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0]))], [99]);
    mem.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Correctness guards: re-entrant write tx, scanEach re-entrancy, limit:0, getView, coalesced writes & read-ahead", async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, "guards.redb");

  try {
    const db = openNodeSync(dbPath, { cacheSize: 4 * 1024 * 1024 });

    // Re-entrant beginWrite / compact / checkIntegrity must throw cleanly without bricking WASM
    const tx1 = db.beginWrite();
    assert.throws(() => db.beginWrite(), /already active/i);
    assert.throws(() => db.compact(), /active/i);
    assert.throws(() => db.checkIntegrity(), /active/i);
    tx1.set("t", "k1", "v1");
    tx1.commit();

    // Runtime remains healthy after rejected re-entrant calls
    assert.equal(db.getText("t", "k1"), "v1");
    assert.equal(db.checkIntegrity(), true);

    // Durable write with sync: false writes to OS page cache (survives reopen) without fsync
    db.writeTransaction(
      (tx) => {
        for (let i = 0; i < 120; i++) {
          const payload = new Uint8Array(2048);
          payload.fill(i & 0xff);
          tx.set("bulk", `row-${String(i).padStart(4, "0")}`, payload);
        }
      },
      { durable: true, sync: false }
    );
    db.sync();

    // scanEach re-entrancy guard, getView, and limit: 0
    db.readTransaction((rtx) => {
      assert.deepEqual(rtx.scan("bulk", { limit: 0 }), []);
      assert.equal(
        rtx.scanEach("bulk", { limit: 0 }, () => {
          throw new Error("should not run");
        }),
        0
      );

      const view = rtx.getView("bulk", "row-0042");
      assert.equal(view.byteLength, 2048);
      assert.equal(view[0], 42);
      assert.equal(view[2047], 42);

      assert.throws(() => {
        rtx.scanEach("bulk", { limit: 2 }, () => {
          rtx.get("t", "k1");
        });
      }, /re-entrantly/i);
    });

    // Empty write past EOF must not corrupt cached backend.len()
    const beforeLen = db.backend.len();
    db.backend.write(beforeLen + 4096, new Uint8Array(0));
    assert.equal(db.backend.len(), beforeLen);

    db.close();

    // Cold reopen exercises sequential read-ahead across all 120 coalesced entries
    const db2 = openNodeSync(dbPath);
    for (let i = 0; i < 120; i++) {
      const val = db2.get("bulk", `row-${String(i).padStart(4, "0")}`);
      assert.equal(val.byteLength, 2048);
      assert.equal(val[0], i & 0xff);
      assert.equal(val[2047], i & 0xff);
    }
    assert.equal(db2.checkIntegrity(), true);
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
