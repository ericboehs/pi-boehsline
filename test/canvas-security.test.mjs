/**
 * The canvas daemon's guards: bad paths can't crash it (N4), data routes and
 * POSTs need its key (N5), and its files, folders and environment stay
 * private (N6). Every daemon here runs on a spare port with a temp root;
 * nothing touches ~/.pi/canvas or port 8790.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DAEMON = join(ROOT_DIR, "extensions/canvas/daemon.mjs");

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// index.ts reads PI_CANVAS_PORT once, at import: point it at a port of this
// file's own before loading it, so nothing here can reach a real daemon.
const FAKE_PORT = await freePort();
process.env.PI_CANVAS_PORT = String(FAKE_PORT);
// And a root of its own for the whole file: a fire-and-forget ensureDaemon that
// outlives its test must never fall back to ~/.pi/canvas.
const FILE_ROOT = mkdtempSync(join(tmpdir(), "canvas-sec-file-"));
process.env.PI_CANVAS_ROOT = FILE_ROOT;
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_CANVAS;
const canvas = await import("../extensions/canvas/index.ts");
const daemon = await import("../extensions/canvas/daemon.mjs");
after(() => {
  // A daemon a stray ensureDaemon started there: stop exactly that pid.
  try {
    const { pid, port } = JSON.parse(readFileSync(join(FILE_ROOT, ".daemon.json"), "utf8"));
    if (port === FAKE_PORT && Number.isInteger(pid)) process.kill(pid, "SIGTERM");
  } catch {}
  rmSync(FILE_ROOT, { recursive: true, force: true });
});

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}

/** A daemon on a spare port with `root`; resolves once /health answers. */
async function startDaemon(root, version = "sec") {
  const port = await freePort();
  const child = spawn(process.execPath, [DAEMON, "--port", String(port), "--root", root, "--omarchy", join(root, "none"), "--meeting", join(root, "no-meeting"), "--version", version], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await get(port, "/health").catch(() => undefined)) break;
  }
  const stop = () =>
    new Promise((r) => {
      if (child.exitCode !== null) return r();
      child.once("exit", r);
      child.kill();
    });
  return { port, child, stop };
}

const tokenOf = (root) => JSON.parse(readFileSync(join(root, ".daemon.json"), "utf8")).token;

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "canvas-sec-"));
  mkdirSync(join(root, "s1"));
  writeFileSync(join(root, "s1", "meta.json"), JSON.stringify({ id: "s1", pid: process.pid, name: "secret session" }));
  writeFileSync(join(root, "s1", "sections.json"), JSON.stringify([{ id: "a", title: "A", kind: "markdown", file: "a.md" }]));
  writeFileSync(join(root, "s1", "a.md"), "# private");
  writeFileSync(join(root, "s1", "reply.json"), JSON.stringify({ text: "private reply" }));
  return root;
}

// ── N4 ──────────────────────────────────────────────────────────────────────

