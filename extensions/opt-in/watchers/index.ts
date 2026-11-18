/**
 * watchers: background watchers that post short status lines into an
 * interactive session, without the agent starting anything.
 *
 * A watcher is a script in ~/.pi/agent/watchers.toml (global only) that
 * prints JSON Lines events. Every `interval` the session whose cwd matches
 * runs it (no shell, own process group, 45 s cap), dedupes ids against
 * seen.jsonl, batches 30 s, sends every title and excerpt through a
 * tool-less guardian, and posts one `watcher` custom message. Events the
 * script marks `act` may wake the agent, within caps; everything else is a
 * silent line.
 *
 * Only in interactive sessions (tui, rpc); never in print/json mode or in a
 * subagent child (PI_SUBAGENT_CHILD). One session per watcher polls (the
 * holder lock in the state dir); `/watchers takeover` moves it.
 *
 *   /watchers                  status: holder, last run, errors, wakes, guardian
 *   /watchers pause|resume <id>
 *   /watchers test <id>        dry run: prints events, commits nothing
 *   /watchers show <id>        the last 20 delivered events
 *   /watchers takeover <id>    poll from this session instead
 *
 * See README.md for the config and the script contract.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { optIn } from "../../../lib/opt-in.ts";
import { commandProblem, type JudgeChoice, loadConfig, type LoadResult, matchesCwd, pickJudge, type WatcherConfig } from "./config.ts";
import { forceInfo, normalize, parseOutput, textFor, type WatchEvent } from "./contract.ts";
import { applyVerdicts, type Delivered, formatMessage, freeTexts, wakeGate, WAKES_PER_HOUR, wantsWake } from "./delivery.ts";
import { type CompleteFn, Guardian } from "./guardian.ts";
import {
	acquireLock,
	acquireRunLock,
	clearNext,
	commitState,
	defaultStateRoot,
	dryRunDir,
	ensureDir,
	holdsLock,
	killAll,
	type LockInfo,
	lockOwnerAlive,
	readHost,
	readLock,
	readWakes,
	recordWake,
	releaseLock,
	releaseRunLock,
	runScript,
	SeenStore,
	takeNext,
	writeHost,
} from "./state.ts";

export const MSG_TYPE = "watcher";
export const BATCH_MS = 30_000;
export const BACKOFF_START_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const ERROR_POST_EVERY_MS = 3_600_000;
export const BACKLOG_AFTER_MS = 3_600_000;
export const SHOW_LIMIT = 20;

/** 60 s, doubling, capped at 15 min. */
export const nextBackoff = (prev: number): number => (prev ? Math.min(prev * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS);

const REGISTRY_KEY = Symbol.for("pi-boehsline.watchers");

export interface Registry {
	/** The running host, if any: one per process, whatever reloads happened. */
	host?: { instance: string; teardown: () => void };
	/** Guardian verdict cache and call counts survive reloads. */
	guardian?: Guardian;
	/** Session wake timestamps per watcher: a /reload keeps them; new, resume and fork reset them. */
	sessionWakes?: Map<string, number[]>;
}

const registry = (): Registry => {
	const g = globalThis as unknown as Record<symbol, Registry | undefined>;
	return (g[REGISTRY_KEY] ??= {});
};

/** Interactive sessions only, and never a subagent child. */
export function shouldStart(mode: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.PI_SUBAGENT_CHILD) return false;
	return mode === "tui" || mode === "rpc";
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_WATCHERS_CONFIG || join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "watchers.toml");
}

export interface HostOptions {
	configPath?: string;
	stateRoot?: string;
	batchMs?: number;
	runTimeoutMs?: number;
	guardianTimeoutMs?: number;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	alive?: (lock: LockInfo) => boolean;
	/** Overrides the model call (tests). Approval checks still apply. */
	complete?: CompleteFn;
	/** The process-wide registry (tests use their own to act as separate processes). */
	registry?: Registry;
}

