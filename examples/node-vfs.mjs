import { openNode } from "../src/node.js";
import { RedbFS } from "../src/vfs.js";

const db = await openNode("./demo.redb", {
  cacheSize: 16 * 1024 * 1024, // 16 MiB in-memory redb page cache
});
const vfs = new RedbFS(db);

// Create & append files inside a single .redb file
vfs.writeFile("/notes/todo.txt", "1. Try redb-js\n");
vfs.appendFile("/notes/todo.txt", "2. Ship single-file VFS\n");

// Instant Copy-on-Write snapshot
const snap = vfs.snapshot();
vfs.writeFile("/notes/todo.txt", "oops, accidentally overwrote!");
vfs.restoreSnapshot(snap);
vfs.deleteSnapshot(snap);

console.log(vfs.readTextFile("/notes/todo.txt"));
console.log("Directory listing:", vfs.readdir("/notes"));

vfs.close();
