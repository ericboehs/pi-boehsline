/**
 * /icon: parse, complete, refuse when Botsun isn't connected, and send the icon line.
 * A temp Unix socket stands in for Botsun. HOME is a temp dir, so nothing here touches
 * the real owner socket or the real pi sessions.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { iconCompletions, iconLineFields, parseIconArgs, takeCatalog, takeLookNotes } from "../extensions/opt-in/botsun-owner/icon.ts";
import { namingCatalog, suggestIcon } from "../lib/icon-suggestion.ts";
import { stubPi } from "./helpers/stub-pi.mjs";

const home = mkdtempSync(join(tmpdir(), "botsun-icon-"));
process.env.HOME = home;
process.env.BOEHSLINE_CONFIG = join(home, "boehsline.json");
process.env.XDG_STATE_HOME = join(home, "state");
process.env.BOTSUN_OWNER_RETRY_MS = "50";
delete process.env.BOTSUN_OWNER_DEBUG;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
// This suite may itself run under pi as a subagent's child; botsun-owner registers nothing there.
delete process.env.PI_SUBAGENT_CHILD;
after(() => rmSync(home, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CATALOG = {
	v: 1,
	type: "icons",
	shapes: ["heart", "ghost"],
	sets: { hyrule: ["fairy"] },
	colors: ["pink", "mint"],
	look: null,
};
// What each look draws (#21's auto-name picks by it): a page of the set, first and last.
const LOOKS = { v: 1, type: "looks", first: true, last: true, looks: { heart: "a heart", "hyrule.fairy": "a tiny winged fairy" } };

test("a looks page is taken whole, and only in Botsun's own shapes", () => {
	assert.deepEqual({ ...takeLookNotes(LOOKS) }, { heart: "a heart", "hyrule.fairy": "a tiny winged fairy" });
	assert.equal(takeLookNotes({ looks: {} }), null, "an empty page");
	assert.equal(takeLookNotes({ looks: { "Hyrule.Fairy": "a fairy" } }), null, "a look's name is as Botsun sends it: lowercase, at most one dot");
	assert.equal(takeLookNotes({ looks: { heart: "a\rheart" } }), null, "a word is one line of plain text");
	assert.equal(takeLookNotes({ looks: { heart: "a\u202eheart" } }), null, "and never a direction mark");
	assert.equal(takeLookNotes({ looks: { heart: "x".repeat(81) } }), null, "nor longer than a page has room for");
	assert.equal(takeLookNotes({ looks: ["heart"] }), null);
	assert.equal(takeLookNotes({}), null);
});

test("parseIconArgs: pick, set, keep color, clear, and a bad line", () => {
	assert.deepEqual(parseIconArgs(""), { kind: "pick" });
	assert.deepEqual(parseIconArgs("   "), { kind: "pick" });
	assert.deepEqual(parseIconArgs("auto"), { kind: "clear" });
	assert.deepEqual(parseIconArgs("off"), { kind: "clear" });
	assert.equal(parseIconArgs("auto pink").kind, "bad");
	assert.deepEqual(parseIconArgs("Heart"), { kind: "set", look: "heart" });
	assert.deepEqual(parseIconArgs("hyrule.fairy mint"), { kind: "set", look: "hyrule.fairy", color: "mint" });
	assert.equal(parseIconArgs("heart pink extra").error, "usage: /icon [look] [color]");
	assert.equal(parseIconArgs("../x").error, "unknown look");
	assert.deepEqual(iconLineFields({ kind: "clear" }), { clear: true });
	assert.deepEqual(iconLineFields({ kind: "set", look: "heart" }), { look: "heart" });
	assert.deepEqual(iconLineFields({ kind: "set", look: "heart", color: "pink" }), { look: "heart", color: "pink" });
});

test("completions come from the catalog, and auto and off need none", () => {
	const catalog = takeCatalog(CATALOG);
	assert.ok(catalog);
	assert.deepEqual(takeCatalog({ shapes: ["Heart"], sets: { hyrule: ["fairy"] }, colors: ["pink"] }), null, "a look Botsun didn't send in its own form");
	// A name keeps its hyphen or underscore: the whole catalog is still taken.
	const hyphen = takeCatalog({ shapes: ["heart-block"], sets: { set_1: ["a-b", "c_d"] }, colors: ["pink"] });
	assert.ok(hyphen, "a hyphen or an underscore in a name keeps the catalog");
	assert.deepEqual([...hyphen.shapes, ...Object.keys(hyphen.sets), ...hyphen.sets.set_1], ["heart-block", "set_1", "a-b", "c_d"]);
	assert.equal(takeCatalog({ shapes: ["heart"], sets: { "set.1": ["a"] }, colors: ["pink"] }), null, "a dot is a look's separator, not a set's");
	const none = iconCompletions("", null).map((c) => c.value);
	assert.deepEqual(none, ["auto", "off"]);
	const looks = iconCompletions("h", catalog).map((c) => c.value);
	assert.deepEqual(looks, ["heart", "hyrule.fairy"]);
	assert.deepEqual(iconCompletions("heart ", catalog).map((c) => c.value), ["heart pink", "heart mint"]);
	assert.deepEqual(iconCompletions("heart m", catalog).map((c) => c.label), ["mint"]);
	assert.deepEqual(iconCompletions("auto ", catalog), []);
	assert.deepEqual(iconCompletions("nope ", catalog), []);
});

test("/icon needs Botsun when nothing is connected, and sends the line when it is", async () => {
	const lines = [];
	// A /icon whose answer is held back, so a suggestion can be offered while one is in flight.
	let hold = false;
	const held = [];
	const answerTo = (msg) => ({ v: 1, type: "icon", id: msg.id, ok: msg.look !== "nope", look: msg.look ?? null, color: msg.color,
		error: msg.look === "nope" ? "unknown look" : undefined });
	let sock;
	const path = join(home, "owner.sock");
	const srv = createServer((c) => {
		sock = c;
		let buf = "";
		c.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const msg = JSON.parse(buf.slice(0, i));
				lines.push(msg);
				buf = buf.slice(i + 1);
				if (msg.type === "hello") {
					c.write(`${JSON.stringify(CATALOG)}\n`);
					c.write(`${JSON.stringify(LOOKS)}\n`);
				}
				if (msg.type !== "icon") continue;
				if (hold) {
					held.push(msg);
					continue;
				}
				c.write(`${JSON.stringify(answerTo(msg))}\n`);
			}
		});
	});
	await new Promise((r) => srv.listen(path, r));
	process.env.BOTSUN_OWNER_SOCK = path;
	process.env.BOEHSLINE_ENABLE = "botsun-owner";
	const mod = await import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
	const s = stubPi();
	s.pi.getSessionName = () => undefined;
	await mod.default(s.pi);
	const notes = [];
	const ctx = {
		cwd: "/tmp/work/proj",
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionFile: () => "/tmp/sessions/a.jsonl", getSessionId: () => "sid-a" },
		ui: {
			notify: (text, level) => notes.push([level, text]),
			select: async (title, options) => {
				notes.push(["select", title, options]);
				return title === "Session icon" ? "heart" : "keep color";
			},
			setStatus: () => {},
			setWidget: () => {},
		},
	};
	const icon = s.commands.get("icon");
	assert.ok(icon, "the command is registered");
	await icon.handler("", ctx);
	assert.deepEqual(notes, [["error", "/icon needs Botsun"]]);

	await s.fire("session_start", { reason: "startup" }, ctx);
	await until(() => lines.some((l) => l.type === "hello"));
	// This pi picks a look with a session's name: its hello says so, or the host sends no words.
	assert.ok(lines.find((l) => l.type === "hello").features.includes("look_notes"));
	// The catalog is written as the hello arrives. Wait until the command can see it.
	await until(() => icon.getArgumentCompletions("h").some((c) => c.value === "heart"));
	assert.equal(mod.sessionIcon()?.look ?? null, null, "nothing saved: the catalog's look is null");
	// #21: what the namer picks from, with the words the host sent and none for a look it didn't.
	await until(() => namingCatalog()?.looks?.some((l) => l.about === "a tiny winged fairy"));
	assert.deepEqual(namingCatalog(), {
		looks: [{ id: "heart", about: "a heart" }, { id: "ghost" }, { id: "hyrule.fairy", about: "a tiny winged fairy" }],
		colors: ["pink", "mint"],
	});

	notes.length = 0;
	await icon.handler("nope pink", ctx);
	assert.equal(notes.at(-1)[1], "unknown look");
	const sent = lines.find((l) => l.type === "icon" && l.look === "nope");
	assert.equal(sent.color, "pink");
	assert.match(sent.id, /^[0-9a-f]{16}$/);
	assert.equal(sent.clear, undefined);

	notes.length = 0;
	await icon.handler("", ctx);
	assert.equal(notes.at(-1)[1], "icon: heart");
	const picked = lines.find((l) => l.type === "icon" && l.look === "heart");
	assert.equal(picked.color, undefined, "keep color omits it");
	assert.deepEqual(mod.sessionIcon(), { look: "heart", color: null });

	notes.length = 0;
	await icon.handler("ghost mint", ctx);
	const direct = lines.find((l) => l.type === "icon" && l.look === "ghost");
	assert.equal(direct.color, "mint");
	assert.equal(notes.at(-1)[1], "icon: ghost, mint");
	assert.deepEqual(mod.sessionIcon(), { look: "ghost", color: "mint" });

	notes.length = 0;
	await icon.handler("auto", ctx);
	const cleared = lines.find((l) => l.type === "icon" && l.clear === true);
	assert.ok(cleared);
	assert.equal(cleared.look, undefined);
	assert.equal(notes.at(-1)[1], "icon: automatic");
	assert.deepEqual(mod.sessionIcon(), { look: null, color: null });

	// #21: auto-session-name's look and color go out as a suggestion (if_unset), so Botsun stores
	// one only while nothing is saved there, and never over a pick.
	const icons = () => lines.filter((l) => l.type === "icon");
	const before = icons().length;
	assert.equal(suggestIcon({ look: "heart", color: "pink" }), true);
	await until(() => icons().length > before);
	const suggestion = icons().at(-1);
	assert.deepEqual([suggestion.look, suggestion.color, suggestion.if_unset], ["heart", "pink", true]);
	assert.match(suggestion.id, /^[0-9a-f]{16}$/);

	const unsent = icons().length;
	suggestIcon({ look: "nope", color: "plaid" });
	await sleep(60);
	assert.equal(icons().length, unsent, "a look or color Botsun doesn't offer is never sent");

	// A /icon of this session's own on its way: a suggestion waits for it rather than racing it.
	hold = true;
	const awaited = icon.handler("hyrule.fairy", ctx);
	await until(() => held.length === 1);
	const inFlight = icons().length;
	suggestIcon({ look: "heart", color: "pink" });
	await sleep(60);
	assert.equal(icons().length, inFlight, "a pick in flight is not raced");
	hold = false;
	sock.write(`${JSON.stringify(answerTo(held[0]))}\n`);
	await awaited;

	await icon.handler("ghost mint", ctx); // a pick of this session's own
	const afterPick = icons().length;
	suggestIcon({ look: "hyrule.fairy", color: "pink" });
	await sleep(60);
	assert.equal(icons().length, afterPick, "a saved look is a pick: a suggestion never covers one");

	await s.fire("session_shutdown", { reason: "quit" });
	assert.equal(suggestIcon({ look: "heart" }), false, "nothing takes a suggestion after shutdown");
	sock?.destroy();
	await new Promise((r) => srv.close(() => r()));
});

async function until(check, ms = 2000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await sleep(10);
	}
	assert.fail("timed out waiting");
}

/** A conn waiting on an icon line: the module's answer path only touches these fields. */
function waiting(id) {
	const out = [];
	const timer = setTimeout(() => {}, 60_000);
	timer.unref();
	return { conn: { iconWait: { id, timer, resolve: (reply) => out.push(reply) } }, out };
}