test("N4: a path that doesn't decode is a 400, and the daemon stays up", async () => {
  const root = tempRoot();
  const d = await startDaemon(root);
  try {
    const auth = { authorization: `Bearer ${tokenOf(root)}` };
    assert.equal((await get(d.port, "/%E0")).status, 400, "a broken UTF-8 sequence (an <img src> on any web page could send it)");
    assert.equal((await get(d.port, "/s/%zz/f/a.md", auth)).status, 400, "a bare %");
    assert.equal((await get(d.port, "/api/s/%E0%A4", auth)).status, 400);
    const h = await get(d.port, "/health");
    assert.equal(h.status, 200, "still serving");
    assert.equal(d.child.exitCode, null, "still running");
  } finally {
    await d.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("N4: decodeParts returns null instead of throwing", () => {
  assert.deepEqual(daemon.decodeParts("/s/a%20b/f/x.md"), ["s", "a b", "f", "x.md"]);
  assert.equal(daemon.decodeParts("/%E0"), null);
  assert.equal(daemon.decodeParts("/s/%zz"), null);
});

function fakeRes() {
  const res = { headersSent: false, destroyed: false, code: 0 };
  res.writeHead = (code) => ((res.code = code), (res.headersSent = true));
  res.end = () => {};
  res.destroy = () => (res.destroyed = true);
  return res;
}

test("N4: safeHandler turns a throw or a rejection into a 500, never a crash", async () => {
  const errors = [];
  const was = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const a = fakeRes();
    daemon.safeHandler(() => {
      throw new Error("boom");
    })({}, a);
    assert.equal(a.code, 500);
    const b = fakeRes();
    daemon.safeHandler(async () => {
      throw new Error("async boom");
    })({}, b);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(b.code, 500, "an async route's rejection");
    const c = fakeRes();
    daemon.safeHandler((_req, res) => {
      res.writeHead(200);
      throw new Error("late");
    })({}, c);
    assert.equal(c.destroyed, true, "headers already out: drop the connection");
    assert.equal(errors.length, 3, "each one logged");
  } finally {
    console.error = was;
  }
});

// ── N5 ──────────────────────────────────────────────────────────────────────

test("N5: data routes and POSTs need the key; the page shells and assets don't", async () => {
  const root = tempRoot();
  const d = await startDaemon(root);
  try {
    const token = tokenOf(root);
    assert.match(token, /^[0-9a-f]{64}$/, "32 random bytes");
    for (const path of ["/api/sessions", "/api/s/s1", "/api/s/s1/info", "/s/s1/f/a.md", "/api/events", "/api/meeting", "/api/meetings", "/api/peers", "/meeting/aaaaaaaaaaaa/slide/1.jpg"]) {
      const r = await get(d.port, path);
      assert.equal(r.status, 401, `${path} without the key`);
      assert.doesNotMatch(r.body, /private|secret session/);
    }
    assert.equal((await get(d.port, "/api/sessions", { authorization: `Bearer ${"0".repeat(64)}` })).status, 401, "a wrong key");
    assert.equal((await get(d.port, "/api/sessions", { cookie: `canvas_k_${d.port}=${"0".repeat(64)}` })).status, 401, "a wrong cookie");
    assert.equal((await get(d.port, "/api/sessions", { cookie: `canvas_k_1=${token}` })).status, 401, "another port's cookie");
    for (const path of ["/", "/s/s1", "/meeting", "/meetings", "/assets/page.mjs", "/assets/render.mjs", "/health"]) assert.equal((await get(d.port, path)).status, 200, `${path} holds no data`);
    assert.doesNotMatch((await get(d.port, "/health")).body, new RegExp(token), "/health never shows the key");

    // POSTs: no key is a 401 even with the page's header; the key alone isn't enough either.
    assert.equal((await post(d.port, "/s/s1/send", { text: "hi" }, { "x-canvas": "1" })).status, 401);
    assert.equal((await post(d.port, "/follow", { pane: "%1" }, { "x-canvas": "1" })).status, 401);
    assert.equal((await post(d.port, "/s/s1/focus", {}, { "x-canvas": "1" })).status, 401);
    assert.equal((await post(d.port, "/s/s1/clip", { file: "a.md" }, { "x-canvas-clip": "1" })).status, 401);
    assert.equal((await post(d.port, "/s/s1/send", { text: "hi" }, { authorization: `Bearer ${token}` })).status, 403, "still needs the header");
    assert.equal((await post(d.port, "/s/s1/send", { text: "hi" }, { cookie: `canvas_k_${d.port}=${token}`, "x-canvas": "1", origin: "https://evil.example" })).status, 403, "and a matching Origin");
    assert.equal((await post(d.port, "/s/s1/send", { text: "hi" }, { authorization: `Bearer ${token}`, "x-canvas": "1" })).status, 200, "a local tool with the key");
    assert.equal((await post(d.port, "/s/s1/nope", {}, { authorization: `Bearer ${token}`, "x-canvas": "1" })).status, 405);

    // The keyed link: sets the cookie, then the same URL without the key.
    assert.equal((await get(d.port, "/s/s1?k=nope")).status, 403, "a wrong key in the link");
    const r = await get(d.port, `/s/s1?x=1&k=${token}`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/s/s1?x=1", "the key leaves the URL");
    const cookie = r.headers["set-cookie"][0];
    assert.match(cookie, new RegExp(`^canvas_k_${d.port}=${token}; `));
    for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/"]) assert.ok(cookie.split("; ").includes(flag), flag);
    const jar = { cookie: cookie.split(";")[0] };
    const list = await get(d.port, "/api/sessions", jar);
    assert.equal(list.status, 200, "the cookie opens the data routes");
    assert.equal(JSON.parse(list.body)[0].name, "secret session");
    assert.equal((await get(d.port, "/s/s1/f/a.md", jar)).body, "# private");
    assert.equal((await get(d.port, "/api/s/s1", jar)).status, 200);
  } finally {
    await d.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("N5: the key lives in <root>/.daemon.json (600, root 700) and survives a restart", async () => {
  const root = tempRoot();
  chmodSync(root, 0o755);
  let d = await startDaemon(root, "v1");
  try {
    const file = join(root, ".daemon.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(root).mode & 0o777, 0o700, "an existing root is made private");
    const first = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(first.pid, d.child.pid);
    await d.stop();
    d = await startDaemon(root, "v2");
    const second = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(second.version, "v2");
    assert.equal(second.token, first.token, "an upgraded daemon keeps the key, so open tabs keep working");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    await d.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("N5: requestToken reads Bearer or the port's cookie; keyedUrl adds ?k=", () => {
  assert.equal(daemon.requestToken({ authorization: "Bearer abc" }, 1), "abc");
  assert.equal(daemon.requestToken({ cookie: "x=1; canvas_k_1=def; y=2" }, 1), "def");
  assert.equal(daemon.requestToken({ cookie: "canvas_k_2=def" }, 1), "");
  assert.equal(daemon.authorized({ authorization: "Bearer abc" }, "abd", 1), false);
  assert.equal(daemon.authorized({}, "abc", 1), false);
  const root = mkdtempSync(join(tmpdir(), "canvas-sec-"));
  try {
    assert.equal(canvas.daemonToken(root), "", "no daemon yet");
    assert.equal(canvas.keyedUrl("http://127.0.0.1:1/s/x", ""), "http://127.0.0.1:1/s/x", "no key: the plain URL");
    writeFileSync(join(root, ".daemon.json"), JSON.stringify({ pid: 1, token: "a".repeat(64) }));
    assert.equal(canvas.daemonToken(root), "a".repeat(64));
    assert.equal(canvas.keyedUrl("http://127.0.0.1:1/s/x", canvas.daemonToken(root)), `http://127.0.0.1:1/s/x?k=${"a".repeat(64)}`);
    assert.equal(canvas.keyedUrl("http://127.0.0.1:1/?a=1", "b".repeat(64)), `http://127.0.0.1:1/?a=1&k=${"b".repeat(64)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N5: the page shows a lock (and a title /canvas can see) on a 401", () => {
  const page = readFileSync(join(ROOT_DIR, "extensions/canvas/page.mjs"), "utf8");
  const index = readFileSync(join(ROOT_DIR, "extensions/canvas/index.ts"), "utf8");
  assert.match(page, /const LOCKED_TITLE = "Canvas \(locked\)"/);
  assert.match(page, /state = await apiJson\(`\/api\/s\//, "the session page's state goes through apiJson");
  assert.match(page, /sessions = await apiJson\("\/api\/sessions"\)/, "and the index's");
  assert.match(index, /starts with "Canvas \(locked\)" then set URL of t to ku/, "/canvas re-keys a locked tab");
  assert.match(index, /OPEN_SCRIPT, url, keyedUrl\(url\)/, "and opens new tabs with the key");
});

// ── N6 ──────────────────────────────────────────────────────────────────────

test("N6: readBody resolves null on 'close' when the body is too big", async () => {
  const req = new EventEmitter();
  req.destroy = () => setImmediate(() => req.emit("close"));
  const p = daemon.readBody(req, 10);
  req.emit("data", "x".repeat(20));
  const got = await Promise.race([p, new Promise((r) => setTimeout(() => r("hung"), 500))]);
  assert.equal(got, null);
  const ok = new EventEmitter();
  const q = daemon.readBody(ok, 100);
  ok.emit("data", '{"a":1}');
  ok.emit("end");
  ok.emit("close");
  assert.deepEqual(await q, { a: 1 });
});

test("N6: an oversized POST (clip included) drops the connection, and the daemon carries on", async () => {
  const root = tempRoot();
  const d = await startDaemon(root);
  try {
    const auth = { authorization: `Bearer ${tokenOf(root)}` };
    const big = JSON.stringify({ file: "a.md", pad: "x".repeat(4096) });
    for (const [path, header] of [["/s/s1/clip", "x-canvas-clip"], ["/follow", "x-canvas"]]) {
      const r = await post(d.port, path, big, { ...auth, [header]: "1" }).catch((e) => e);
      assert.ok(r instanceof Error || r.status !== 200, `${path}: no answer for an oversized body`);
    }
    assert.equal((await get(d.port, "/health")).status, 200);
  } finally {
    await d.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("N6: the daemon gets a minimal environment, not pi's", () => {
  const env = canvas.daemonEnv({ PATH: "/bin", HOME: "/h", TMPDIR: "/t", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "a", PI_SUBAGENT_CHILD: "1", PI_CANVAS_PORT: "9", PI_CANVAS_THEME: "system", PI_MEETING_NOTES_FILE: "/n", MEETING_CAPTURE_STATE_DIR: "/m", PI_CODING_AGENT_DIR: "/a", GITHUB_TOKEN: "g" }, "/root");
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", TMPDIR: "/t", PI_CANVAS_PORT: "9", PI_CANVAS_THEME: "system", PI_MEETING_NOTES_FILE: "/n", MEETING_CAPTURE_STATE_DIR: "/m", PI_CODING_AGENT_DIR: "/a", PI_CANVAS_ROOT: "/root" });
  const index = readFileSync(join(ROOT_DIR, "extensions/canvas/index.ts"), "utf8");
  assert.match(index, /spawn\(node, \[DAEMON[^\n]*\n[^]*?env: daemonEnv\(process\.env, root\),/, "and startDaemon spawns with it");
  assert.doesNotMatch(index, /env: \{ \.\.\.process\.env, PI_CANVAS_ROOT/);
});

test("N6: makeRoot makes the canvas root private, new or not", () => {
  const base = mkdtempSync(join(tmpdir(), "canvas-sec-"));
  try {
    const fresh = canvas.makeRoot(join(base, "a", "canvas"));
    assert.equal(statSync(fresh).mode & 0o777, 0o700);
    const old = join(base, "old");
    mkdirSync(old, { mode: 0o755 });
    chmodSync(old, 0o755);
    canvas.makeRoot(old);
    assert.equal(statSync(old).mode & 0o777, 0o700);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** A stand-in for a daemon on FAKE_PORT: /health answers with `version` and `pid`. */
async function fakeHealth(info) {
  const s = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(info));
  });
  await new Promise((r) => s.listen(FAKE_PORT, "127.0.0.1", r));
  return () => new Promise((r) => s.close(r));
}

test("N6: a session folder is created 700", async () => {
  const root = FILE_ROOT;
  // ensureDaemon finds a current daemon here and starts nothing.
  const close = await fakeHealth({ ok: true, version: canvas.daemonVersion(), pid: 1 });
  try {
    let tool;
    const pi = new Proxy({}, { get: (_, k) => (k === "registerTool" ? (t) => (tool = t) : k === "getSessionName" ? () => "" : () => {}) });
    await canvas.default(pi);
    const ctx = { cwd: root, sessionManager: { getSessionId: () => "sess-1", getBranch: () => [] }, ui: { notify() {}, setStatus() {} }, hasUI: false };
    await tool.execute("c1", { kind: "finding", body: "a fact" }, undefined, undefined, ctx);
    // The tool's own ensureDaemon is in flight: let it finish while the fake still answers.
    assert.equal(await canvas.ensureDaemon(), true);
    assert.equal(statSync(join(root, "sess-1")).mode & 0o777, 0o700);
  } finally {
    await close();
  }
});

/** A process that only waits, standing in for whatever pid /health names. */
function sleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  return child;
}

async function runEnsureDaemon(root) {
  const script = `const { ensureDaemon } = await import(${JSON.stringify(join(ROOT_DIR, "extensions/canvas/index.ts"))}); console.log("RESULT " + (await ensureDaemon()));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT_DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_CANVAS_PORT: String(FAKE_PORT), PI_CANVAS_ROOT: root }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("close", r));
  return out;
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

/**
 * The daemon ensureDaemon spawns finds the fake holding the port and exits,
 * saying so in .daemon.log. Hold the port until then, or it would take it over.
 */
async function untilLostRace(root, n) {
  for (let i = 0; i < 100; i++) {
    try {
      if (readFileSync(join(root, ".daemon.log"), "utf8").split("is in use").length - 1 >= n) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("N6: startDaemon SIGTERMs only the pid its root recorded, never one /health alone names", async () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-sec-"));
  const stranger = sleeper();
  const own = sleeper();
  try {
    // A stale daemon answers, naming a pid this root never recorded.
    let close = await fakeHealth({ ok: true, version: "old", pid: stranger.pid });
    try {
      await runEnsureDaemon(root);
      await untilLostRace(root, 1);
    } finally {
      await close();
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(stranger), "a pid only /health names is left alone");

    // The one this root recorded, and /health agrees: that one is stopped.
    writeFileSync(join(root, ".daemon.json"), JSON.stringify({ pid: own.pid, port: FAKE_PORT, version: "old" }));
    close = await fakeHealth({ ok: true, version: "old", pid: own.pid });
    try {
      await runEnsureDaemon(root);
      await untilLostRace(root, 2);
    } finally {
      await close();
    }
    for (let i = 0; i < 20 && alive(own); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(own.signalCode, "SIGTERM", "the recorded daemon gets SIGTERM");
  } finally {
    stranger.kill();
    own.kill();
    // A daemon ensureDaemon started once the fake let go of the port: stop exactly that pid.
    try {
      const pid = JSON.parse(readFileSync(join(root, ".daemon.json"), "utf8")).pid;
      if (pid !== own.pid && pid !== stranger.pid && pid !== process.pid) process.kill(pid, "SIGTERM");
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("N6: scripts/test.mjs runs the tests without pi's PI_* variables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-sec-"));
  try {
    const probe = join(dir, "env-probe.test.mjs");
    writeFileSync(probe, `import test from "node:test"; import assert from "node:assert/strict";\ntest("env", () => { for (const k of ["PI_SUBAGENT_CHILD", "PI_CANVAS", "PI_CANVAS_THEME", "PI_OFFLINE"]) assert.equal(process.env[k], undefined, k); assert.ok(process.env.PATH); });\n`);
    // Without NODE_TEST_CONTEXT: under node --test it makes the inner run report to this one and exit 0 whatever happens.
    const { NODE_TEST_CONTEXT: _ctx, ...outer } = process.env;
    const child = spawn(process.execPath, [join(ROOT_DIR, "scripts/test.mjs"), probe], { cwd: ROOT_DIR, env: { ...outer, PI_SUBAGENT_CHILD: "1", PI_CANVAS: "0", PI_CANVAS_THEME: "system", PI_OFFLINE: "1", TEST_RUNS_DIR: join(dir, "runs") }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N6: testEnv's root guard sees through symlinks and subfolders; a busy port is replaced", async () => {
  const { insideRealRoot, testEnv } = await import("../scripts/test-env.mjs");
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:net");
  const base = mkdtempSync(join(tmpdir(), "pi-guard-"));
  try {
    const live = join(base, "live");
    mkdirSync(join(live, "sessions"), { recursive: true });
    symlinkSync(live, join(base, "link"));
    for (const p of [live, `${live}/`, join(live, "sessions"), join(live, "not-yet", "deeper"), join(base, "link"), join(base, "link", "sessions"), join(base, "x", "..", "live")]) {
      assert.equal(insideRealRoot(p, live), true, p);
    }
    for (const p of [base, join(base, "livex"), join(base, "other"), tmpdir()]) assert.equal(insideRealRoot(p, live), false, p);
    // a caller's port something already listens on (a daemon) is never kept
    const busy = createServer();
    await new Promise((done) => busy.listen(0, "127.0.0.1", done));
    const taken = busy.address().port;
    const { env, madeRoot } = await testEnv({ PI_CANVAS_ROOT: join(base, "other"), PI_CANVAS_PORT: String(taken) });
    await new Promise((done) => busy.close(done));
    assert.equal(madeRoot, undefined);
    assert.equal(env.PI_CANVAS_ROOT, join(base, "other"), "a safe root is kept");
    assert.notEqual(env.PI_CANVAS_PORT, String(taken), "a busy port is replaced");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("N6: testEnv never yields the live canvas root or port 8790", async () => {
  const { testEnv, REAL_CANVAS_ROOT } = await import("../scripts/test-env.mjs");
  assert.equal(REAL_CANVAS_ROOT, join(homedir(), ".pi", "canvas"));
  const made = [];
  try {
    for (const given of [{}, { PI_CANVAS: "0" }, { PI_CANVAS_ROOT: REAL_CANVAS_ROOT, PI_CANVAS_PORT: "8790" }, { PI_CANVAS_ROOT: `${homedir()}/.pi/./canvas/`, PI_CANVAS_PORT: "08790" }, { PI_CANVAS_PORT: "nope" }]) {
      const { env, madeRoot } = await testEnv({ PATH: "/bin", ...given });
      if (madeRoot) made.push(madeRoot);
      assert.ok(env.PI_CANVAS_ROOT && env.PI_CANVAS_ROOT !== REAL_CANVAS_ROOT, `root for ${JSON.stringify(given)}`);
      assert.equal(madeRoot, env.PI_CANVAS_ROOT, "a fresh folder of its own");
      assert.ok(existsSync(madeRoot));
      assert.match(env.PI_CANVAS_PORT, /^\d+$/);
      assert.notEqual(env.PI_CANVAS_PORT, "8790", `port for ${JSON.stringify(given)}`);
      assert.equal(env.PI_CANVAS, undefined, "other PI_* still cleared");
      assert.equal(env.PATH, "/bin");
    }
    // A caller's own (safe) root and port for the run are kept.
    const own = mkdtempSync(join(tmpdir(), "canvas-sec-"));
    made.push(own);
    const { env, madeRoot } = await testEnv({ PI_CANVAS_ROOT: own, PI_CANVAS_PORT: "45678" });
    assert.equal(madeRoot, undefined);
    assert.equal(env.PI_CANVAS_ROOT, own);
    assert.equal(env.PI_CANVAS_PORT, "45678");
  } finally {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  }
});

test("N5: loadToken reuses .daemon.json's key only from a private regular file of ours", () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-sec-"));
  try {
    const file = join(root, ".daemon.json");
    const key = "c".repeat(64);
    assert.match(daemon.loadToken(root), /^[0-9a-f]{64}$/, "no file: a fresh key");
    writeFileSync(file, JSON.stringify({ token: key }), { mode: 0o600 });
    chmodSync(file, 0o600);
    assert.equal(daemon.loadToken(root), key, "600, ours: reused");
    chmodSync(file, 0o640);
    const fresh = daemon.loadToken(root);
    assert.notEqual(fresh, key, "group-readable: a new key");
    assert.match(fresh, /^[0-9a-f]{64}$/);
    chmodSync(file, 0o604);
    assert.notEqual(daemon.loadToken(root), key, "world-readable: a new key");
    // A symlink to a private file is still not trusted.
    const real = join(root, "elsewhere.json");
    writeFileSync(real, JSON.stringify({ token: key }), { mode: 0o600 });
    rmSync(file);
    symlinkSync(real, file);
    assert.notEqual(daemon.loadToken(root), key, "a symlink: a new key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N5: a non-ASCII key of the right length is a 401/403, never a 500", async () => {
  assert.equal(daemon.authorized({ authorization: `Bearer ${"\u00e9".repeat(64)}` }, "0".repeat(64), 1), false, "no throw");
  assert.equal(daemon.authorized({ cookie: `canvas_k_1=${"\u00e9".repeat(64)}` }, "0".repeat(64), 1), false);
  const root = tempRoot();
  const d = await startDaemon(root);
  try {
    assert.equal((await get(d.port, "/api/sessions", { authorization: `Bearer ${"\u00e9".repeat(64)}` })).status, 401);
    assert.equal((await get(d.port, "/api/sessions", { cookie: `canvas_k_${d.port}=${"\u00e9".repeat(64)}` })).status, 401);
    assert.equal((await get(d.port, `/s/s1?k=${"%C3%A9".repeat(64)}`)).status, 403);
    assert.equal((await get(d.port, "/health")).status, 200, "still up");
  } finally {
    await d.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("N5: a keyed link can't redirect off-site", async () => {
  const root = tempRoot();
  const d = await startDaemon(root);
  try {
    const token = tokenOf(root);
    assert.equal((await get(d.port, `/.//evil.com?k=${token}`)).headers.location, "/evil.com");
    for (const path of ["/.//evil.com", "//evil.com", "/./\\evil.com", "/.///evil.com/x"]) {
      const r = await get(d.port, `${path}?a=1&k=${token}`);
      if (r.status !== 303) continue; // a path the daemon refuses outright is fine too
      assert.match(r.headers.location, /^\/(?![\/\\])/, `${path} -> ${r.headers.location}: one leading slash`);
      assert.ok(r.headers.location.endsWith("?a=1"));
    }
  } finally {
    await d.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("/canvas opens Canvas.app when there is one, else drives Safari", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-sec-"));
  try {
    assert.deepEqual(canvas.canvasAppCandidates({}), [join(homedir(), "Applications", "Canvas.app"), "/Applications/Canvas.app"]);
    assert.deepEqual(canvas.canvasAppCandidates({ PI_CANVAS_APP: "" }), [], "empty turns it off");
    assert.deepEqual(canvas.canvasAppCandidates({ PI_CANVAS_APP: "/a.app:/b.app" }), ["/a.app", "/b.app"]);
    const app = join(dir, "Canvas.app");
    mkdirSync(app);
    const url = "http://127.0.0.1:1/s/x";
    let calls = [];
    const fake = async (cmd, args) => (calls.push([cmd, ...args]), cmd === "osascript" ? "opened\n" : "");
    assert.equal(await canvas.openInSafari(url, { apps: [join(dir, "Missing.app"), app], run: fake }), "opened in Canvas.app");
    assert.deepEqual(calls, [["open", "-a", app, canvas.keyedUrl(url)]], "open -a with the keyed URL, no AppleScript");
    calls = [];
    assert.equal(await canvas.openInSafari(url, { apps: [join(dir, "Missing.app")], run: fake }), "opened");
    assert.deepEqual(calls.map((c) => c[0]), ["wrangle", "osascript"], "no app: the Safari path");
    assert.equal(await canvas.openInSafari(url, { apps: [], run: async () => "" }), "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── one markdown renderer ────────────────────────────────────────────────────

test("page.mjs renders markdown through render.mjs: no sanitize policy of its own", () => {
  const page = readFileSync(join(ROOT_DIR, "extensions/canvas/page.mjs"), "utf8");
  assert.doesNotMatch(page, /marked\.parse\(/, "page.mjs never parses markdown itself");
  assert.doesNotMatch(page, /const HL_CLEAN\b/, "nor keeps its own highlight allow-list");
  assert.match(page, /renderMarkdown as renderMd\b[^;]*from "\.\/render\.mjs"/);
  assert.match(page, /renderMd\(text, \{[\s\S]*?mermaid: drawMermaid/);
  assert.ok(!existsSync(join(ROOT_DIR, "extensions/canvas/markdown.mjs")));
});
