/**
 * Program status (OSC 7501) tests.
 *
 * The encoder must produce exactly what pi-tui's does (a terminal that accepts
 * one accepts the other), the tmux wrapper must double every ESC, and
 * tmux-attention's `programStatus` setting must report pi's state through tmux
 * only when tmux forwards it and pi isn't already reporting.
 *
 *   npm test -- test/program-status.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatProgramStatus as piFormat } from "@earendil-works/pi-tui";
import { withBlocked } from "../lib/blocked.ts";
import { formatProgramStatus, passthroughAllowed, setTerminalSink, tmuxPassthrough } from "../lib/program-status.ts";

const decode = (sequence) => {
	const m = /^\x1b\]7501;(.*)\x1b\\$/.exec(sequence);
	assert.ok(m, `not a 7501 report: ${JSON.stringify(sequence)}`);
	return Object.fromEntries(
		m[1].split(":").map((pair) => {
			const [k, ...rest] = pair.split("=");
			const v = rest.join("=");
			return [k, k === "msg" ? Buffer.from(v, "base64").toString("utf8") : v];
		}),
	);
};

test("the encoder matches pi-tui's, field for field", () => {
	const reports = [
		{ state: "idle" },
		{ state: "working", app: "pi" },
		{ state: "working", app: "pi", message: "Compacting context" },
		{ state: "blocked", kind: "question", app: "pi", message: "Answer the agent's question" },
		{ state: "blocked", kind: "permission", message: "Allow bash?" },
		{ state: "blocked", kind: "auth", app: "pi", message: "Log in to GitHub" },
		{ state: "done", app: "pi", message: "wt-program-status" },
		{ state: "error", app: "pi", message: "quota exceeded" },
		{ state: "clear" },
		// Ignored, as the spec says: a bad app name, and a kind outside blocked.
		{ state: "working", app: "has spaces here", message: "x" },
		{ state: "working", app: "a".repeat(33) },
		{ state: "done", kind: "question", app: "pi" },
		// Control characters would end the OSC early, so they become spaces.
		{ state: "blocked", kind: "question", app: "pi", message: "Allow\x1b]0;evil\x07?\nrm -rf /" },
		// Bytes, not characters: the cut never splits a multi-byte character.
		{ state: "done", app: "pi", message: "é".repeat(1200) },
		{ state: "error", app: "pi", message: "😀".repeat(700) },
	];
	for (const report of reports) {
		assert.equal(
			formatProgramStatus(report),
			piFormat(report),
			`differs from pi for ${JSON.stringify(report).slice(0, 80)}`,
		);
	}
});

test("a report never carries a raw ESC past its own terminator", () => {
	const seq = formatProgramStatus({ state: "blocked", kind: "question", app: "pi", message: "a\x1b]0;evil\x07\x9c" });
	assert.equal(seq.match(/\x1b/g).length, 2, "only the introducer's and the terminator's");
	assert.equal(decode(seq).msg, "a ]0;evil");
	assert.equal(seq.includes("\x07"), false, "no BEL reaches the terminal");
});

test("the tmux wrapper doubles every ESC and is a DCS passthrough", () => {
	const inner = formatProgramStatus({ state: "working", app: "pi" });
	const wrapped = tmuxPassthrough(inner);
	assert.ok(wrapped.startsWith("\x1bPtmux;"), "starts with the passthrough introducer");
	assert.ok(wrapped.endsWith("\x1b\\"), "ends with ST, never a doubled one");
	assert.equal(wrapped.slice(7, -2), inner.replaceAll("\x1b", "\x1b\x1b"), "every inner ESC is doubled");
	assert.equal(wrapped.replaceAll("\x1b\x1b", "").match(/\x1b/g)?.length, 2, "the wrapper's own two ESCs");
});

test("only on and all forward a passthrough", () => {
	for (const yes of ["on", "all", "on\n", " all "]) assert.equal(passthroughAllowed(yes), true, yes);
	for (const no of ["off", "", undefined, "1", "always"]) assert.equal(passthroughAllowed(no), false, String(no));
});

test("withBlocked adds the option and keeps the caller's own", () => {
	assert.deepEqual(withBlocked("question", "Ask"), { blocked: { kind: "question", message: "Ask" } });
	assert.deepEqual(withBlocked("auth", "Unlock", { overlay: true }), {
		overlay: true,
		blocked: { kind: "auth", message: "Unlock" },
	});
	const own = { overlayOptions: { width: 40 } };
	assert.equal(withBlocked("permission", "Allow", own).overlayOptions, own.overlayOptions);
	assert.equal("blocked" in own, false, "the caller's object is not mutated");
});

// ── tmux-attention: the passthrough reporter ─────────────────────────────────

/** Write a config with tmux-attention on, and optionally programStatus. */
function configFile({ programStatus } = {}) {
	const path = join(mkdtempSync(join(tmpdir(), "boehsline-status-")), "boehsline.json");
	const block = { enable: ["tmux-attention"] };
	if (programStatus !== undefined) block["tmux-attention"] = { programStatus };
	writeFileSync(path, JSON.stringify(block));
	return path;
}

/**
 * Mount a fresh copy of the extension with a stub pi.
 *
 * A fresh module matters: the pane is read at import, and the setting at mount.
 */