async function mount() {
	process.env.BOEHSLINE_ENABLE = "botsun-owner";
	return import(`../extensions/opt-in/botsun-owner/index.ts?t=${Math.random()}`);
}

// Another connection's answer, or a replay, says nothing about this command: only the id it sent
// is taken. What an answer says the look is is checked against the catalog, as the icons line is.
// The wire is any same-user process on the owner socket, so its text is never shown as it came.
test("an icon answer is taken only for its own id, and what it says is checked", async () => {
	const mod = await mount();
	const { conn, out } = waiting("ab".repeat(8));
	const answer = (over) => JSON.stringify({ v: 1, type: "icon", id: conn.iconWait.id, ok: true, look: "heart", ...over });
	assert.equal(mod.serverLine(conn, answer({ id: "cd".repeat(8) })), false, "another id is not this command's answer");
	assert.deepEqual(out, []);
	assert.ok(conn.iconWait, "a wrong id leaves the wait where it was");

	conn.icons = { shapes: ["ghost"], sets: {}, colors: ["pink"] };
	assert.equal(mod.serverLine(conn, answer({ look: "heart", color: "plaid" })), true);
	assert.deepEqual(out, [{ ok: true, look: null, color: null, unset: false, cleared: false }], "neither is in the catalog");
	assert.deepEqual(conn.icon, { look: null, color: null });

	const valid = waiting("ef".repeat(8));
	valid.conn.icons = { shapes: ["heart"], sets: { hyrule: ["fairy"] }, colors: ["pink"] };
	assert.equal(mod.serverLine(valid.conn, JSON.stringify({ v: 1, type: "icon", id: "ef".repeat(8), ok: true, look: "hyrule.fairy", color: "pink" })), true);
	assert.deepEqual(valid.out, [{ ok: true, look: "hyrule.fairy", color: "pink", unset: false, cleared: false }]);
});

test("an icon answer's error is stripped of control and bidi characters, and capped", async () => {
	const mod = await mount();
	const refused = (error) => {
		const { conn, out } = waiting("ab".repeat(8));
		assert.equal(mod.serverLine(conn, JSON.stringify({ v: 1, type: "icon", id: "ab".repeat(8), ok: false, error })), true);
		return out[0];
	};
	const BAD = /[\p{Cc}\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

	const stripped = refused(`\u001b[2Jbad\u202e\r\n${"x".repeat(200)}`);
	assert.equal(stripped.ok, false);
	assert.equal(stripped.error.length, 80, "one TUI line long");
	assert.equal(BAD.test(stripped.error), false, "no control or direction character survives");
	assert.match(stripped.error, /^\[2Jbadx+$/, "the plain text is kept, in order");
	assert.equal(refused(`\u0000\u202e\u2066`).error, "Botsun refused the icon", "nothing left to say");
	assert.equal(refused(undefined).error, "Botsun refused the icon");
});