interface PendingState {
	/** The run that wrote it; an older run's state never overwrites a newer one's. */
	seq: number;
	data: Buffer;
}

/**
 * Events on their way to the agent, by the lowest run seq among them. A
 * state is committed only when no batch with the same or a lower seq is
 * still outstanding.
 */
interface Batch {
	minSeq: number;
}

interface Runtime {
	cfg: WatcherConfig;
	dir: string;
	seen: SeenStore;
	problem?: string;
	paused: boolean;
	holder: boolean;
	heldBy?: LockInfo;
	running: boolean;
	timer?: ReturnType<typeof setTimeout>;
	batchTimer?: ReturnType<typeof setTimeout>;
	pending: WatchEvent[];
	pendingIds: Set<string>;
	/** The script state that goes with `pending`: committed once that batch is delivered. */
	pendingState?: PendingState;
	/** The batch `pending` will become. */
	pendingBatch?: Batch;
	/** Every batch not yet delivered or dropped, `pendingBatch` included. */
	batches: Set<Batch>;
	/** The newest state waiting on a lower-seq batch before it can be committed. */
	deferred?: PendingState;
	/**
	 * A batch was released, dropped or torn down: its events weren't delivered,
	 * so no state from a run before then may be committed. Cleared when a run
	 * completes with nothing in flight.
	 */
	dirty: boolean;
	/** Batches between the 30 s timer and send (waiting on the guardian). */
	flushing: number;
	runSeq: number;
	committedSeq: number;
	lastRunAt?: number;
	lastOkAt?: number;
	lastError?: string;
	stderrTail?: string;
	errorPostedAt?: number;
	backoffMs: number;
	contractErrors: number;
	sessionWakes: number[];
	recent: Delivered[];
	secretNotified: boolean;
}

type Outgoing =
	| { w: Runtime; delivered: Delivered[]; guardianFailed: boolean; state?: PendingState; batch?: Batch }
	| { w: Runtime; note: string; seenIds?: string[]; state?: PendingState; batch?: Batch };

/** An exception's text, normalized (no control or escape characters) and capped: it reaches notes and /watchers. */
export const errText = (e: unknown): string => {
	let msg: string;
	try {
		msg = e instanceof Error ? e.message : String(e);
	} catch {
		msg = "unknown error";
	}
	return normalize(typeof msg === "string" ? msg : String(msg), 160);
};

