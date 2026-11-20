// Live reload smoke: two throwaway pi rpc sessions, one reloads the other.
//
// Both run in a throwaway HOME (and XDG_RUNTIME_DIR), so they only see each
// other: no live session is listed, messaged, or reloaded. No model is needed;
// the sender drives `/agent-link reload` as a command.
//
// Run under a pi-compatible Node; PI_CMD overrides how pi is launched:
//   node --experimental-strip-types test/reload-live.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXT, spawnPi } from "./pi-launch.mjs";

const home = mkdtempSync(path.join(tmpdir(), "al-reload-live-"));
const REG = path.join(home, ".claude", "sessions");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The parent may itself be a pi session: don't hand its identity to the children.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PI_") || k === "PI_CMD"));
Object.assign(env, { HOME: home, XDG_RUNTIME_DIR: path.join(home, "run"), XDG_CACHE_HOME: path.join(home, ".cache") });

function launch(label) {
  const cwd = path.join(home, label);
  mkdirSync(cwd, { recursive: true });
  const child = spawnPi(["--mode", "rpc", "--no-session", "-e", EXT], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const s = { label, child, lines: [], notes: [], errors: [], waiters: new Map(), seq: 0 };
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      s.lines.push(msg);
      if (msg.type === "extension_ui_request" && msg.method === "notify") s.notes.push(msg.message);
      if (msg.type === "extension_error") s.errors.push(msg.error);
      if (msg.type === "response" && s.waiters.has(msg.id)) { s.waiters.get(msg.id)(msg); s.waiters.delete(msg.id); }
    }
  });
  child.stderr.on("data", (d) => s.errors.push(String(d).trim()));
  s.rpc = (cmd) => new Promise((resolve) => {
    const id = `${label}-${++s.seq}`;
    s.waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
  });
  return s;
}

const entryFor = (pid) => {
  try {
    for (const f of readdirSync(REG)) {
      if (f === `${pid}.json`) return { ...JSON.parse(readFileSync(path.join(REG, f), "utf8")), file: path.join(REG, f) };
    }
  } catch { /* not yet */ }
};
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
}

const A = launch("smoke-sender");
const B = launch("smoke-target");
let ok = true;
const check = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) ok = false; };

try {
  const a = await until(() => entryFor(A.child.pid));
  const b = await until(() => entryFor(B.child.pid));
  check(a && b, `both registered: ${a?.name} (pid ${A.child.pid}), ${b?.name} (pid ${B.child.pid})`);
  if (!a || !b) throw new Error("registration failed");

  const before = (await B.rpc({ type: "get_messages" })).data.messages.length;
  const mtime = statSync(b.file).mtimeMs;
  await sleep(50);

  const res = await A.rpc({ type: "prompt", message: `/agent-link reload ${b.name}` });
  check(res.success, `sender ran /agent-link reload ${b.name}`);
  const note = await until(() => A.notes.find((n) => n.includes(b.name)), 8000);
  check(/reloaded/.test(note ?? ""), `sender was told: ${note}`);
  check(B.notes.some((n) => /reloading \(requested by/.test(n)), `target notified: ${B.notes.find((n) => /reloading/.test(n))}`);

  const reRegistered = await until(() => { const e = entryFor(B.child.pid); return e && statSync(e.file).mtimeMs > mtime && e; }, 8000);
  check(Boolean(reRegistered), `target re-registered after the reload as ${reRegistered?.name}`);
  const after = (await B.rpc({ type: "get_messages" })).data.messages.length;
  check(before === 0 && after === 0, `target transcript untouched (${before} → ${after} messages)`);
  const state = (await B.rpc({ type: "get_state" })).data;
  check(state.isStreaming === false, "target never started a model turn");

  // The reloaded instance still answers, and the rate limit survived the reload.
  A.notes.length = 0;
  await A.rpc({ type: "prompt", message: "/agent-link reload *idle" });
  const bulk = await until(() => A.notes.find((n) => /idle session/.test(n)), 8000);
  check(/rate-limited/.test(bulk ?? ""), `second request (bulk *idle) answered by the new instance: ${bulk?.replace(/\n/g, " | ")}`);
  check(!B.errors.some((e) => /error/i.test(e)) && !A.errors.some((e) => /error/i.test(e)), "no extension errors");
} catch (e) {
  ok = false;
  console.log(`✗ ${e.message}`);
} finally {
  for (const s of [A, B]) { s.child.stdin.end(); setTimeout(() => s.child.kill("SIGKILL"), 1500).unref(); }
  await sleep(1800);
  const leftovers = (() => { try { return readdirSync(REG).filter((f) => f.endsWith(".json")); } catch { return []; } })();
  check(leftovers.length === 0, `registry clean after exit (${leftovers.length} left)`);
  if (!ok) for (const s of [A, B]) console.log(`${s.label} stderr/errors:`, s.errors.slice(0, 5));
}
process.exit(ok ? 0 : 1);
