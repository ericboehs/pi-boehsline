/**
 * The test environment, in its own module so it is in place before anything
 * that reads it.
 *
 * ESM hoists every `import` above the statements in a test file, so an env var
 * assigned there after the imports is set too late for a module that reads it
 * while loading. This file is imported first, so its top-level assignments run
 * before the scheduler is loaded. (The scheduler's own lookups are lazy —
 * `schedulerDir()` reads the environment on each call — but that is an
 * implementation detail nobody should have to rely on.)
 *
 * Without this the tests read and write the developer's real
 * ~/.pi/agent/scheduler.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The schedule tool is a Boehsline opt-in. Point the config at a scratch file
// so the developer's own boehsline.json cannot turn it on under the tests.
const configDir = mkdtempSync(join(tmpdir(), "session-scheduler-"));
export const configPath = join(configDir, "boehsline.json");
process.env.BOEHSLINE_CONFIG = configPath;
delete process.env.BOEHSLINE_ENABLE;

// Every scheduler file a test produces — the timer index, lock directories —
// goes here.
export const schedulerDir = mkdtempSync(join(tmpdir(), "session-scheduler-state-"));
process.env.PI_SCHEDULER_DIR = schedulerDir;
delete process.env.PI_SCHEDULER_SESSION_MISFIRE;
process.env.PI_AGENT_DIR = schedulerDir;
