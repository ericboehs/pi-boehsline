// The environment scripts/test.mjs runs the tests in (its own module so a
// test can import it without starting a run).

import { mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The live canvas daemon's root and port: no test may ever reach either. */
export const REAL_CANVAS_ROOT = resolve(homedir(), ".pi", "canvas");
export const REAL_CANVAS_PORT = "8790";

/** A port nothing is listening on right now (0: any), or null when `want` is taken. */
async function freePort(want = 0) {
  const server = createServer();
  const listening = await new Promise((done) => {
    server.once("error", () => done(false));
    server.listen(want, "127.0.0.1", () => done(true));
  });
  if (!listening) return null;
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/** A path with symlinks resolved, through its nearest existing ancestor when it doesn't exist yet. */
function realish(path) {
  const rest = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      if (dirname(at) === at) return resolve(path);
      rest.push(basename(at));
    }
  }
}

/** True when `path` is the live canvas root or inside it, symlinks and all. */
export function insideRealRoot(path, realRoot = REAL_CANVAS_ROOT) {
  const rel = relative(realish(realRoot), realish(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * The tests' environment: this one without pi's own variables. Run from inside
 * pi (a subagent, a bash tool call), PI_SUBAGENT_CHILD=1, PI_CANVAS=0,
 * PI_CANVAS_THEME and the rest switch extensions off or point them elsewhere,
 * and tests that need one set it themselves.
 *
 * Clearing PI_CANVAS=0 would let a test's canvas reach the live daemon, so
 * PI_CANVAS_ROOT and PI_CANVAS_PORT always point somewhere private: the
 * caller's if it set them (and they aren't the live ones), else a fresh temp
 * folder and a free port. `madeRoot` is the folder made here, to remove after.
 */
export async function testEnv(env) {
  const out = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PI_")));
  let madeRoot;
  const root = env.PI_CANVAS_ROOT ? resolve(env.PI_CANVAS_ROOT) : "";
  if (root && !insideRealRoot(root)) out.PI_CANVAS_ROOT = root;
  else out.PI_CANVAS_ROOT = madeRoot = mkdtempSync(join(tmpdir(), "pi-test-canvas-"));
  const port = Number(env.PI_CANVAS_PORT);
  // The caller's port only if it's valid, not the live one, and nothing (a daemon) listens on it.
  const ok = Number.isInteger(port) && port > 0 && port < 65536 && String(port) !== REAL_CANVAS_PORT && (await freePort(port)) !== null;
  out.PI_CANVAS_PORT = ok ? String(port) : String(await freePort());
  return { env: out, madeRoot };
}