async function mount({ programStatus = true, passthrough = "all" } = {}) {
	process.env.TMUX_PANE = "%9";
	process.env.TMUX = "/tmp/tmux-501/default,123,0";
	process.env.BOEHSLINE_CONFIG = configFile({ programStatus });
	process.env.BOEHSLINE_ENABLE = "tmux-attention";
	const url = new URL("../extensions/opt-in/tmux-attention/index.ts", import.meta.url);
	url.search = `?t=${Math.random()}`;
	const extension = (await import(url.href)).default;

	const handlers = new Map();
	const execCalls = [];
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		exec: async (command, args) => {
			execCalls.push([command, ...args].join(" "));
			if (args[0] === "show-options") return { stdout: passthrough, stderr: "", code: passthrough ? 0 : 1 };
			if (args[0] === "list-panes") return { stdout: "", stderr: "", code: 0 };
			return { stdout: "0", stderr: "", code: 0 };
		},
		events: { on: () => () => {}, emit: () => {} },
	};
	extension(pi);

	// Collect what would reach the terminal. The sink is swapped rather than
	// process.stdout.write patched: under `node --test` this file's results
	// travel on stdout.
	const writes = [];
	setTerminalSink((sequence) => writes.push(sequence));
	const restore = () => setTerminalSink();
	const reports = () =>
		writes.filter((w) => w.includes("\x1bPtmux;")).map((w) => ({ raw: w, ...decode(w.slice(7, -2).replaceAll("\x1b\x1b", "\x1b")) }));
	/** Let the session_start probe's tmux call resolve. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	return {
		reports,
		restore,
		exec: () => execCalls,
		listeners: () => [...handlers.keys()],
		start: async () => {
			handlers.get("session_start")({}, { isIdle: () => true });
			await settle();
		},
		agentStart: () => handlers.get("agent_start")({ type: "agent_start" }),
		reply: (errorMessage) =>
			handlers.get("message_end")({
				type: "message_end",
				message: errorMessage ? { role: "assistant", stopReason: "error", errorMessage } : { role: "assistant", stopReason: "stop" },
			}),
		settled: async (aborted = false) => {
			handlers.get("agent_settled")({ type: "agent_settled", aborted });
			await settle();
		},
		promptStart: (kind = "select", title = "Pick one") =>
			handlers.get("ui_prompt_start")({ type: "ui_prompt_start", kind, title }),
		promptEnd: (kind = "select", title = "Pick one") =>
			handlers.get("ui_prompt_end")({ type: "ui_prompt_end", kind, title }),
		shutdown: () => handlers.get("session_shutdown")(),
	};
}

test("programStatus forwards pi's states through tmux, wrapped for the outer terminal", async () => {
	const pi = await mount();
	try {
		await pi.start();
		assert.deepEqual(pi.reports().map((r) => r.state), ["idle"], "the session's own state first");
		assert.equal(pi.reports()[0].app, "pi");

		pi.agentStart();
		pi.reply();
		await pi.settled();
		assert.deepEqual(pi.reports().map((r) => r.state), ["idle", "working", "done"]);

		pi.promptStart();
		pi.promptEnd();
		assert.deepEqual(
			pi.reports().map((r) => [r.state, r.kind, r.msg]),
			[
				["idle", undefined, undefined],
				["working", undefined, undefined],
				["done", undefined, undefined],
				["blocked", undefined, "Pick one"],
				["done", undefined, undefined],
			],
			"a dialog is blocked with its title, then back to the settled state",
		);

		pi.agentStart();
		pi.reply("quota exceeded\nsecond line");
		await pi.settled();
		assert.deepEqual(pi.reports().at(-1), {
			raw: pi.reports().at(-1).raw,
			state: "error",
			app: "pi",
			msg: "quota exceeded",
		});

		pi.shutdown();
		assert.equal(pi.reports().at(-1).state, "clear", "a departing pi leaves nothing behind");
	} finally {
		pi.restore();
	}
});

test("nothing is written when tmux would drop it, or when the setting is off", async () => {
	const off = await mount({ passthrough: "off" });
	try {
		await off.start();
		off.agentStart();
		await off.settled();
		off.promptStart();
		off.shutdown();
		assert.deepEqual(off.reports(), []);
	} finally {
		off.restore();
	}

	const unset = await mount({ passthrough: "" });
	try {
		await unset.start();
		unset.agentStart();
		assert.deepEqual(unset.reports(), []);
	} finally {
		unset.restore();
	}

	const disabled = await mount({ programStatus: false });
	try {
		await disabled.start();
		disabled.agentStart();
		assert.deepEqual(disabled.reports(), []);
		assert.equal(
			disabled.exec().some((c) => c.includes("allow-passthrough")),
			false,
			"off means no tmux probe at all",
		);
		assert.equal(
			disabled.listeners().some((l) => l === "message_end"),
			false,
			"and no listeners for states nothing reads",
		);
	} finally {
		disabled.restore();
	}
});

test("PI_PROGRAM_STATUS means pi reports for itself, so this stays quiet", async () => {
	process.env.PI_PROGRAM_STATUS = "1";
	try {
		const pi = await mount();
		try {
			await pi.start();
			pi.agentStart();
			assert.deepEqual(pi.reports(), [], "two reporters would double every state");
			assert.equal(pi.exec().some((c) => c.includes("allow-passthrough")), false);
		} finally {
			pi.restore();
		}
	} finally {
		delete process.env.PI_PROGRAM_STATUS;
	}
});

test("the window flag follows the same tracker as the report", async () => {
	const pi = await mount();
	try {
		await pi.start();
		const before = pi.exec().length;
		pi.promptStart("confirm", "Allow bash?");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(
			pi.exec().slice(before).some((c) => c.includes("@special_activity on")),
			"a blocked dialog brightens the window, as the report says blocked",
		);
		assert.equal(pi.reports().at(-1).state, "blocked");

		pi.promptEnd("confirm", "Allow bash?");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(
			pi.exec().slice(before).some((c) => c.includes("-u") && c.includes("@special_activity")),
			"and closing it clears both",
		);
		assert.notEqual(pi.reports().at(-1).state, "blocked");
	} finally {
		pi.restore();
	}
});