export function createWatchers(opts: HostOptions = {}) {
	return (pi: ExtensionAPI) => {
		const now = opts.now ?? Date.now;
		const env = opts.env ?? process.env;
		const batchMs = opts.batchMs ?? BATCH_MS;
		const reg = opts.registry ?? registry();
		const guardian = opts.complete || opts.now ? new Guardian({ now, timeoutMs: opts.guardianTimeoutMs }) : (reg.guardian ??= new Guardian());

		let ctxRef: ExtensionContext | undefined;
		let config: LoadResult | undefined;
		let runtimes = new Map<string, Runtime>();
		let instance = "";
		let started = false;
		let compacting = false;
		let meeting = false;
		let outbox: Outgoing[] = [];
		const children = new Set<ChildProcess>();

		const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
			if (ctxRef?.hasUI) ctxRef.ui.notify(msg, level);
		};

		// ── the guardian's model ──

		const splitRef = (ref: string): [string, string] => {
			const slash = ref.indexOf("/");
			return [ref.slice(0, slash), ref.slice(slash + 1)];
		};

		function findModel(ref: string) {
			const registry = ctxRef?.modelRegistry;
			if (!registry) return undefined;
			try {
				return registry.find(...splitRef(ref));
			} catch {
				return undefined;
			}
		}

		/**
		 * The judge for the session's current provider, resolved fresh each time
		 * (so a /model switch takes effect at the next batch).
		 */
		function resolveJudge(): JudgeChoice {
			const g = config?.guardian;
			if (!g) return { reason: "no config" };
			let provider: string | undefined;
			try {
				provider = ctxRef?.model?.provider;
			} catch {
				provider = undefined; // a stale context
			}
			const registry = ctxRef?.modelRegistry;
			return pickJudge(g, provider, (ref) => {
				if (!registry) return opts.complete ? undefined : "no model registry";
				const model = findModel(ref);
				if (!model) return "not found";
				try {
					return registry.hasConfiguredAuth(model) ? undefined : "no credentials";
				} catch {
					return "no credentials";
				}
			});
		}

		function guardianCall(): { complete: CompleteFn; judge: string } | undefined {
			const choice = resolveJudge();
			if (!choice.model) return undefined;
			if (opts.complete) return { complete: opts.complete, judge: choice.model };
			const registry = ctxRef?.modelRegistry;
			const model = findModel(choice.model);
			if (!registry || !model) return undefined;
			// No tools: the judge can't act, only answer. No `reasoning`: thinking off.
			return { judge: choice.model, complete: (req, o) => registry.streamSimple(model, req, o).result() };
		}

		// ── delivery ──

		/** A batch won't be delivered: nothing from a run before now may be committed until a run completes idle. */
		function drop(w: Runtime, batch: Batch | undefined) {
			if (batch) w.batches.delete(batch);
			w.dirty = true;
			w.deferred = undefined;
		}

		/** Forget ids that won't be delivered, so a later run can queue them again. */
		function release(item: Outgoing) {
			if ("delivered" in item) for (const d of item.delivered) item.w.pendingIds.delete(d.id);
			if (item.batch) drop(item.w, item.batch);
		}

		/**
		 * Commit the newest known state, unless the runtime is dirty or a batch
		 * with the same or a lower seq is still outstanding (then it waits).
		 */
		function tryCommit(w: Runtime, state: PendingState | undefined) {
			if (state && (!w.deferred || state.seq > w.deferred.seq)) w.deferred = state;
			const s = w.deferred;
			if (!s) return;
			if (w.dirty || s.seq <= w.committedSeq) {
				w.deferred = undefined;
				return;
			}
			for (const b of w.batches) if (b.minSeq <= s.seq) return;
			if (!holdsLock(w.dir, instance)) return;
			commitState(w.dir, s.data);
			w.committedSeq = s.seq;
			w.deferred = undefined;
		}

		/** After pi took the message: mark seen, then commit the script state that went with it. */
		function markDelivered(w: Runtime, ids: string[], state: PendingState | undefined, batch: Batch | undefined) {
			w.seen.add(ids, now());
			if (batch) w.batches.delete(batch);
			tryCommit(w, state);
		}

		/** sendMessage, whether it returns or throws or rejects. `then` runs once pi has the message. */
		function post(item: Outgoing, message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1], then: () => void) {
			const { w } = item;
			const fail = (e: unknown) => {
				release(item);
				w.lastError = `send failed: ${errText(e)}`;
			};
			let r: unknown;
			try {
				r = pi.sendMessage(message, options);
			} catch (e) {
				return fail(e);
			}
			const after = () => {
				try {
					then();
				} catch (e) {
					w.lastError = `after send: ${errText(e)}`;
				}
			};
			if (r && typeof (r as Promise<void>).then === "function") (r as Promise<void>).then(after, fail);
			else after();
		}

		function send(item: Outgoing) {
			if (runtimes.get(item.w.cfg.id) !== item.w) return drop(item.w, item.batch);
			if (compacting) {
				outbox.push(item);
				return;
			}
			const { w } = item;
			// Only the holder posts. A session that lost the lock mid-batch drops it; the new holder's runs bring it again.
			if (!holdsLock(w.dir, instance)) {
				w.holder = false;
				release(item);
				return;
			}
			if ("note" in item) {
				const { note, seenIds = [], state, batch } = item;
				post(item, { customType: MSG_TYPE, display: true, content: note, details: { watcher: w.cfg.id, events: [] } }, { triggerTurn: false }, () =>
					markDelivered(w, seenIds, state, batch),
				);
				return;
			}
			const { delivered, guardianFailed } = item;
			const t = now();
			const wants = wantsWake(delivered, guardianFailed);
			const gate = wants
				? wakeGate({
						wake: w.cfg.wake,
						now: t,
						sessionWakes: w.sessionWakes,
						watcherWakes: readWakes(w.dir, t),
						meeting,
						compacting,
						quiet: w.cfg.quiet,
					})
				: { allowed: false };
			const wake = wants && gate.allowed;
			// A waking message carries structured fields only; titles and excerpts stay out, and
			// URLs too unless their owner/name was checked against `repos`.
			const content = formatMessage(w.cfg.id, delivered, wake, !!w.cfg.repos);
			const message = { customType: MSG_TYPE, display: true, content, details: { watcher: w.cfg.id, events: delivered, wake } };
			// Info lines: no deliverAs. While a turn runs pi queues them for its end.
			const options = wake ? ({ deliverAs: "followUp", triggerTurn: true } as const) : { triggerTurn: false };
			if (wake) {
				// Counted when tried, so a failing send can't loop past the cap.
				w.sessionWakes.push(t);
				recordWake(w.dir, t);
			}
			post(item, message, options, () => {
				// Seen, and the script state committed, only after delivery: a crash may repeat an event, never lose one.
				const ids = delivered.map((d) => d.id);
				for (const id of ids) w.pendingIds.delete(id);
				markDelivered(w, ids, item.state, item.batch);
				w.recent.push(...delivered);
				w.recent.splice(0, Math.max(0, w.recent.length - SHOW_LIMIT));
			});
		}

		function flushOutbox() {
			const items = outbox;
			outbox = [];
			for (const item of items) send(item);
		}

		async function flushBatch(w: Runtime) {
			w.batchTimer = undefined;
			const batch = w.pending.splice(0);
			const state = w.pendingState;
			const owner = w.pendingBatch;
			w.pendingState = undefined;
			w.pendingBatch = undefined;
			if (!batch.length || !started) return drop(w, owner);
			let handed = false;
			w.flushing++;
			try {
				const items = freeTexts(batch);
				const call = items.length ? guardianCall() : undefined;
				const verdicts = items.length
					? await guardian.check(w.cfg.id, items.map((i) => i.text), call?.complete, config?.guardian.callsPerHour ?? 200, call?.judge)
					: [];
				if (!started || runtimes.get(w.cfg.id) !== w) return;
				const delivered = applyVerdicts(batch, verdicts, !!w.cfg.repos);
				guardian.statsFor(w.cfg.id).withheld += delivered.filter((d) => d.withheld).length;
				if (!w.secretNotified && verdicts.some((v) => v === "secret" || v === "sensitive")) {
					w.secretNotified = true;
					notify(`watchers · ${w.cfg.id}: withheld a credential-like string from an event (see /watchers show ${w.cfg.id}); not repeated this session`, "warning");
				}
				handed = true;
				send({ w, delivered, guardianFailed: verdicts.includes("unavailable"), state, batch: owner });
			} catch (e) {
				if (started && runtimes.get(w.cfg.id) === w) failure(w, `delivery failed: ${errText(e)}`);
			} finally {
				w.flushing--;
				// Not handed to send: let a later run queue these ids again.
				if (!handed) {
					for (const ev of batch) w.pendingIds.delete(ev.id);
					drop(w, owner);
				}
			}
		}

		function enqueue(w: Runtime, events: WatchEvent[], seq: number, state?: PendingState) {
			if (!w.pendingBatch) w.batches.add((w.pendingBatch = { minSeq: seq }));
			else w.pendingBatch.minSeq = Math.min(w.pendingBatch.minSeq, seq);
			for (const ev of events) {
				w.pending.push(ev);
				w.pendingIds.add(ev.id);
			}
			// The newest run's state covers everything pending.
			if (state && (!w.pendingState || state.seq > w.pendingState.seq)) w.pendingState = state;
			if (!w.batchTimer && w.pending.length) {
				w.batchTimer = setTimeout(() => void flushBatch(w), batchMs);
				w.batchTimer.unref?.();
			}
		}

		/** Nothing of this watcher's is waiting to be delivered. */
		const idle = (w: Runtime) => !w.pending.length && !w.flushing && !w.pendingIds.size && !w.batches.size && !outbox.some((o) => o.w === w);

		// ── polling ──

		function schedule(w: Runtime, ms: number) {
			if (w.timer) clearTimeout(w.timer);
			if (!started) return;
			w.timer = setTimeout(() => void poll(w), ms);
			w.timer.unref?.();
		}

		function failure(w: Runtime, reason: string) {
			w.lastError = reason;
			w.backoffMs = nextBackoff(w.backoffMs);
			const t = now();
			if (w.errorPostedAt === undefined || t - w.errorPostedAt >= ERROR_POST_EVERY_MS) {
				w.errorPostedAt = t;
				try {
					send({ w, note: `[watch ${w.cfg.id}] error: ${reason}; retrying with backoff (/watchers for details)` });
				} catch {
					// the reason is in /watchers
				}
			}
			schedule(w, w.backoffMs);
		}

		const lockInfo = (): LockInfo => ({ pid: process.pid, startedAt: now(), instance });
		const alive = opts.alive ?? lockOwnerAlive;

		/** Hold the lock, or learn who does. A dead holder's lock is taken over. */
		function ensureHolder(w: Runtime, force = false): boolean {
			if (w.holder && holdsLock(w.dir, instance)) return true;
			const r = acquireLock(w.dir, lockInfo(), { force, alive });
			w.holder = r.ok;
			w.heldBy = r.ok ? undefined : r.holder;
			return r.ok;
		}

		async function poll(w: Runtime) {
			w.timer = undefined;
			if (!started || runtimes.get(w.cfg.id) !== w) return;
			if (w.paused || w.problem) return;
			try {
				await pollOnce(w);
			} catch (e) {
				if (started && runtimes.get(w.cfg.id) === w) failure(w, `poll failed: ${errText(e)}`);
			}
		}

		async function pollOnce(w: Runtime) {
			if (!ensureHolder(w)) return schedule(w, w.cfg.intervalMs);
			if (w.running) return schedule(w, w.cfg.intervalMs);
			// Re-checked before every run: the script or its folder may have changed since start.
			const problem = commandProblem(w.cfg.command[0] as string);
			if (problem) return failure(w, problem);
			// One run in the folder at a time, even when a takeover overlaps a run still in flight elsewhere.
			if (!acquireRunLock(w.dir, lockInfo(), { now: now(), alive })) return schedule(w, w.cfg.intervalMs);
			w.running = true;
			const started_ = now();
			const seq = ++w.runSeq;
			let r: Awaited<ReturnType<typeof runScript>>;
			let next: Buffer | undefined;
			try {
				clearNext(w.dir);
				r = await runScript(w.cfg, { cwd: ctxRef?.cwd ?? process.cwd(), stateDir: w.dir, timeoutMs: opts.runTimeoutMs, env, children });
				// Take the run's state before the run lock goes, so no other run can clear it.
				if (!r.error && r.code === 0) next = takeNext(w.dir);
				else clearNext(w.dir);
			} finally {
				w.running = false;
				releaseRunLock(w.dir, instance);
			}
			if (!started || runtimes.get(w.cfg.id) !== w) return;
			w.lastRunAt = started_;
			w.stderrTail = r.stderrTail;
			if (r.error || r.code !== 0) return failure(w, r.error ?? `exit ${r.code}`);
			const out = parseOutput(r.stdout, w.cfg.urlHosts, w.cfg.repos);
			if (out.fatal) return failure(w, out.fatal);
			// Taken over during the run: commit nothing, send nothing.
			if (!holdsLock(w.dir, instance)) {
				w.holder = false;
				return schedule(w, w.cfg.intervalMs);
			}
			w.contractErrors += out.errorCount;
			w.lastOkAt = started_;
			w.lastError = undefined;
			w.backoffMs = 0;
			const state = next ? { seq, data: next } : undefined;
			// A run that completes with nothing in flight saw every undelivered event again (none is
			// pending or seen), so commits are safe from here on.
			if (idle(w)) w.dirty = false;
			const fresh = out.events.map((e) => forceInfo(e, w.cfg.me)).filter((e) => !w.seen.has(e.id) && !w.pendingIds.has(e.id));
			const host = readHost(w.dir);
			const backlog = host.lastPollAt === undefined || started_ - host.lastPollAt > BACKLOG_AFTER_MS;
			writeHost(w.dir, { lastPollAt: started_ });
			if (backlog && fresh.length) {
				// First run, or away a long while: one count, not a flood.
				const ids = [...new Set(fresh.map((e) => e.id))];
				const batch: Batch = { minSeq: seq };
				w.batches.add(batch);
				send({
					w,
					batch,
					note: `[watch ${w.cfg.id}] ${ids.length} event${ids.length === 1 ? "" : "s"} since ${host.lastPollAt === undefined ? "the first check" : "the last check over an hour ago"}; caught up, not listed.`,
					seenIds: ids,
					state,
				});
			} else if (fresh.length) enqueue(w, dedupeIds(fresh), seq, state);
			// Nothing new: commit now, or once the earlier batches still in flight are delivered.
			else tryCommit(w, state);
			schedule(w, w.cfg.intervalMs);
		}

		// ── lifecycle ──

		function teardown() {
			started = false;
			for (const w of runtimes.values()) {
				if (w.timer) clearTimeout(w.timer);
				if (w.batchTimer) clearTimeout(w.batchTimer);
				w.timer = w.batchTimer = undefined;
				// Whatever is in flight won't be delivered by this runtime.
				w.batches.clear();
				w.pendingBatch = undefined;
				drop(w, undefined);
				releaseLock(w.dir, instance);
				releaseRunLock(w.dir, instance);
			}
			killAll(children);
			// Undelivered batches go; their script state was never committed and their ids never
			// marked seen, so the next run brings them again.
			outbox = [];
			compacting = false;
			runtimes = new Map();
			if (reg.host?.instance === instance) reg.host = undefined;
		}

		function start(ctx: ExtensionContext, reason?: string) {
			// Idempotent: whatever ran before (a missed shutdown, a reload) goes first.
			reg.host?.teardown();
			ctxRef = ctx;
			instance = randomUUID();
			started = true;
			compacting = false;
			reg.host = { instance, teardown };
			// Session wake counts survive a /reload (same session); new, resume and fork start over.
			const carried = reason === "reload" ? reg.sessionWakes : undefined;
			reg.sessionWakes = new Map();
			config = loadConfig(opts.configPath ?? defaultConfigPath(env));
			if (config.error) notify(`watchers · ${config.error}`, "warning");
			for (const warning of config.warnings) notify(`watchers · ${warning}`, "warning");
			const root = opts.stateRoot ?? defaultStateRoot(env);
			for (const cfg of config.watchers) {
				if (!matchesCwd(cfg.matchCwd, ctx.cwd)) continue;
				const dir = ensureDir(join(root, cfg.id));
				const w: Runtime = {
					cfg,
					dir,
					seen: new SeenStore(dir).load(now()),
					problem: commandProblem(cfg.command[0] as string),
					paused: false,
					holder: false,
					running: false,
					pending: [],
					pendingIds: new Set(),
					batches: new Set(),
					dirty: false,
					flushing: 0,
					runSeq: 0,
					committedSeq: 0,
					backoffMs: 0,
					contractErrors: 0,
					sessionWakes: carried?.get(cfg.id) ?? [],
					recent: [],
					secretNotified: false,
				};
				reg.sessionWakes.set(cfg.id, w.sessionWakes);
				runtimes.set(cfg.id, w);
				if (w.problem) {
					notify(`watchers · ${cfg.id}: ${w.problem}; not running`, "warning");
					continue;
				}
				ensureHolder(w);
				schedule(w, 0);
			}
			pi.events.emit("meeting:query", {});
		}

		pi.events.on("meeting:state", (data) => {
			meeting = !!(data as { active?: boolean } | undefined)?.active;
		});

		pi.on("session_start", (e, ctx) => {
			if (!shouldStart(ctx.mode, env)) return;
			start(ctx, (e as { reason?: string } | undefined)?.reason);
		});

		pi.on("session_shutdown", () => {
			if (started) teardown();
			ctxRef = undefined;
		});

		pi.on("session_before_compact", () => {
			if (started) compacting = true;
		});
		const endCompaction = () => {
			if (!compacting) return;
			compacting = false;
			flushOutbox();
		};
		pi.on("session_compact", endCompaction);
		pi.on("session_compact_failed", endCompaction);

		// ── commands ──

		const clock = (t?: number) => (t ? new Date(t).toTimeString().slice(0, 5) : "never");

		function statusLine(w: Runtime): string {
			const t = now();
			const g = guardian.statsFor(w.cfg.id);
			const role = w.problem ? `disabled (${w.problem})` : w.paused ? "paused" : w.holder ? "polling" : w.heldBy ? `held by pid ${w.heldBy.pid}` : "waiting for the lock";
			const judge = resolveJudge();
			return [
				`${w.cfg.id} · ${role}`,
				`  last run ${clock(w.lastRunAt)}${w.lastError ? ` · error: ${w.lastError}` : w.lastOkAt ? " · ok" : ""}${w.backoffMs ? ` · backoff ${Math.round(w.backoffMs / 1000)}s` : ""}${w.stderrTail && w.lastError ? ` · stderr: ${w.stderrTail}` : ""}`,
				`  contract errors ${w.contractErrors} · seen ${w.seen.size} · wakes ${w.sessionWakes.filter((x) => t - x < 3_600_000).length}/${WAKES_PER_HOUR} session, ${readWakes(w.dir, t).length}/${WAKES_PER_HOUR} watcher (last hour)`,
				`  guardian ${judge.model ? `judge ${judge.model} (${judge.reason})` : `unavailable (${judge.reason})`} · calls ${g.calls} (${guardian.callsLastHour(w.cfg.id)}/${config?.guardian.callsPerHour ?? 200} this hour) · failures ${g.failures} · capped ${g.capped} · cache hits ${g.cacheHits} · secrets ${g.secrets} · withheld ${g.withheld}`,
			].join("\n");
		}

		function recentFor(w: Runtime, ctx: ExtensionContext): Delivered[] {
			const out: Delivered[] = [];
			try {
				for (const e of ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; details?: { watcher?: string; events?: Delivered[] } }>) {
					if (e.type === "custom_message" && e.customType === MSG_TYPE && e.details?.watcher === w.cfg.id) out.push(...(e.details.events ?? []));
				}
			} catch {
				// no session manager: the in-memory list below
			}
			return (out.length ? out : w.recent).slice(-SHOW_LIMIT);
		}

		const showLine = (d: Delivered) =>
			[`${d.kind === "act" ? "[act] " : ""}${d.text}`, d.title ? `title: "${d.title}"` : "", d.excerpt ? `excerpt: "${d.excerpt}"` : "", d.url ?? ""].filter(Boolean).join(" · ");

		async function dryRun(w: Runtime, ctx: ExtensionContext): Promise<string> {
			if (w.problem) return `${w.cfg.id}: ${w.problem}`;
			const dir = dryRunDir(w.dir);
			try {
				const r = await runScript(w.cfg, { cwd: ctx.cwd, stateDir: dir, dryRun: true, timeoutMs: opts.runTimeoutMs, env, children });
				if (r.error || r.code !== 0) return `${w.cfg.id} test: ${r.error ?? `exit ${r.code}`}${r.stderrTail ? ` · stderr: ${r.stderrTail}` : ""}`;
				const out = parseOutput(r.stdout, w.cfg.urlHosts, w.cfg.repos);
				if (out.fatal) return `${w.cfg.id} test: ${out.fatal}`;
				const lines = out.events.map((e0) => {
					const e = forceInfo(e0, w.cfg.me);
					const seen = w.seen.has(e.id) ? " (seen)" : "";
					const extra = [e.title ? "title" : "", e.untrusted ? "excerpt" : ""].filter(Boolean).join("+");
					return `- ${e.kind === "act" ? "[act] " : ""}${textFor(e)}${extra ? ` · has ${extra} (guarded on delivery)` : ""}${seen}`;
				});
				return [`${w.cfg.id} test (dry run, nothing committed): ${out.events.length} events, ${out.errorCount} dropped${out.errors.length ? ` (${[...new Set(out.errors)].join(", ")})` : ""}`, ...lines].join("\n");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}

		pi.registerCommand("watchers", {
			description: "Background watchers: status, pause|resume|test|show|takeover <id>",
			getArgumentCompletions: (prefix: string) => {
				const subs = ["pause", "resume", "test", "show", "takeover"];
				const [sub, rest] = prefix.split(/\s+/, 2);
				if (rest !== undefined && subs.includes(sub ?? "")) {
					const ids = [...runtimes.keys()].filter((id) => id.startsWith(rest));
					return ids.length ? ids.map((id) => ({ value: `${sub} ${id}`, label: id })) : null;
				}
				const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: `${s} `, label: s }));
				return items.length ? items : null;
			},
			handler: async (args, ctx) => {
				const say = (msg: string, level: "info" | "warning" = "info") => ctx.ui.notify(msg, level);
				const [sub = "", id = ""] = args.trim().split(/\s+/);
				if (!started) return say("watchers run only in interactive sessions (not print, json or subagent children).", "warning");
				if (!sub) {
					const lines = [...runtimes.values()].map(statusLine);
					const other = (config?.watchers ?? []).filter((c) => !runtimes.has(c.id)).map((c) => `${c.id} · not for this folder`);
					const head = config?.missing ? `no config at ${config.path}` : config?.error ? `config error: ${config.error}` : "";
					return say([head, ...(config?.warnings ?? []), ...lines, ...other].filter(Boolean).join("\n") || "No watchers configured.");
				}
				const w = runtimes.get(id);
				if (!w) return say(`No watcher "${id}" for this folder. /watchers lists them.`, "warning");
				switch (sub) {
					case "pause":
						w.paused = true;
						if (w.timer) clearTimeout(w.timer);
						w.timer = undefined;
						return say(`${id} paused.`);
					case "resume":
						w.paused = false;
						w.backoffMs = 0;
						schedule(w, 0);
						return say(`${id} resumed.`);
					case "test":
						return say(await dryRun(w, ctx));
					case "show": {
						const list = recentFor(w, ctx);
						return say(list.length ? [`${id} · last ${list.length} events (untrusted external data)`, ...list.map(showLine)].join("\n") : `${id}: nothing delivered yet.`);
					}
					case "takeover": {
						const before = readLock(w.dir);
						ensureHolder(w, true);
						if (!w.paused && !w.problem) schedule(w, 0);
						return say(`${id}: polling from this session${before && before.instance !== instance ? ` (took over from pid ${before.pid})` : ""}.`);
					}
					default:
						return say("Usage: /watchers [pause|resume|test|show|takeover <id>]", "warning");
				}
			},
		});

		// For tests: a peek at the host.
		return {
			get runtimes() {
				return runtimes;
			},
			get outbox() {
				return outbox;
			},
			get started() {
				return started;
			},
			get instance() {
				return instance;
			},
			children,
			guardian,
		};
	};
}

function dedupeIds(events: WatchEvent[]): WatchEvent[] {
	const seen = new Set<string>();
	return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

export default optIn(
	"watchers",
	"Background watchers (scripts in watchers.toml) that post guarded status lines and wake the agent for actionable events",
	(pi) => {
		createWatchers()(pi);
	},
);
