import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const phase1Html = `<!doctype html>
<meta charset="utf-8" />
<script type="module">
import { OpfsRedbClient } from "/src/worker/opfs-client.js";

async function run() {
  const client = await OpfsRedbClient.open("vault.redb", {
    chunkSize: 1024,
    cacheSize: 4 * 1024 * 1024,
  });

  await client.set("meta", "owner", "browser-opfs");
  await client.writeFile("/notes/hello.txt", "Hello from Browser OPFS!");
  for (let i = 0; i < 60; i++) {
    await client.appendFile("/logs/events.log", \`event-\${i}: 0123456789abcdef\\n\`, {
      durable: i === 59,
    });
  }

  // Test CoW snapshot + restore
  const snap = await client.snapshot();
  await client.writeFile("/notes/hello.txt", "CORRUPTED");
  await client.unlink("/logs/events.log");
  await client.restoreSnapshot(snap);
  await client.deleteSnapshot(snap);

  const restoredText = await client.readTextFile("/notes/hello.txt");
  const fileSize = await client.fileSize();
  const integrity = await client.checkIntegrity();
  await client.close();

  // Verify OPFS contains strictly ONE single file: vault.redb
  const root = await navigator.storage.getDirectory();
  const opfsEntries = [];
  for await (const [name, handle] of root.entries()) {
    opfsEntries.push({ name, kind: handle.kind });
  }

  return { restoredText, fileSize, integrity, opfsEntries };
}

run()
  .then((data) => fetch("/__report", { method: "POST", body: JSON.stringify({ ok: true, data }) }))
  .catch((err) => fetch("/__report", { method: "POST", body: JSON.stringify({ ok: false, error: err.stack || String(err) }) }));
</script>`;

const phase2Html = `<!doctype html>
<meta charset="utf-8" />
<script type="module">
import { OpfsRedbClient } from "/src/worker/opfs-client.js";

async function run() {
  const client = await OpfsRedbClient.open("vault.redb", { chunkSize: 1024 });

  const owner = await client.getText("meta", "owner");
  const hello = await client.readTextFile("/notes/hello.txt");
  const log = await client.readTextFile("/logs/events.log");
  const logStat = await client.stat("/logs/events.log");
  const rootDir = await client.readdir("/");
  const integrity = await client.checkIntegrity();
  await client.close();

  const root = await navigator.storage.getDirectory();
  const opfsEntries = [];
  for await (const [name, handle] of root.entries()) {
    opfsEntries.push({ name, kind: handle.kind });
  }

  return {
    owner,
    hello,
    logLines: log.trim().split("\\n").length,
    logSize: logStat.size,
    rootNames: rootDir.map((e) => e.name).sort(),
    integrity,
    opfsEntries,
  };
}

run()
  .then((data) => fetch("/__report", { method: "POST", body: JSON.stringify({ ok: true, data }) }))
  .catch((err) => fetch("/__report", { method: "POST", body: JSON.stringify({ ok: false, error: err.stack || String(err) }) }));
</script>`;

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Could not find Chrome/Chromium binary (set CHROME_BIN)");
}

async function runChromePhase(chromeBin, profileDir, url, waitForReport) {
  const proc = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Browser test timed out on ${url}\n${stderr}`)), 20_000);
  });

  try {
    return await Promise.race([waitForReport, timeout]);
  } finally {
    clearTimeout(timer);
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));
  }
}

async function main() {
  const chromeBin = findChrome();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "redb-wasm-chrome-"));

  let resolveReport = null;
  let reportPromise = null;
  const resetReport = () => {
    reportPromise = new Promise((res) => {
      resolveReport = res;
    });
    return reportPromise;
  };

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    if (reqUrl.pathname === "/__test_phase1.html") {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(phase1Html);
      return;
    }
    if (reqUrl.pathname === "/__test_phase2.html") {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(phase2Html);
      return;
    }
    if (reqUrl.pathname === "/__report" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        if (resolveReport) resolveReport(JSON.parse(body));
      });
      return;
    }

    const safePath = path.normalize(reqUrl.pathname).replace(/^(\.\.[/\\])+/, "");
    const absPath = path.join(repoRoot, safePath);
    if (!absPath.startsWith(repoRoot) || !fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(absPath);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(absPath).pipe(res);
  });

  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log("Phase 1: Writing files & CoW snapshot into Browser OPFS...");
    const p1 = await runChromePhase(
      chromeBin,
      profileDir,
      `${baseUrl}/__test_phase1.html`,
      resetReport()
    );
    assert.equal(p1.ok, true, p1.error);
    assert.equal(p1.data.restoredText, "Hello from Browser OPFS!");
    assert.equal(p1.data.integrity, true);
    assert.ok(p1.data.fileSize > 0);
    assert.deepEqual(p1.data.opfsEntries, [{ name: "vault.redb", kind: "file" }]);
    console.log("  OK:", p1.data);

    console.log("Phase 2: Restarting Chrome and verifying durable single-file OPFS persistence...");
    const p2 = await runChromePhase(
      chromeBin,
      profileDir,
      `${baseUrl}/__test_phase2.html`,
      resetReport()
    );
    assert.equal(p2.ok, true, p2.error);
    assert.equal(p2.data.owner, "browser-opfs");
    assert.equal(p2.data.hello, "Hello from Browser OPFS!");
    assert.equal(p2.data.logLines, 60);
    assert.deepEqual(p2.data.rootNames, ["logs", "notes"]);
    assert.equal(p2.data.integrity, true);
    assert.deepEqual(p2.data.opfsEntries, [{ name: "vault.redb", kind: "file" }]);
    console.log("  OK:", p2.data);
    console.log("PASS: Browser OPFS single-file persistence verified across full browser restart!");
  } finally {
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
