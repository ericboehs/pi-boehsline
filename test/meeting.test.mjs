/**
 * Meeting copilot: transcript parsing, the scout's cadence, prompts and JSON,
 * alerts, the notes file, file picking, the status line and the recap.
 *
 *   bin/pi-ext-check            # typecheck + these tests
 *   node --test .pi-agent/test  # tests only (needs .pi-agent/node_modules)
 */

import "./helpers/acme-settings.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	maskSecrets,
	addressesMe,
	restoreNotes,
	retryWait,
	sameAction,
	actionAlertText,
	buildNotesFile,
	archiveDir,
	meetingId,
	writeNotesArchive,
	buildNotesPrompt,
	buildSystemPrompt,
	CADENCE,
	canClaim,
	clock,
	createLock,
	currentSlide,
	dailyNoteName,
	emptyNotes,
	filterLive,
	filterRecords,
	fitNotesPrompt,
	formatDigest,
	formatLine,
	formatLive,
	formatRec,
	formatSlides,
	formatStatus,
	freshCadence,
	isCandidate,
	isLive,
	isMine,
	isMe,
	isoOffsetMin,
	lastPeople,
	markStopped,
	meetingKey,
	mentionsMe,
	mergeNotes,
	nameAlertText,
	nameMatches,
	nameTokens,
	normText,
	notesPath,
	ocrPath,
	parseArgs,
	parseEvent,
	parseIndex,
	parseLive,
	parseLock,
	parseRecord,
	parseRecords,
	parseScoutReply,
	parseState,
	parseTimeSpec,
	pickNewest,
	pickStartedSince,
	previousTranscript,
	promptLine,
	pushAlert,
	queryMatches,
	readLock,
	readStopped,
	recapBlock,
	recapBody,
	recapMarker,
	releaseLock,
	removeNotesFile,
	replyDue,
	replyText,
	roundedElapsed,
	scaleCadence,
	sessionDigest,
	shouldCall,
	slideCount,
	slideTimes,
	speakerMatches,
	stateReader,
	statusReport,
	stoppedPath,
	takeNameAlert,
	toStamp,
	truncateLines,
	upsertRecap,
	widgetLines,
	writeLock,
	writeNotesFile,
	buildSlidePrompt,
	buildSlideSystem,
	cleanOcr,
	formatSlideSummary,
	markSlideDone,
	nearbyLines,
	newSlideWork,
	noteSlideCall,
	normSlides,
	parseSlideReply,
	queueSlide,
	readArchivedSlides,
	slideDone,
	slideFailed,
	slideGap,
	summaryMatches,
	takeSlide,
	waitForOcr,
	withSummary,
	SLIDE_CAP,
	MAX_SLIDE_SUMMARIES,
	OCR_WAIT_MS,
	normFailed,
	ocrTimeout,
} from "../extensions/opt-in/meeting/index.ts";
import { MEETING_DEFAULTS, meetingSettings } from "../extensions/opt-in/watch/settings.ts";

import { estTokens, PROMPT_MAX_TOKENS } from "../extensions/opt-in/watch/models.ts";

const plain = { fg: (_color, s) => s };


// ── parsing ──

test("parses meeting-capture records into events", () => {
	assert.deepEqual(
		parseEvent(
			'{"app":"Microsoft Teams","meeting":"CORE Weekly Sync","meeting_started_at":"2026-10-05T12:56:53-05:00","type":"metadata"}',
		),
		{ kind: "meta", title: "CORE Weekly Sync", app: "Microsoft Teams", startedAt: "2026-10-05T12:56:53-05:00", stopped: false },
	);
	assert.equal(parseEvent('{"duration":"00:32:14","event":"stopped","type":"metadata"}').stopped, true);
	assert.deepEqual(
		parseEvent('{"speaker":"Tabinda","text":"Most of  you\\ntomorrow.","ts":"2026-10-05T13:30:48-05:00","type":"caption"}'),
		{ kind: "line", ts: "2026-10-05T13:30:48-05:00", speaker: "Tabinda", text: "Most of you tomorrow.", chat: false },
	);
	assert.equal(parseEvent('{"speaker":"Jordan Blake","text":"rofl","ts":"x","type":"chat"}').chat, true);
	assert.deepEqual(parseEvent('{"people":["A","B",3],"type":"people"}'), { kind: "people", people: ["A", "B"] });
});

test("drops records it can't use", () => {
	assert.equal(parseEvent("not json"), null);
	assert.equal(parseEvent('{"type":"caption","text":"   "}'), null);
	assert.equal(parseEvent('{"type":"window"}'), null);
});

test("lines keep the meeting's local clock time", () => {
	assert.equal(clock("2026-10-05T13:04:06-05:00"), "13:04:06");
	assert.equal(
		formatLine({ ts: "2026-10-05T13:04:06-05:00", speaker: "Jordan Blake", text: "rofl", chat: true }),
		"[13:04:06] (chat) Jordan Blake: rofl",
	);
});

test("names match across Teams' Last, First (ORG) format", () => {
	const me = nameTokens("Eric Boehs");
	assert.deepEqual(me, ["eric", "boehs"]);
	assert.ok(isMe("Boehs, Eric (GUILD)", me));
	assert.ok(isMe("Eric Boehs", me));
	assert.ok(!isMe("Eric Smith", me));
	assert.ok(!isMe("Anyone", []));
});

test("a mention needs the whole name part, not a substring", () => {
	const me = nameTokens("Eric Boehs");
	assert.ok(mentionsMe("Eric, what do you think?", me));
	assert.ok(mentionsMe("that's on boehs's list", me));
	assert.ok(!mentionsMe("across America", me));
	assert.ok(!mentionsMe("generic numeric stuff", me));
	assert.ok(!mentionsMe("Erica said she'd send it", me), "Erica is not Eric");
	assert.ok(!mentionsMe("Ericsson's boxes", me));
});

test("a first name another participant shares isn't enough to be addressed", () => {
	const me = nameTokens("Eric Boehs");
	const people = ["Eric Boehs", "Eric Smith", "Ada Lovelace"];
	assert.ok(!addressesMe("Eric, can you own the canary move?", me, people), "which Eric?");
	assert.ok(addressesMe("Eric Boehs, can you own the canary move?", me, people), "the last name settles it");
	assert.ok(addressesMe("Boehs, are you there?", me, people));
	assert.ok(addressesMe("Eric, can you own it?", me, ["Eric Boehs", "Ada Lovelace"]), "only one Eric in the call");
	assert.ok(addressesMe("Eric, can you own it?", me), "no roster, no doubt");
	assert.ok(!addressesMe("Erica, can you own it?", me, people));
	assert.ok(!addressesMe("Eric, can you own it?", me, ["Boehs, Eric (GUILD)", "Smith, Eric Jr (X)"]), "Teams' Last, First format too");
});

// ── slide events ──

test("slides and revisits are events too, for the cadence and the status line", () => {
	assert.deepEqual(parseEvent('{"type":"slide","slide":4,"ts":"2026-10-05T13:00:00-05:00"}'), { kind: "slide", ts: "2026-10-05T13:00:00-05:00", n: 4, revisit: false });
	assert.deepEqual(parseEvent('{"type":"revisit","slide":2,"ts":"t"}'), { kind: "slide", ts: "t", n: 2, revisit: true });
	assert.equal(parseEvent('{"type":"slide","slide":"4"}'), null);
});

// ── when code lets the scout run ──

const cad = (over = {}) => ({ ...freshCadence(), ...over });
const MIN = 60_000;

test("no new lines, nothing to do", () => {
	assert.equal(shouldCall(freshCadence(), 10 * MIN), null);
	assert.equal(shouldCall(cad({ early: true, earlyAt: 1 }), 10 * MIN), null, "an early request waits for a line to send");
});

test("about three minutes of new talk makes a call, not before", () => {
	const t = cad({ unsent: 5, firstUnsentAt: 1_000_000, lastLineAt: 1_000_000 + 2 * MIN + 55_000, lastCallAt: 1_000_000 - 5 * MIN });
	assert.equal(shouldCall(t, 1_000_000 + 2 * MIN + 59_000), null);
	assert.equal(shouldCall(t, 1_000_000 + 3 * MIN), "talk");
});

test("never while a call is in flight", () => {
	const t = cad({ unsent: 5, firstUnsentAt: 1, lastLineAt: 1, lastCallAt: 0, early: true, earlyAt: 1 });
	assert.equal(shouldCall(t, 10 * MIN, { busy: true }), null);
	assert.equal(shouldCall(t, 10 * MIN, { busy: true, final: true }), null);
	assert.equal(shouldCall(t, 10 * MIN), "early");
});

test("a new slide or a name alert calls sooner, once the sentence has landed, at most once a minute", () => {
	const now = 5 * MIN;
	const base = { unsent: 2, firstUnsentAt: now - 20_000, early: true, earlyAt: now - 10_000 };
	assert.equal(shouldCall(cad({ ...base, lastLineAt: now - 1000, lastCallAt: now - 5 * MIN }), now), null, "someone is still talking");
	assert.equal(shouldCall(cad({ ...base, lastLineAt: now - 3000, lastCallAt: now - 5 * MIN }), now), "early");
	assert.equal(shouldCall(cad({ ...base, lastLineAt: now - 3000, lastCallAt: now - 59_000 }), now), null, "the 60 s floor");
	assert.equal(shouldCall(cad({ ...base, lastLineAt: now - 3000, lastCallAt: now - 61_000 }), now), "early");
	// Talk that never pauses doesn't starve it forever.
	assert.equal(shouldCall(cad({ ...base, lastLineAt: now - 100, lastCallAt: 0, earlyAt: now - 16_000 }), now), "early");
});

test("the floor holds for talk too, and the end gets one look at what's left", () => {
	const t = cad({ unsent: 3, firstUnsentAt: 0, lastLineAt: 1, lastCallAt: 10 * MIN - 30_000 });
	assert.equal(shouldCall(t, 10 * MIN), null);
	assert.equal(shouldCall(t, 10 * MIN, { final: true }), "final", "no waiting at the end");
	assert.equal(shouldCall(cad({ lastCallAt: 1 }), 10 * MIN, { final: true }), null, "nothing left, no call");
});

test("a replay scales every wait", () => {
	assert.deepEqual(scaleCadence(1), CADENCE);
	assert.equal(scaleCadence(100).talkMs, 1800);
	assert.ok(scaleCadence(100000).quietMs >= 20);
});

// ── the scout's JSON ──

const full = {
	topics: [{ title: "Cert rotation", summary: "Thursday, owner Amy." }, { title: "Canary", summary: "Legacy services next." }],
	decisions: ["Rotate Thursday"],
	actions: [{ who: "Eric", what: "own moving the legacy services onto canary", mine: true, by: "Ada" }, { who: "Amy", what: "rotate the cert", mine: false }],
	questions: [{ q: "Who signs off before Thursday?", why: "no approver named" }],
	reply: { to: "Katherine", text: "I can have a plan by Friday." },
};

test("reads the notes through fences and prose", () => {
	const u = parseScoutReply(`Sure!\n\`\`\`json\n${JSON.stringify(full)}\n\`\`\`\nHope that helps.`);
	assert.deepEqual(u.topics, full.topics);
	assert.deepEqual(u.decisions, ["Rotate Thursday"]);
	assert.deepEqual(u.actions[0], { who: "Eric", what: "own moving the legacy services onto canary", mine: true, by: "Ada" });
	assert.deepEqual(u.actions[1], { who: "Amy", what: "rotate the cert", mine: false, by: "" });
	assert.deepEqual(u.questions, full.questions);
	assert.deepEqual(u.reply, { to: "Katherine", text: "I can have a plan by Friday." });
});

test("tolerates loose shapes, bounds everything, and rejects what isn't the notes", () => {
	const loose = parseScoutReply('{"topics":["Runner migration"],"decisions":[{"text":"Ship it"}],"actions":["Sam: write the doc"],"questions":["Is Friday firm?"],"reply":"Yes, on track."}');
	assert.deepEqual(loose.topics, [{ title: "Runner migration", summary: "" }]);
	assert.deepEqual(loose.decisions, ["Ship it"]);
	assert.deepEqual(loose.actions, [{ who: "", what: "Sam: write the doc", mine: false, by: "" }]);
	assert.deepEqual(loose.questions, [{ q: "Is Friday firm?", why: "" }]);
	assert.deepEqual(loose.reply, { to: "", text: "Yes, on track." });
	assert.equal(parseScoutReply('{"actions":[{"what":"x","mine":"true"},{"what":"y","mine":"no"}]}').actions.map((a) => a.mine).join(), "true,false");

	const many = parseScoutReply(
		JSON.stringify({
			topics: Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, summary: "x".repeat(900) })),
			questions: ["a?", "b?", "c?", "d?"],
			decisions: Array.from({ length: 30 }, (_, i) => `d${i}`),
			reply: { to: "x".repeat(500), text: "y".repeat(2000) },
		}),
	);
	assert.deepEqual(many.topics.map((t) => t.title), ["t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"], "newest eight, newest last");
	assert.equal(many.topics[0].summary.length, 300);
	assert.equal(many.questions.length, 2, "at most two questions");
	assert.equal(many.decisions.length, 20);
	assert.deepEqual([many.reply.to.length, many.reply.text.length], [80, 500]);

	assert.equal(parseScoutReply("not json"), null);
	assert.equal(parseScoutReply("{}"), null, "no notes keys: not the notes");
	assert.equal(parseScoutReply('{"hello":1}'), null);
	assert.equal(parseScoutReply("[1]"), null);
	assert.deepEqual(parseScoutReply('{"reply":null}').reply, null);
	assert.equal(parseScoutReply('{"reply":{"to":"A","text":" "}}').reply, null);
	assert.equal(parseScoutReply('{"questions":[]}').topics, undefined, "a field left out stays as it was");
});

test("merging keeps the time items were first noted and finds the new actions on you", () => {
	const first = mergeNotes(emptyNotes(), parseScoutReply(JSON.stringify(full)), "T1");
	assert.deepEqual(first.newMine.map((a) => a.what), ["own moving the legacy services onto canary"]);
	assert.equal(first.notes.actions[0].at, "T1");
	assert.deepEqual(first.notes.decisions, [{ text: "Rotate Thursday", at: "T1" }]);

	// The scout repeats everything (reworded punctuation) and adds one: only the new one is new.
	const again = parseScoutReply(
		JSON.stringify({
			...full,
			decisions: ["Rotate Thursday.", "Canary by Q3"],
			actions: [...full.actions.map((a) => ({ ...a, what: `${a.what}.` })), { who: "Eric", what: "send the runbook", mine: true }],
			questions: [],
		}),
	);
	const second = mergeNotes(first.notes, again, "T2");
	assert.deepEqual(second.newMine.map((a) => a.what), ["send the runbook"]);
	assert.deepEqual(second.notes.actions.map((a) => a.at), ["T1", "T1", "T2"]);
	assert.deepEqual(second.notes.decisions.map((d) => d.at), ["T1", "T2"]);
	assert.deepEqual(second.notes.questions, [], "questions are the current ones, not a log");

	// A field the scout left out stays; a duplicate inside one answer counts once.
	const quiet = mergeNotes(second.notes, { reply: null }, "T3");
	assert.deepEqual(quiet.notes, second.notes);
	const dup = mergeNotes(emptyNotes(), { actions: [{ who: "E", what: "Do it", mine: true, by: "" }, { who: "E", what: "do it!", mine: true, by: "" }], reply: null }, "T");
	assert.equal(dup.notes.actions.length, 1);
	assert.equal(dup.newMine.length, 1);
});

test("a reworded action is the same action, and only a move onto Eric is new to him", () => {
	assert.ok(sameAction("own moving the legacy services onto canary", "own migrating legacy services to canary"));
	assert.ok(sameAction("own moving the legacy services onto canary", "Own moving the two legacy services onto canary this week."));
	assert.ok(sameAction("send the runbook", "Send the runbook!"));
	assert.ok(!sameAction("send the runbook", "rotate the cert"));
	assert.ok(!sameAction("rotate the staging cert", "rotate the production cert and update the dashboard"));
	assert.ok(sameAction("own the legacy services", "take the legacy service"), "service and services match");
	for (const [x, y] of [
		["review PR 123", "review PR 124"],
		["update the staging config", "update the production config"],
		["send the deck to Ada", "send the deck to Bob"],
		["write the ATO docs", "review the ATO docs"],
		["file a ticket for the login bug", "file a ticket for the logout bug"],
		["schedule a meeting with security", "schedule a meeting with legal"],
		["review PR 123", "review PR"],
	]) {
		assert.ok(!sameAction(x, y), `${x} / ${y}`);
		assert.ok(!sameAction(y, x), `${y} / ${x}`);
	}
	assert.ok(!sameAction("ship", "ship it"), "one-word actions need to match exactly");

	const first = mergeNotes(emptyNotes(), parseScoutReply(JSON.stringify(full)), "T1");
	const reworded = parseScoutReply(JSON.stringify({ ...full, actions: [{ who: "Eric", what: "own migrating legacy services to canary", mine: true, by: "Ada" }] }));
	const second = mergeNotes(first.notes, reworded, "T2");
	assert.deepEqual(second.newMine, [], "no second alert for the same task in new words");
	assert.equal(second.notes.actions[0].at, "T1", "and it keeps the time it was first noted");
	assert.equal(second.notes.actions[0].what, "own migrating legacy services to canary");

	// First noted for someone else, then moved to Eric with the same text: that is news to him.
	const theirs = mergeNotes(emptyNotes(), { actions: [{ who: "Ada", what: "own the canary move", mine: false, by: "" }], reply: null }, "T1");
	assert.deepEqual(theirs.newMine, []);
	const moved = mergeNotes(theirs.notes, { actions: [{ who: "Eric", what: "own the canary move", mine: true, by: "Ada" }], reply: null }, "T2");
	assert.deepEqual(moved.newMine.map((a) => a.what), ["own the canary move"]);
	assert.equal(moved.notes.actions[0].at, "T1");
});

test("a failed call waits twice as long each time, up to five minutes", () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => retryWait(n) / 60_000), [1, 2, 4, 5, 5, 5, 5]);
	assert.equal(retryWait(0), CADENCE.minGapMs);
	assert.ok(retryWait(9, scaleCadence(10), 10) < 31_000, "a replay shrinks it");
	const now = 10_000_000;
	const t = cad({ unsent: 3, firstUnsentAt: now - 4 * MIN, lastLineAt: now - 4000, lastCallAt: now - 90_000, retryMs: retryWait(2) });
	assert.equal(shouldCall(t, now), null, "the retry wait outlasts the 60 s floor");
	assert.equal(shouldCall({ ...t, lastCallAt: now - 121_000 }, now), "talk");
	assert.equal(shouldCall(t, now, { final: true }), "final", "the last call doesn't wait");
});

// ── what the scout is asked ──

const sys = () => buildSystemPrompt("Eric Boehs", ["eric", "boehs"], "Engineer on CORE.", "## Notes\n- runner");

test("the system prompt carries who he is, the quality bar for questions, the JSON shape and the background", () => {
	const s = sys();
	assert.match(s, /live meeting copilot for Eric Boehs/);
	assert.match(s, /may be called eric or boehs/);
	assert.match(s, /AT MOST 2, and usually none\. Empty is the normal answer/);
	assert.match(s, /grounded in what Eric Boehs is working on \(the session digest, the about text, the slides\)/);
	assert.match(s, /Never generic/);
	assert.match(s, /"mine" is true only when the task is assigned to or taken by Eric Boehs/);
	assert.match(s, /"reply": only when someone is waiting on Eric Boehs right now/);
	assert.match(s, /Update them instead of rewriting/);
	assert.match(s, /"topics": \[\{"title"/);
	assert.match(s, /<about>\nEngineer on CORE\.\n<\/about>/);
	assert.match(s, /<background>\n## Notes/);
	assert.doesNotMatch(buildSystemPrompt("", [], "", ""), /<about>|<background>|may be called/);
});

const branch = [
	{ type: "message", message: { role: "user", content: "first thing" } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } },
	{ type: "custom_message", customType: "meeting", content: "ignored" },
	...Array.from({ length: 6 }, (_, i) => ({ type: "message", message: { role: "user", content: [{ type: "text", text: `user message ${i} ${"w".repeat(400)}` }, { type: "image", data: "x" }] } })),
	{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "text", text: `latest ${"a".repeat(900)}` }, { type: "toolCall", id: "1" }] } },
	{ type: "message", message: { role: "user", content: "   " } },
];

test("the session digest is the last 5 user messages (300 chars) and the last assistant message (600)", () => {
	const d = sessionDigest(branch, "earl");
	assert.equal(d.name, "earl");
	assert.equal(d.user.length, 5);
	assert.deepEqual(d.user.map((u) => u.slice(0, 14)), ["user message 1", "user message 2", "user message 3", "user message 4", "user message 5"]);
	assert.ok(d.user.every((u) => u.length === 300 && u.endsWith("…")));
	assert.equal(d.assistant.length, 600);
	assert.match(d.assistant, /^latest a+…$/);
	assert.deepEqual(sessionDigest([], ""), { name: "", user: [], assistant: "" });
	assert.equal(formatDigest(sessionDigest([], "")), "", "nothing to say, no block");
	assert.match(formatDigest(d), /^<session>\nWhat the user is working on right now, from their pi session "earl":\nTheir last messages:\n- user message 1/);
});

test("the session digest masks secrets and applies the work redact rules, before clipping", () => {
	const mixed = "Zq8vK2mXp4Lr7TnB1cWd9YeH3sJf6GuA"; // 32 mixed-case letters and digits: looks random
	const prefixed = `ghp_${"x7".repeat(18)}`;
	const header = `Bearer ${"abc123".repeat(3)}`;
	const entries = [
		{ type: "message", message: { role: "user", content: `use ${prefixed} and ${header}, key ${mixed}; build EMP123456 fails` } },
		{ type: "message", message: { role: "user", content: "clone https://bob:pw1234@git.example.com/x.git, see extensions/opt-in/meeting/notes-scout-review-notes.ts" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: `sha ${"a1b2c3d4".repeat(5)} done` }] } },
	];
	const d = sessionDigest(entries, "earl", (s) => s.replace(/EMP\d{6}/g, "[EMP]"));
	assert.equal(d.user[0], "use [token] and Bearer [token], key [token]; build [EMP] fails");
	assert.equal(d.user[1], "clone https://[redacted]@git.example.com/x.git, see extensions/opt-in/meeting/notes-scout-review-notes.ts");
	assert.equal(d.assistant, `sha ${"a1b2c3d4".repeat(5)} done`, "a 40-character commit SHA is left alone");
	assert.equal(maskSecrets(`sha ${"a1b2c3d4".repeat(8)}`), "sha [token]", "a longer hex run is still masked");
	const words = "plain-kebab-case-name-that-is-quite-long and CamelCaseIdentifierWithoutDigitsAtAll";
	assert.equal(maskSecrets(words), words, "words and names pass");
	for (const prose of ["skateboarding", "pkgconfiguration", "skip-dependency-resolution-in-ci", "npm-check-updates", "hfrequencytrading", "Basic authentication", "bearer responsibilities", "Bearer authentication", "Basic configuration"]) {
		assert.equal(maskSecrets(`about ${prose} today`), `about ${prose} today`, prose);
	}
	for (const [secret, masked] of [["sk-abcdefghijklmnop", "[token]"], ["glpat" + "-abcdefghij1234567890", "[token]"], ["AKIA" + "ABCDEFGHIJKLMNOP", "[token]"], ["xoxb-123456789012-abcdef", "[token]"], ["npm_abcdefghij1234567890", "[token]"], ["Basic dXNlcjpwYXNz1234", "Basic [token]"]]) {
		assert.equal(maskSecrets(secret), masked, secret);
	}
	assert.equal(sessionDigest([], "").name, "");
});

test("a new instance takes this meeting's notes back (and only this meeting's)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-restore-"));
	const file = path.join(dir, ".meeting-notes.json");
	const saved = process.env.PI_MEETING_NOTES_FILE;
	process.env.PI_MEETING_NOTES_FILE = file;
	try {
		assert.equal(restoreNotes("S"), null, "no file");
		const notes = mergeNotes(emptyNotes(), parseScoutReply(JSON.stringify(full)), "2026-10-28T14:12:00.000Z").notes;
		const alerts = [
			{ id: "a3", kind: "name", who: "Ada", text: "Eric, can you own it?", at: "T" },
			{ id: "a7", kind: "action", who: "Ada", text: "own the second thing", at: "T" },
		];
		writeNotesFile(buildNotesFile({ pid: 1, sessionId: "x", sessionName: "", startedAt: "S", appId: "teams", title: "T", at: "A", ended: false, me: ["eric"], notes, reply: { to: "K", text: "Friday.", at: "R" }, alerts, alertSeq: 12 }));
		assert.equal(restoreNotes("other"), null, "another meeting's notes are not ours");
		const back = restoreNotes("S");
		assert.deepEqual(back.notes.actions.map((a) => a.what), notes.actions.map((a) => a.what));
		assert.equal(back.notes.topics.length, notes.topics.length);
		assert.deepEqual(back.alerts.map((a) => a.id), ["a3", "a7"]);
		assert.equal(back.alertSeq, 12, "ids keep counting");
		assert.deepEqual(back.reply, { to: "K", text: "Friday.", at: "R" });
		assert.ok(back.alerted.has("own moving the legacy services onto canary") && back.alerted.has("own the second thing"));
		// What the restored notes already hold isn't new when the scout repeats it.
		assert.deepEqual(mergeNotes(back.notes, parseScoutReply(JSON.stringify(full)), "T9").newMine, []);
		fs.writeFileSync(file, "not json");
		assert.equal(restoreNotes("S"), null);
	} finally {
		saved === undefined ? delete process.env.PI_MEETING_NOTES_FILE : (process.env.PI_MEETING_NOTES_FILE = saved);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("slide text: newest first, empty ones skipped, capped in all", () => {
	const slides = [
		{ n: 1, at: "14:01:00", text: "Agenda", onScreen: false },
		{ n: 2, at: "14:10:00", text: "  ", onScreen: false },
		{ n: 3, at: "14:14:00", text: "Cert rotation plan\nOwner: Amy", onScreen: true },
	];
	const t = formatSlides(slides);
	assert.match(t, /^<slides>\nWhat the slides shown so far say:\nSlide 3 \(14:14:00\), on screen now:\nCert rotation plan\nOwner: Amy\nSlide 1 \(14:01:00\):\nAgenda\n<\/slides>$/);
	assert.doesNotMatch(t, /Slide 2/);
	assert.equal(formatSlides([]), "");
	const big = formatSlides([{ n: 1, at: "", text: "old ".repeat(2000), onScreen: false }, { n: 2, at: "", text: "x".repeat(3000), onScreen: false }, { n: 3, at: "", text: "y".repeat(3000), onScreen: false }]);
	assert.ok(big.includes("y".repeat(3000)) && big.includes("[… cut]"), "the newest slide is whole, the next is cut at the cap");
	assert.ok(!big.includes("old old"), "nothing older once the cap is spent");
	assert.ok(big.length < 4400, `${big.length} chars`);
});

const notesIn = (over = {}) => ({
	title: "CORE Weekly Sync",
	app: "Teams",
	people: ["Jordan Blake", "Eric Boehs"],
	lines: ["[13:00:00] Jordan Blake: Runner cutover is Friday.", "[13:00:05] Kyle: Pending CSOC.", "[13:00:09] Kyle: Eric, can you own the canary?"],
	newFrom: 0,
	focus: "",
	me: "Eric Boehs",
	now: new Date(2026, 9, 5, 13, 0, 10),
	prev: emptyNotes(),
	...over,
});

test("the user prompt has the meeting, session digest, slides, previous notes and the transcript with the new part marked", () => {
	const first = buildNotesPrompt(notesIn({ digest: sessionDigest(branch, "earl"), slides: [{ n: 3, at: "13:00:00", text: "Cert plan", onScreen: true }], focus: "push for a cutover date" }));
	assert.match(first, /^Meeting: CORE Weekly Sync \(Teams\)\nPeople: Jordan Blake; Eric Boehs\nEric Boehs's goals for this meeting: push for a cutover date\nNow: 13:00:10\n\n<session>/);
	assert.match(first, /<slides>[\s\S]*Cert plan[\s\S]*<\/slides>/);
	assert.match(first, /<previous_notes>\n\(none yet: this is your first look\)\n<\/previous_notes>/);
	assert.match(first, /<transcript>\n\[13:00:00\] Jordan Blake: Runner cutover is Friday\.\n/);
	assert.doesNotMatch(first, /── new since/);
	assert.match(first, /Write the first notes\.$/);

	const prev = mergeNotes(emptyNotes(), parseScoutReply(JSON.stringify(full)), "T").notes;
	const later = buildNotesPrompt(notesIn({ newFrom: 2, prev }));
	assert.match(later, /<previous_notes>\n\{"topics":\[\{"title":"Cert rotation"/);
	assert.match(later, /"actions":\[\{"who":"Eric","what":"own moving the legacy services onto canary","mine":true,"by":"Ada"\}/);
	assert.match(later, /Kyle: Pending CSOC\.\n── new since your last update ──\n\[13:00:09\] Kyle: Eric, can you own the canary\?\n<\/transcript>/);
	assert.match(later, /The lines after "── new since your last update ──" are new since your last update\. Update the notes\.$/);
	assert.doesNotMatch(later, /<session>|<slides>|goals for this meeting/, "left out when empty");
});

test("trimming drops the oldest transcript first and stays under the cap", () => {
	const lines = Array.from({ length: 4000 }, (_, i) => `[10:${String(i % 60).padStart(2, "0")}:00] Speaker ${i % 7}: ${"some words here ".repeat(5)}line ${i}`);
	const p = notesIn({ lines, newFrom: 3990, digest: sessionDigest(branch, "earl"), slides: [{ n: 1, at: "", text: "slide ".repeat(100), onScreen: true }] });
	const system = "s".repeat(120_000); // a big background: ~40k tokens
	const user = fitNotesPrompt(system, p);
	assert.ok(estTokens(system) + estTokens(user) <= PROMPT_MAX_TOKENS, `${estTokens(system) + estTokens(user)} tokens`);
	assert.match(user, /line 3999\n<\/transcript>/, "the newest line stays");
	assert.match(user, /<transcript>\n\[… earlier lines omitted …\]\n/);
	assert.match(user, /── new since your last update ──\n/, "the new part stays marked");
	assert.match(user, /<session>/, "the digest isn't what gets cut");
	assert.ok(estTokens(buildNotesPrompt(p)) > estTokens(user));
	assert.equal(fitNotesPrompt("system", notesIn()), buildNotesPrompt(notesIn()), "a short meeting is untouched");
	assert.match(fitNotesPrompt("s".repeat(120_000), notesIn(), 1000), /<transcript>\n\[… earlier lines omitted …\]\n<\/transcript>/, "even the system prompt too big: the transcript shrinks to its marker");
});

// ── alerts ──

test("one name alert per speaker per two minutes, repeats collapse", () => {
	const last = new Map();
	assert.equal(takeNameAlert(last, "Smith, Ada (ORG)", 1000), true);
	assert.equal(takeNameAlert(last, "Smith, Ada (ORG)", 1000 + 119_000), false, "a repeat inside two minutes");
	assert.equal(takeNameAlert(last, "Alan Turing", 1000 + 5_000), true, "another speaker has their own clock");
	assert.equal(takeNameAlert(last, "Smith, Ada (ORG)", 1000 + 120_000), true, "two minutes later");
	assert.equal(takeNameAlert(last, "Smith, Ada (ORG)", 1000 + 121_000), false, "the clock restarted at the last alert");
	assert.equal(takeNameAlert(new Map(), "", 5), true);
});

test("the alert list keeps the newest 20", () => {
	let list = [];
	for (let i = 0; i < 25; i++) list = pushAlert(list, { id: `a${i}`, kind: "name", who: "A", text: "t", at: "T" });
	assert.deepEqual([list.length, list[0].id, list.at(-1).id], [20, "a5", "a24"]);
});

test("alert messages: a name, an action, and a reply on its own", () => {
	const long = `Eric, can you own moving the legacy services onto canary ${"this quarter and ".repeat(8)}so we can plan?`;
	const clipped = nameAlertText("Ada Lovelace", "14:12:30", long);
	assert.match(clipped, /^🔔 Ada Lovelace said your name \(14:12\): "Eric, can you own moving the legacy services onto canary this quarter and .*…"$/);
	assert.equal(clipped.split('"')[1].length, 140, "the quote is clipped to 140 characters");
	assert.equal(nameAlertText("Ada Lovelace", "14:12:30", "Eric, can you own moving the legacy services?"), '🔔 Ada Lovelace said your name (14:12): "Eric, can you own moving the legacy services?"');
	assert.equal(nameAlertText("Ada", "14:12:30", "Eric?", { to: "Ada", text: "Yes." }), '🔔 Ada said your name (14:12): "Eric?"\n↳ You could say: "Yes."');
	assert.equal(nameAlertText("", "", "Eric"), '🔔 Someone said your name: "Eric"');
	assert.equal(actionAlertText("own moving the legacy services onto canary", "Ada", "14:12:30"), "✅ Action on you: own moving the legacy services onto canary (Ada, 14:12)");
	assert.equal(actionAlertText("send the runbook", "", "14:20"), "✅ Action on you: send the runbook (14:20)");
	assert.equal(actionAlertText("x", "", "", { to: "K", text: "ok" }), '✅ Action on you: x\n↳ You could say: "ok"');
	assert.equal(replyText({ to: "Katherine", text: "I can have it Friday." }), '↳ Katherine is waiting on you. You could say: "I can have it Friday."');
	assert.equal(replyText({ to: "", text: "Sure." }), '↳ Someone is waiting on you. You could say: "Sure."');
});

test("a reply posts once: not the same words again, not another to the same person within two minutes", () => {
	const r = { to: "Katherine", text: "I can have it Friday." };
	assert.equal(replyDue([], r, 0), true);
	const sent = [{ key: normText(r.text), to: normText(r.to), at: 1000 }];
	assert.equal(replyDue(sent, { to: "Alan", text: "I can have it Friday!" }, 1_000_000), false, "same words");
	assert.equal(replyDue(sent, { to: "Katherine", text: "Make it Monday." }, 1000 + 119_000), false, "same person, a rewording");
	assert.equal(replyDue(sent, { to: "Katherine", text: "Make it Monday." }, 1000 + 121_000), true);
	assert.equal(replyDue(sent, { to: "Alan", text: "Make it Monday." }, 2000), true);
	assert.equal(replyDue([], { to: "A", text: "!" }, 0), false, "nothing to say");
});

// ── the notes file ──

test("the notes file has the shape the canvas reads", () => {
	const notes = mergeNotes(emptyNotes(), parseScoutReply(JSON.stringify(full)), "2026-10-28T14:12:00.000Z").notes;
	const file = buildNotesFile({
		pid: 7,
		sessionId: "s-1",
		sessionName: "earl",
		startedAt: "2026-10-28T14:00:00-05:00",
		appId: "teams",
		title: "Weekly Sync",
		at: "2026-10-28T14:13:00.000Z",
		ended: false,
		me: ["eric", "boehs"],
		notes,
		reply: { to: "Katherine", text: "Friday.", at: "2026-10-28T14:12:30.000Z" },
		alerts: Array.from({ length: 22 }, (_, i) => ({ id: `a${i}`, kind: i % 2 ? "action" : "name", who: "Ada", text: "t", at: "T" })),
	});
	assert.deepEqual(Object.keys(file), ["v", "pid", "session", "meeting", "at", "ended", "me", "topics", "decisions", "actions", "questions", "reply", "alerts", "alertSeq", "slides", "slidesOn", "slidesFailed"]);
	assert.deepEqual([file.v, file.pid, file.session, file.meeting], [1, 7, { id: "s-1", name: "earl" }, { started_at: "2026-10-28T14:00:00-05:00", app_id: "teams", title: "Weekly Sync" }]);
	assert.deepEqual(file.actions[0], { who: "Eric", what: "own moving the legacy services onto canary", mine: true, at: "2026-10-28T14:12:00.000Z" });
	assert.deepEqual(file.decisions, [{ text: "Rotate Thursday", at: "2026-10-28T14:12:00.000Z" }]);
	assert.equal(file.alerts.length, 20);
	assert.equal(file.alerts.at(-1).id, "a21");
	assert.deepEqual(file.reply, { to: "Katherine", text: "Friday.", at: "2026-10-28T14:12:30.000Z" });
	assert.equal(buildNotesFile({ ...{ pid: 1, sessionId: "", sessionName: "", startedAt: "", appId: "", title: "", at: "", ended: true, me: [], notes: emptyNotes(), alerts: [], alertSeq: 0 }, reply: null }).reply, null);
	assert.deepEqual(file.slides, [], "no summaries yet: an empty list");
});

test("the notes file is written atomically at mode 600, and only its writer removes it", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-notes-"));
	const saved = process.env.PI_MEETING_NOTES_FILE;
	process.env.PI_MEETING_NOTES_FILE = path.join(dir, "sub", ".meeting-notes.json");
	try {
		const f = (pid, id) => buildNotesFile({ pid, sessionId: id, sessionName: "", startedAt: "S", appId: "teams", title: "T", at: "A", ended: false, me: [], notes: emptyNotes(), reply: null, alerts: [], alertSeq: 0 });
		writeNotesFile(f(5, "mine"));
		assert.equal(fs.statSync(notesPath()).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(path.join(dir, "sub")), [".meeting-notes.json"], "no temp file left");
		assert.equal(JSON.parse(fs.readFileSync(notesPath(), "utf8")).session.id, "mine");
		removeNotesFile({ pid: 5, sessionId: "other" });
		assert.ok(fs.existsSync(notesPath()), "another session's remove leaves it");
		removeNotesFile({ pid: 6, sessionId: "mine" });
		assert.ok(fs.existsSync(notesPath()), "another process's too");
		removeNotesFile({ pid: 5, sessionId: "mine" });
		assert.equal(fs.existsSync(notesPath()), false);
		removeNotesFile({ pid: 5, sessionId: "mine" }); // already gone: fine
	} finally {
		saved === undefined ? delete process.env.PI_MEETING_NOTES_FILE : (process.env.PI_MEETING_NOTES_FILE = saved);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the notes file defaults to the canvas root", () => {
	const saved = [process.env.PI_MEETING_NOTES_FILE, process.env.PI_CANVAS_ROOT];
	delete process.env.PI_MEETING_NOTES_FILE;
	try {
		delete process.env.PI_CANVAS_ROOT;
		assert.equal(notesPath(), path.join(os.homedir(), ".pi", "canvas", ".meeting-notes.json"));
		process.env.PI_CANVAS_ROOT = "/tmp/canvas-x";
		assert.equal(notesPath(), "/tmp/canvas-x/.meeting-notes.json");
	} finally {
		saved[0] === undefined ? delete process.env.PI_MEETING_NOTES_FILE : (process.env.PI_MEETING_NOTES_FILE = saved[0]);
		saved[1] === undefined ? delete process.env.PI_CANVAS_ROOT : (process.env.PI_CANVAS_ROOT = saved[1]);
	}
});


// ── files ──

test("meeting keys and candidates", () => {
	assert.equal(meetingKey("20261005_125906-teams-team-weekly-sync.jsonl"), "teams-team-weekly-sync");
	assert.equal(meetingKey("/x/20261005_125906-teams-team-weekly-sync.txt"), "teams-team-weekly-sync");
	assert.ok(isCandidate("20261005_125906-teams-team-weekly-sync.jsonl"));
	assert.ok(!isCandidate("20261005_125906-teams-team-weekly-sync.txt"));
	assert.ok(!isCandidate("20261005_125906-slack-notifications-x.jsonl"));
	assert.ok(!isCandidate("20261005_125906-teams-test-run.jsonl"));
	assert.ok(!isCandidate("20261005_125906-teams-standup-merged.jsonl"));
});

const names = [
	"20261001_143050-teams-eric-tabinda.jsonl",
	"20261002_070140-teams-2026-acme-daily-it-stand-up-briefing.jsonl",
	"20261005_125906-teams-team-weekly-sync.jsonl",
	"20261005_125906-teams-team-weekly-sync.txt",
	"20261005_140000-slack-notifications-x.jsonl",
];

test("picks the newest capture, optionally by name", () => {
	assert.equal(pickNewest(names), "20261005_125906-teams-team-weekly-sync.jsonl");
	assert.equal(pickNewest(names, "Tabinda"), "20261001_143050-teams-eric-tabinda.jsonl");
	assert.equal(pickNewest(names, "nope"), undefined);
});

test("only captures started since the wait began count", () => {
	assert.equal(pickStartedSince(names, "20261005_120000"), "20261005_125906-teams-team-weekly-sync.jsonl");
	assert.equal(pickStartedSince(names, "20261005_130000"), undefined);
	assert.equal(pickStartedSince(names, "20261001_000000", { key: "teams-eric-tabinda" }), "20261001_143050-teams-eric-tabinda.jsonl");
});

test("the previous transcript is the biggest file from the last earlier day", () => {
	const files = [
		{ name: "20260921_125900-teams-team-weekly-sync.txt", size: 30_000 },
		{ name: "20260928_125900-teams-team-weekly-sync.txt", size: 2_000 },
		{ name: "20260928_130500-teams-team-weekly-sync.txt", size: 25_000 },
		{ name: "20260928_131000-teams-team-weekly-sync.txt", size: 200 },
		{ name: "20261005_120000-teams-team-weekly-sync.txt", size: 50_000 },
		{ name: "20260930_125900-teams-other.txt", size: 90_000 },
	];
	assert.equal(previousTranscript(files, "20261005_125906-teams-team-weekly-sync.jsonl"), "20260928_130500-teams-team-weekly-sync.txt");
	assert.equal(previousTranscript(files, "20260921_125900-teams-team-weekly-sync.jsonl"), undefined);
});

test("filename stamps use local time", () => {
	assert.equal(toStamp(new Date(2026, 9, 5, 7, 3, 9).getTime()), "20261005_070309");
});

// ── args ──

test("parses subcommands, flags and targets", () => {
	assert.deepEqual(parseArgs(""), { sub: "status", target: "", rest: "" });
	assert.equal(parseArgs("stop").sub, "stop");
	assert.deepEqual(parseArgs("focus push for a cutover date"), { sub: "focus", target: "", rest: "push for a cutover date" });
	assert.deepEqual(parseArgs("watch off"), { sub: "watch", target: "", rest: "off" });
	const a = parseArgs("replay 20 ~/x.jsonl --model prov/model-x:fast");
	assert.deepEqual([a.sub, a.replay, a.target, a.model], ["replay", 20, `${os.homedir()}/x.jsonl`, "prov/model-x:fast"]);
	assert.equal(parseArgs("replay").replay, 10, "ten times speed unless told");
	assert.equal(parseArgs("replay core").target, "core");
	assert.equal(parseArgs("replay core").replay, 10);
	assert.equal(parseArgs("start").sub, "start", "start is only a pointer to /meeting watch now");
	assert.equal(parseArgs("core").sub, "unknown", "a bare word no longer starts anything");
	assert.equal(parseArgs("notes").sub, "notes");
	assert.equal(parseArgs("recap").sub, "recap");
	assert.equal(parseArgs("ask").sub, "ask");
	assert.equal(parseArgs("list").sub, "unknown", "the question list is gone");
	assert.equal(parseArgs("expand").sub, "unknown");
});

// ── recap ──

const meetingNotes = mergeNotes(
	emptyNotes(),
	parseScoutReply(
		JSON.stringify({
			topics: [{ title: "Cert rotation", summary: "Thursday, owner Amy." }, { title: "Canary", summary: "" }],
			decisions: ["Rotate Thursday"],
			actions: [{ who: "Amy", what: "rotate the cert", mine: false }, { who: "Eric", what: "own the canary move", mine: true, by: "Ada" }],
			questions: [{ q: "Who signs off before Thursday?", why: "no approver named" }],
		}),
	),
	"T",
).notes;

test("the recap lists topics, decisions, action items (yours first, starred) and open questions", () => {
	assert.deepEqual(recapBody(meetingNotes), [
		"Topics:",
		"- Cert rotation: Thursday, owner Amy.",
		"- Canary",
		"",
		"Decisions:",
		"- Rotate Thursday",
		"",
		"Action items:",
		"- ★ Eric: own the canary move (from Ada)",
		"- Amy: rotate the cert",
		"",
		"Open questions:",
		"- Who signs off before Thursday? (no approver named)",
	]);
	assert.deepEqual(recapBody(emptyNotes()), ["No notes were taken."]);
	assert.deepEqual(recapBody({ ...emptyNotes(), decisions: [{ text: "x", at: "" }] }), ["Decisions:", "- x"], "empty sections are left out");
	assert.deepEqual(recapBody(emptyNotes(), { to: "Kat", text: "Friday." }), ["Suggested reply to Kat: Friday."]);
});

const file = `${os.homedir()}/.local/share/meeting-capture/20261006_110421-teams-ei-cloud-config.jsonl`;
const block = recapBlock({ title: "EI: Cloud Config", file, from: "11:04", to: "11:20", updates: 14, notes: meetingNotes });
const marker = recapMarker(file);

test("the daily-note block has a heading, a hidden marker and the transcript", () => {
	const lines = block.split("\n");
	assert.equal(lines[0], "### 11:04–11:20 EI: Cloud Config · copilot notes");
	assert.equal(lines[1], "<!-- meeting-copilot:20261006_110421-teams-ei-cloud-config -->");
	assert.equal(lines[2], "Transcript: `~/.local/share/meeting-capture/20261006_110421-teams-ei-cloud-config.txt` · 14 notes updates");
	assert.equal(lines[4], "Topics:");
	assert.equal(dailyNoteName(file), "2026-10-06.md");
	assert.equal(dailyNoteName("/tmp/x.jsonl", new Date(2026, 0, 2)), "2026-01-02.md");
});

const note = [
	"# Tue",
	"",
	"## Meetings",
	"",
	"| Time | Meeting |",
	"|---|---|",
	"| 11:05 | EI: Cloud Config |",
	"",
	"",
	"## Standup",
	"",
	"- shipped",
	"",
].join("\n");

test("the recap goes at the end of ## Meetings and leaves the rest alone", () => {
	const out = upsertRecap(note, block, marker);
	const [before, after] = out.split(block);
	assert.equal(before, "# Tue\n\n## Meetings\n\n| Time | Meeting |\n|---|---|\n| 11:05 | EI: Cloud Config |\n\n");
	assert.equal(after, "\n\n## Standup\n\n- shipped\n");
});

test("writing the recap again replaces it in place", () => {
	const once = upsertRecap(note, block, marker);
	const newer = block.replace("14 notes updates", "15 notes updates");
	const twice = upsertRecap(once, newer, marker);
	assert.equal(twice, once.replace("14 notes updates", "15 notes updates"));
	assert.equal(twice.split(marker).length, 2, "one block");
	assert.equal(upsertRecap(twice, newer, marker), twice, "idempotent");
});

test("two meetings stack under the heading; a note without one gets the section", () => {
	const other = recapBlock({ title: "Fraud sync", file: "/x/20261006_140500-teams-fraud.jsonl", from: "14:05", to: "14:30", updates: 3, notes: emptyNotes() });
	const both = upsertRecap(upsertRecap(note, block, marker), other, recapMarker("/x/20261006_140500-teams-fraud.jsonl"));
	assert.ok(both.indexOf("EI: Cloud Config · copilot") < both.indexOf("Fraud sync · copilot"));
	assert.ok(both.indexOf("Fraud sync · copilot") < both.indexOf("## Standup"));
	assert.equal(upsertRecap("# Tue\n\nnotes", "### x", "m"), "# Tue\n\nnotes\n\n## Meetings\n\n### x\n");
	assert.equal(upsertRecap("", "### x", "m"), "## Meetings\n\n### x\n");
});

// ── the status line ──

const view = (overrides = {}) => ({
	phase: "live",
	title: "Weekly Sync",
	startedMs: 0,
	slide: undefined,
	alerts: 0,
	questions: 0,
	hasLines: true,
	busy: false,
	error: "",
	replay: false,
	...overrides,
});

test("one line, zero parts left out", () => {
	const now = 1_000_000_000;
	const line = (v) => widgetLines(view({ startedMs: now - 16 * 60_000, ...v }), plain, 120, now);
	assert.deepEqual(line({ slide: 4, alerts: 2, questions: 1 }), ["● Weekly Sync · 16m · slide 4 · 2 alerts · 1 question"]);
	assert.deepEqual(line({ alerts: 1 }), ["● Weekly Sync · 16m · 1 alert"]);
	assert.deepEqual(line({}), ["● Weekly Sync · 16m"]);
	assert.deepEqual(line({ slide: 0, questions: 2 }), ["● Weekly Sync · 16m · slide 0 · 2 questions"]);
	assert.deepEqual(line({ hasLines: false, slide: 2 }), ["● Weekly Sync · 16m · waiting for captions"], "no captions yet: that, and no counts");
	assert.deepEqual(widgetLines(view({ phase: "waiting", hasLines: false }), plain, 120), ["◌ Weekly Sync · waiting for captions"]);
	assert.deepEqual(widgetLines(view({ phase: "waiting", title: "", hasLines: false }), plain, 120), ["◌ meeting · waiting for captions"]);
});

test("ended, replay, busy, error and no-model states", () => {
	const now = 1_000_000_000;
	const line = (v) => widgetLines(view({ startedMs: now - 16 * 60_000, ...v }), plain, 200, now)[0];
	assert.equal(line({ phase: "ended", alerts: 2 }), "● Weekly Sync · 16m · call ended · 2 alerts");
	assert.equal(line({ phase: "ended", replay: true, questions: 1 }), "● Weekly Sync (replay) · 16m · replay done · 1 question");
	assert.equal(line({ replay: true }), "● Weekly Sync (replay) · 16m");
	assert.equal(line({ busy: true }), "◐ Weekly Sync · 16m · updating notes…");
	assert.equal(line({ error: "429 rate limited" }), "✕ Weekly Sync · 16m · error: 429 rate limited");
	assert.equal(line({ rulesOnly: true, alerts: 1 }), "● Weekly Sync · 16m · 1 alert · name alerts only");
});

test("the widget line fits the width", () => {
	const lines = widgetLines(view({ title: "A very long meeting title ".repeat(6), slide: 4, alerts: 12, questions: 2, busy: true }), plain, 40);
	assert.equal(lines.length, 1);
	assert.ok(visibleWidth(lines[0]) <= 40, `too wide: ${JSON.stringify(lines[0])}`);
	assert.match(lines[0], /^◐ /);
});


// ── meeting-capture state and the owner lock ──

const rawState = (over = {}) => ({
	v: 1,
	pid: 4242,
	app: "Microsoft Teams",
	app_id: "teams",
	meeting: "Weekly Sync",
	started_at: "2026-10-28T14:00:00-05:00",
	jsonl: "/data/20261028_140000-teams-weekly-sync.jsonl",
	txt: "/data/20261028_140000-teams-weekly-sync.txt",
	slides_dir: "/data/20261028_140000-teams-weekly-sync.slides",
	live: "/state/live.json",
	ended: false,
	...over,
});

test("state.json: only version 1 with a pid counts, nulls stay null", () => {
	const s = parseState(rawState({ jsonl: null, txt: null, slides_dir: null }));
	assert.equal(s.title, "Weekly Sync");
	assert.equal(s.startedMs, Date.parse("2026-10-28T14:00:00-05:00"));
	assert.deepEqual([s.jsonl, s.txt, s.slidesDir, s.ended], [null, null, null, false]);
	assert.equal(parseState(rawState()).livePath, "/state/live.json");
	assert.equal(parseState(rawState({ v: 2 })), null);
	assert.equal(parseState(rawState({ pid: "x" })), null);
	assert.equal(parseState(null), null);
	assert.equal(parseState(rawState({ jsonl: "relative.jsonl" })).jsonl, null, "paths must be absolute");
});

test("a meeting is live when it isn't ended and its pid is alive", () => {
	const alive = () => true;
	const dead = () => false;
	assert.equal(isLive(parseState(rawState()), alive), true);
	assert.equal(isLive(parseState(rawState()), dead), false, "a dead pid mid-meeting is a crash");
	assert.equal(isLive(parseState(rawState({ ended: true })), alive), false);
	assert.equal(isLive(null, alive), false);
});

test("the state reader reparses only when the file changed", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-state-"));
	const file = path.join(dir, "state.json");
	try {
		const read = stateReader(() => file);
		assert.equal(read(), null, "no file yet");
		fs.writeFileSync(file, JSON.stringify(rawState()));
		const a = read();
		assert.equal(a.title, "Weekly Sync");
		assert.equal(read(), a, "same stat, same object: not reparsed");
		fs.writeFileSync(file, JSON.stringify(rawState({ meeting: "Retro", ended: true })));
		assert.equal(read().title, "Retro");
		fs.writeFileSync(file, "{ half");
		assert.equal(read(), null, "unreadable reads as nothing, not a crash");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const lock = (over = {}) => ({ pid: 100, sessionId: "a", name: "earl", via: "owner", at: "", ...over });

test("canClaim: free, dead, mine, or watch over owner; never over a live watch or a second owner", () => {
	const alive = () => true;
	const dead = () => false;
	const owner = { pid: 1, sessionId: "me", via: "owner" };
	const watch = { pid: 1, sessionId: "me", via: "watch" };
	assert.equal(canClaim(null, owner, alive), true, "no lock");
	assert.equal(canClaim(lock(), owner, dead), true, "the holder is gone");
	assert.equal(canClaim(lock({ pid: 1, sessionId: "me" }), owner, alive), true, "already mine");
	assert.equal(canClaim(lock({ pid: 1, sessionId: "other" }), owner, alive), false, "same pid, another session, is not me");
	assert.equal(canClaim(lock({ via: "owner" }), watch, alive), true, "watch beats owner");
	assert.equal(canClaim(lock({ via: "watch" }), watch, alive), false, "a live watch holder keeps it");
	assert.equal(canClaim(lock({ via: "watch" }), owner, alive), false, "owner never beats watch");
	assert.equal(canClaim(lock({ via: "owner" }), owner, alive), false, "nor another owner");
});

test("the owner setting matches the session name, trimmed and case-insensitive, never empty", () => {
	assert.equal(nameMatches("earl", "Earl"), true);
	assert.equal(nameMatches(" earl ", "earl "), true);
	assert.equal(nameMatches("earl", "earl2"), false);
	assert.equal(nameMatches("", ""), false);
	assert.equal(nameMatches("earl", undefined), false);
});

test("the lock is written atomically (mode 600), read back, and released only by its owner", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-lock-"));
	const prev = process.env.PI_MEETING_LOCK;
	process.env.PI_MEETING_LOCK = path.join(dir, "sub", "meeting-owner.json");
	try {
		assert.equal(readLock(), null);
		const me = { pid: process.pid, sessionId: "s1", name: "earl", via: "owner" };
		writeLock(me);
		const l = readLock();
		assert.deepEqual([l.pid, l.sessionId, l.name, l.via], [process.pid, "s1", "earl", "owner"]);
		assert.ok(Date.parse(l.at) > 0);
		assert.equal(fs.statSync(process.env.PI_MEETING_LOCK).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(path.join(dir, "sub")), ["meeting-owner.json"], "no temp file left");
		assert.equal(isMine(l, me), true);
		releaseLock({ pid: process.pid, sessionId: "someone-else" });
		assert.ok(readLock(), "not mine: left alone");
		releaseLock(me);
		assert.equal(readLock(), null);
		assert.equal(parseLock({ pid: "x" }), null);
	} finally {
		if (prev === undefined) delete process.env.PI_MEETING_LOCK;
		else process.env.PI_MEETING_LOCK = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the lock is created exclusively, and a failed write leaves no temp file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-lock-"));
	const prev = process.env.PI_MEETING_LOCK;
	process.env.PI_MEETING_LOCK = path.join(dir, "meeting-owner.json");
	try {
		const a = { pid: process.pid, sessionId: "a", name: "a", via: "owner" };
		const b = { pid: process.pid, sessionId: "b", name: "b", via: "watch" };
		assert.equal(createLock(a), true);
		assert.equal(createLock(b), false, "O_EXCL: the second one loses");
		assert.equal(readLock().sessionId, "a");
		assert.equal(fs.statSync(process.env.PI_MEETING_LOCK).mode & 0o777, 0o600);
		fs.writeFileSync(process.env.PI_MEETING_LOCK, "");
		assert.equal(createLock(b), false, "even an unreadable file is not created over");
		writeLock(b);
		assert.equal(readLock().sessionId, "b", "a takeover is a plain atomic write");

		// rename fails (the target is a directory): the tmp file must not stay behind
		fs.rmSync(process.env.PI_MEETING_LOCK);
		fs.mkdirSync(process.env.PI_MEETING_LOCK);
		assert.throws(() => writeLock(a));
		assert.deepEqual(fs.readdirSync(dir), ["meeting-owner.json"]);
	} finally {
		if (prev === undefined) delete process.env.PI_MEETING_LOCK;
		else process.env.PI_MEETING_LOCK = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("stopped meetings are kept beside the lock: mode 600, deduped, the last 5", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-stopped-"));
	const prev = process.env.PI_MEETING_LOCK;
	process.env.PI_MEETING_LOCK = path.join(dir, "sub", "meeting-owner.json");
	try {
		assert.equal(stoppedPath(), path.join(dir, "sub", "meeting-stopped.json"));
		assert.deepEqual(readStopped(), []);
		for (let i = 1; i <= 7; i++) markStopped(`2026-10-28T1${i}:00:00-05:00`);
		markStopped("2026-10-28T17:00:00-05:00");
		markStopped("");
		assert.deepEqual(
			readStopped(),
			[3, 4, 5, 6, 7].map((i) => `2026-10-28T1${i}:00:00-05:00`),
		);
		assert.equal(fs.statSync(stoppedPath()).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(path.join(dir, "sub")), ["meeting-stopped.json"], "no temp file left");
		fs.writeFileSync(stoppedPath(), "{not json");
		assert.deepEqual(readStopped(), [], "a bad file reads as none");
	} finally {
		if (prev === undefined) delete process.env.PI_MEETING_LOCK;
		else process.env.PI_MEETING_LOCK = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── the meeting tool's pure parts ──

const J = (o) => JSON.stringify(o);
const at = (hms, day = "28") => `2026-10-${day}T${hms}-05:00`;
const transcript = [
	J({ type: "metadata", meeting: "Weekly Sync", app: "Microsoft Teams" }),
	J({ type: "caption", speaker: "Ada Lovelace", text: "Morning everyone.", ts: at("14:00:05") }),
	J({ type: "people", count: 3, people: ["Ada Lovelace", "Smith, Amy (ORG)", "Alan Turing"], text: "3 in the meeting", ts: at("14:00:06") }),
	J({ type: "slide", slide: 1, file: "/d/0001-140010.jpg", text: "x", ts: at("14:00:10") }),
	J({ type: "caption", speaker: "Smith, Amy (ORG)", text: "The cert expires on Friday,\n so we rotate it.", ts: at("14:05:00") }),
	J({ type: "chat", speaker: "Alan Turing", text: "Link to the CERT runbook?", ts: at("14:06:00") }),
	J({ type: "slide", slide: 2, file: "/d/0002-141000.jpg", text: "x", ts: at("14:10:00") }),
	J({ type: "caption", speaker: "Ada Lovelace", text: "Back to the first slide.", ts: at("14:12:00") }),
	J({ type: "revisit", slide: 1, file: "/d/0001-140010.jpg", reason: "revisit", text: "x", ts: at("14:12:01") }),
	J({ type: "caption", speaker: "   ", text: "   ", ts: at("14:12:02") }),
	"not json",
].join("\n");
const recs = parseRecords(transcript);
const startMs = Date.parse(at("14:00:00"));

test("records parse, with chat, slides, revisits and people; the rest is dropped", () => {
	assert.equal(recs.length, 8, "metadata, a blank caption and junk are gone");
	assert.equal(parseRecord('{"type":"metadata"}'), null);
	assert.equal(parseRecord('{"type":"slide","ts":"2026-10-28T14:00:00-05:00"}'), null, "a slide needs its number");
	assert.equal(recs[3].text, "The cert expires on Friday, so we rotate it.", "whitespace collapses");
	assert.deepEqual(recs.map((r) => r.kind), ["caption", "people", "slide", "caption", "chat", "slide", "caption", "revisit"]);
});

test("formatting: speaker lines, chat, slide and revisit markers, headcount", () => {
	assert.deepEqual(recs.map(formatRec), [
		"[14:00:05] Ada Lovelace: Morning everyone.",
		"[14:00:06] 👥 3 in the meeting",
		"[14:00:10] ▣ slide 1",
		"[14:05:00] Smith, Amy (ORG): The cert expires on Friday, so we rotate it.",
		"[14:06:00] (chat) Alan Turing: Link to the CERT runbook?",
		"[14:10:00] ▣ slide 2",
		"[14:12:00] Ada Lovelace: Back to the first slide.",
		"[14:12:01] ↺ back to slide 1",
	]);
});

test("the slide on screen is the last slide or revisit; revisits don't add slides", () => {
	assert.equal(currentSlide(recs), 1, "the revisit put slide 1 back");
	assert.equal(currentSlide(recs.slice(0, 6)), 2);
	assert.equal(currentSlide(recs.slice(0, 1)), undefined);
	assert.equal(slideCount(recs), 2);
	assert.equal(lastPeople(recs).count, 3);
	const t = slideTimes(recs, 1);
	assert.equal(clock(t.first.ts), "14:00:10");
	assert.deepEqual(t.again.map((r) => clock(r.ts)), ["14:12:01"]);
});

test("time specs: HH:MM, HH:MM:SS in the meeting's own offset on its day, or ISO; an end bound covers its minute", () => {
	const startedAt = at("14:00:00");
	assert.equal(parseTimeSpec("14:05", startMs, false, startedAt), Date.parse(at("14:05:00")));
	assert.equal(parseTimeSpec("14:05:30", startMs, false, startedAt), Date.parse(at("14:05:30")));
	assert.equal(parseTimeSpec("14:05", startMs, true, startedAt), Date.parse(at("14:05:59")) + 999);
	assert.equal(parseTimeSpec("14:05:30", startMs, true, startedAt), Date.parse(at("14:05:30")));
	assert.equal(parseTimeSpec("2026-10-28T14:05:00-05:00", startMs, false, startedAt), Date.parse("2026-10-28T14:05:00-05:00"));
	assert.equal(parseTimeSpec("soon", startMs, false, startedAt), undefined);
	assert.equal(parseTimeSpec("00:10", startMs, false, startedAt), Date.parse(at("00:10:00", "29")), "past midnight means the next day");
});

test("time specs follow the meeting's offset, not this machine's, and only roll over past 12 h before the start", () => {
	assert.equal(isoOffsetMin("2026-10-28T14:00:00-05:00"), -300);
	assert.equal(isoOffsetMin("2026-10-28T14:00:00+0530"), 330);
	assert.equal(isoOffsetMin("2026-10-28T19:00:00Z"), 0);
	assert.equal(isoOffsetMin("2026-10-28T14:00:00"), undefined);
	for (const [startedAt, hms] of [
		["2026-10-28T14:00:00+09:00", "14:10:00"],
		["2026-10-28T14:00:00Z", "14:10:00"],
		["2026-10-28T02:00:00-11:00", "02:10:00"],
	]) {
		const start = Date.parse(startedAt);
		assert.equal(parseTimeSpec(hms.slice(0, 5), start, false, startedAt), Date.parse(startedAt.replace(/T..:..:../, `T${hms}`)), startedAt);
	}
	// 14:00 start: 13:50 is 10 min before it (same day), 01:00 is 13 h before (next day), 02:30 is 11.5 h before (same day).
	const startedAt = "2026-10-28T14:00:00-05:00";
	assert.equal(parseTimeSpec("13:50", startMs, false, startedAt), Date.parse("2026-10-28T13:50:00-05:00"));
	assert.equal(parseTimeSpec("02:30", startMs, false, startedAt), Date.parse("2026-10-28T02:30:00-05:00"));
	assert.equal(parseTimeSpec("01:00", startMs, false, startedAt), Date.parse("2026-10-29T01:00:00-05:00"));
	// A meeting that crosses midnight in its own zone lands on the right day too.
	const late = "2026-10-28T23:50:00+09:00";
	assert.equal(parseTimeSpec("00:05", Date.parse(late), false, late), Date.parse("2026-10-29T00:05:00+09:00"));
	// filters pass the offset along
	const lines = [{ speaker: "A", text: "x", ts: "2026-10-28T14:10:00+09:00" }];
	assert.equal(filterLive(lines, { since: "14:05" }, Date.parse("2026-10-28T14:00:00+09:00"), "2026-10-28T14:00:00+09:00").length, 1);
	assert.equal(filterLive(lines, { since: "14:15" }, Date.parse("2026-10-28T14:00:00+09:00"), "2026-10-28T14:00:00+09:00").length, 0);
});

test("filters: minutes back from now, since/until, speaker (first name works), query words", () => {
	const ref = Date.parse(at("14:12:30"));
	const kinds = (f) => filterRecords(recs, f, ref, startMs, at("14:00:00")).map((r) => `${clock(r.ts)}`);
	assert.deepEqual(kinds({ minutes: 3 }), ["14:10:00", "14:12:00", "14:12:01"], "the last 3 minutes, markers included");
	assert.deepEqual(kinds({ since: "14:05", until: "14:06" }), ["14:05:00", "14:06:00"], "until covers its whole minute");
	assert.deepEqual(kinds({ speaker: "amy" }), ["14:05:00"], "the first name finds 'Smith, Amy (ORG)'");
	assert.deepEqual(kinds({ speaker: "ADA" }), ["14:00:05", "14:12:00"], "case-insensitive, markers dropped");
	assert.deepEqual(kinds({ query: "cert friday" }), ["14:05:00"], "all words, any order");
	assert.deepEqual(kinds({ query: "cert" }), ["14:05:00", "14:06:00"], "chat counts");
	assert.deepEqual(kinds({ speaker: "amy", query: "runbook" }), []);
	assert.equal(kinds({}).length, 8);
	assert.throws(() => filterRecords(recs, { since: "whenever" }, ref, startMs), /Can't read since "whenever"/);
	assert.equal(speakerMatches("Smith, Amy (ORG)", "Amy Smith"), true, "every word is a name part");
	assert.equal(speakerMatches("Ada Lovelace", "amy"), false);
	assert.equal(queryMatches("The Cert expires", "CERT  expires"), true);
});

test("a long transcript keeps its newest lines and says what was cut", () => {
	const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
	assert.deepEqual(truncateLines(lines, 400).text.split("\n"), lines, "under the caps: untouched");
	const byLimit = truncateLines(lines, 3);
	assert.equal(byLimit.cut, 7);
	assert.equal(byLimit.text, "[… 7 earlier lines cut, over 3 lines; narrow with minutes, since, until, speaker or query …]\nline 7\nline 8\nline 9");
	const big = Array.from({ length: 50 }, (_, i) => `${i} ${"x".repeat(990)}`);
	const byChars = truncateLines(big, 400, 16_000);
	assert.ok(byChars.text.length < 16_300 && byChars.cut > 30, `${byChars.text.length} chars, ${byChars.cut} cut`);
	assert.match(byChars.text, /^\[… \d+ earlier lines cut, over ~16k characters;/);
	assert.match(byChars.text, /49 x+$/, "the newest line stays");
	assert.equal(truncateLines(lines, 0).cut, 0, "limit 0 falls back to the default");
});

test("live lines are marked, and filter like the rest", () => {
	const live = parseLive({ lines: [{ speaker: "Grace Hopper", text: " the deploy is  green ", ts: at("14:12:10") }, { speaker: "Ada Lovelace", text: "", ts: at("14:12:11") }] });
	assert.equal(live.length, 1);
	assert.equal(formatLive(live[0]), "[14:12:10] Grace Hopper: the deploy is green (still speaking)");
	assert.equal(filterLive(live, { speaker: "grace", query: "deploy" }, startMs).length, 1);
	assert.equal(filterLive(live, { speaker: "ada" }, startMs).length, 0);
	assert.deepEqual(parseLive(null), []);
});

test("slide index and the OCR path beside the jpg", () => {
	const idx = parseIndex(`${J({ n: 1, at: at("14:00:10"), file: "0001-140010.jpg", thumb: "0001-140010.thumb.jpg", reason: "first frame", width: 2880, height: 2560 })}\n{ half\n${J({ n: 2, at: at("14:10:00"), file: "/abs/../0002-141000.jpg" })}\n`);
	assert.deepEqual(idx.map((e) => e.n), [1, 2], "a half-written line is skipped");
	assert.equal(idx[0].width, 2880);
	assert.equal(ocrPath("/d/x.slides", idx[0]), "/d/x.slides/0001-140010.txt");
	assert.equal(ocrPath("/d/x.slides", idx[1]), "/d/x.slides/0002-141000.txt", "only the file name is used: no path tricks");
});

test("status text and the one-line system prompt", () => {
	const text = formatStatus({
		title: "Weekly Sync",
		app: "Microsoft Teams",
		startedAt: at("14:00:00"),
		elapsedMs: 16 * 60_000,
		live: true,
		people: recs[1],
		slides: 4,
		slideOn: 2,
		ocr: { done: 3, total: 4 },
	});
	assert.equal(
		text,
		[
			"Meeting: Weekly Sync (Microsoft Teams)",
			"State: live",
			"Started: 14:00:00",
			"Elapsed: 16 min",
			"People: 3: Ada Lovelace, Smith, Amy (ORG), Alan Turing",
			"Slides: 4, slide 2 on screen",
			"OCR: 3 of 4 slides",
		].join("\n"),
	);
	assert.match(formatStatus({ title: "T", app: "", startedAt: at("14:00:00"), elapsedMs: 3_900_000, live: false, endedAt: at("15:05:00"), slides: 0 }), /State: ended at 15:05:00\nStarted: 14:00:00\nRan: 1h05m\nPeople: not listed yet\nSlides: 0\nOCR: no slides directory/);
	assert.equal(
		promptLine({ title: "Weekly Sync", app: "Microsoft Teams", elapsedMs: 16 * 60_000 + 5000, slide: 4 }),
		"A meeting is live: Weekly Sync (Microsoft Teams), 15 min in, slide 4 on screen. Use the meeting tool for anything about it.",
	);
	assert.equal(promptLine({ title: "Sync", app: "", elapsedMs: 0 }), "A meeting is live: Sync, just started. Use the meeting tool for anything about it.");
	assert.deepEqual([0, 4 * 60_000 + 59_000, 5 * 60_000, 9 * 60_000 + 59_000, 10 * 60_000, 62 * 60_000, -5].map(roundedElapsed), ["just started", "just started", "5 min in", "5 min in", "10 min in", "60 min in", "just started"]);
	assert.match(promptLine({ title: "Sync", app: "", elapsedMs: 0, replay: true }), /^A meeting replay is running: Sync/);
});

test("the /meeting status says armed, owner, lock holder and meeting", () => {
	const state = parseState(rawState());
	const base = { armed: false, armedBy: "", owner: "earl", name: "earl", lock: null, lockAlive: false, mine: false, state: null, stateLive: false, nowMs: startMs + 16 * 60_000 };
	assert.deepEqual(statusReport(base), [
		"Armed: no (/meeting watch arms this session)",
		"Owner setting: earl (this session) · this session is earl",
		"Lock: free",
		"Meeting: none seen",
	]);
	assert.deepEqual(statusReport({ ...base, armed: true, armedBy: "/meeting watch", owner: "", name: "", lock: lock({ name: "bob", via: "watch", pid: 7 }), lockAlive: true, state, stateLive: true }), [
		"Armed: yes (/meeting watch)",
		"Owner setting: (none)",
		"Lock: bob (via watch, pid 7)",
		"Meeting: Weekly Sync (Microsoft Teams), live, 16 min in",
	]);
	assert.match(statusReport({ ...base, lock: lock(), mine: true, state: parseState(rawState({ ended: true, duration: "0:30:00" })) })[3], /^Meeting: none live; the last was Weekly Sync \(Microsoft Teams\), ended, 0:30:00$/);
	assert.match(statusReport({ ...base, lock: lock(), lockAlive: false })[2], /^Lock: earl \(via owner, pid 100, gone\)$/);
});

// ── the archive of every meeting's notes ──

test("meetingId is the canvas feed's id: sha1 of app_id|started_at, 12 hex chars", async () => {
	const { meetingId: feedId } = await import("../extensions/canvas/meeting-feed.mjs");
	for (const [appId, startedAt] of [["teams", "2026-10-28T14:00:00-05:00"], ["zoom", "2026-10-28T14:00:00Z"], ["", ""]]) {
		assert.equal(meetingId(appId, startedAt), feedId({ appId, startedAt }));
		assert.match(meetingId(appId, startedAt), /^[0-9a-f]{12}$/);
	}
	assert.notEqual(meetingId("teams", "a"), meetingId("zoom", "a"));
	assert.equal(feedId(null), "", "no state, no id");
});

test("the archive: <meeting id>.json, atomic, mode 600 in a 700 folder, rewritten in place, never removed with the live file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-archive-"));
	const saved = [process.env.PI_MEETING_NOTES_DIR, process.env.PI_MEETING_NOTES_FILE, process.env.PI_CANVAS_ROOT];
	process.env.PI_MEETING_NOTES_DIR = path.join(dir, "a", "meetings");
	process.env.PI_MEETING_NOTES_FILE = path.join(dir, "a", ".meeting-notes.json");
	try {
		const f = (over = {}) => buildNotesFile({ pid: 5, sessionId: "mine", sessionName: "", startedAt: "2026-10-28T14:00:00-05:00", appId: "teams", title: "T", at: "A", ended: false, me: [], notes: emptyNotes(), reply: null, alerts: [], alertSeq: 0, ...over });
		const id = meetingId("teams", "2026-10-28T14:00:00-05:00");
		const file = path.join(process.env.PI_MEETING_NOTES_DIR, `${id}.json`);
		writeNotesFile(f());
		writeNotesArchive(f());
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.statSync(process.env.PI_MEETING_NOTES_DIR).mode & 0o777, 0o700);
		assert.deepEqual(fs.readdirSync(process.env.PI_MEETING_NOTES_DIR), [`${id}.json`], "no temp file left");
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(fs.readFileSync(notesPath(), "utf8")), "the same shape as the live file");
		writeNotesArchive(f({ ended: true, title: "T2" }));
		assert.deepEqual([JSON.parse(fs.readFileSync(file, "utf8")).ended, JSON.parse(fs.readFileSync(file, "utf8")).meeting.title], [true, "T2"], "rewritten in place");
		// Another meeting is another file; removing the live file leaves both.
		writeNotesArchive(f({ startedAt: "2026-10-28T16:00:00-05:00" }));
		assert.equal(fs.readdirSync(process.env.PI_MEETING_NOTES_DIR).length, 2);
		removeNotesFile({ pid: 5, sessionId: "mine" });
		assert.equal(fs.existsSync(notesPath()), false);
		assert.equal(fs.readdirSync(process.env.PI_MEETING_NOTES_DIR).length, 2);
		// Without a start time there is nothing to name the file by.
		writeNotesArchive(f({ startedAt: "" }));
		assert.equal(fs.readdirSync(process.env.PI_MEETING_NOTES_DIR).length, 2);
		// A folder that already exists with looser permissions is tightened.
		fs.chmodSync(process.env.PI_MEETING_NOTES_DIR, 0o755);
		writeNotesArchive(f());
		assert.equal(fs.statSync(process.env.PI_MEETING_NOTES_DIR).mode & 0o777, 0o700);
		// The folder defaults to meetings/ in the canvas root.
		delete process.env.PI_MEETING_NOTES_DIR;
		delete process.env.PI_CANVAS_ROOT;
		assert.equal(archiveDir(), path.join(os.homedir(), ".pi", "canvas", "meetings"));
		process.env.PI_CANVAS_ROOT = "/tmp/canvas-x";
		assert.equal(archiveDir(), "/tmp/canvas-x/meetings");
	} finally {
		for (const [i, k] of ["PI_MEETING_NOTES_DIR", "PI_MEETING_NOTES_FILE", "PI_CANVAS_ROOT"].entries()) saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});


// ── slide summaries ──

const SUM = (n, over = {}) => ({ n, title: `Slide ${n} title`, what: `What ${n} shows.`, why: "", points: [], numbers: [], at: "2026-10-28T14:05:00-05:00", ...over });

test("the setting defaults on, and PI_MEETING_SLIDES=0 (or false/off/no) turns it off", () => {
	assert.equal(MEETING_DEFAULTS.slideSummaries, true);
	assert.equal(meetingSettings({}).slideSummaries, true);
	for (const v of ["0", "false", "off", "NO", " 0 "]) assert.equal(meetingSettings({ PI_MEETING_SLIDES: v }).slideSummaries, false, v);
	assert.equal(meetingSettings({ PI_MEETING_SLIDES: "1" }).slideSummaries, true);
});

test("the slide JSON is read leniently: fences, prose, loose types; bounded; null when there is nothing", () => {
	const ok = parseSlideReply('Sure!\n```json\n{"title":"Q3 Roadmap","what":"A table of epics.","why":"","points":["a","b","c","d","e"],"numbers":["$4M budget",12,"x"," "],"extra":1}\n```');
	assert.deepEqual(ok, { title: "Q3 Roadmap", what: "A table of epics.", why: "", points: ["a", "b", "c", "d"], numbers: ["$4M budget", "12", "x"] });
	// A lone string where a list belongs, no title: derived from what; long strings are clipped.
	const loose = parseSlideReply(JSON.stringify({ what: `Rollout plan. ${"w".repeat(900)}`, why: "y".repeat(500), points: "just one", numbers: null }));
	assert.equal(loose.title.length, 60);
	assert.equal(loose.what.length, 500);
	assert.equal(loose.why.length, 300);
	assert.deepEqual([loose.points, loose.numbers], [["just one"], []]);
	assert.equal(parseSlideReply(JSON.stringify({ title: "x".repeat(200), what: "w" })).title.length, 80);
	assert.equal(parseSlideReply("no json here"), null);
	assert.equal(parseSlideReply("{broken"), null);
	assert.equal(parseSlideReply("[1,2]"), null);
	assert.equal(parseSlideReply('{"why":"x"}'), null, "no title or description at all");
});

test("summaries read back from a file are bounded: n is an integer of 1 or more, one per n, sorted, at most 120", () => {
	const raw = [
		{ n: 3, title: "Three", what: "w", points: ["a", "b", "c", "d", "e"], numbers: ["1", "2", "3", "4", "5"], at: "t" },
		{ n: 1, title: "One" },
		{ n: 1.5, title: "no" },
		{ n: 0, title: "no" },
		{ n: "2", title: "no" },
		{ n: 4, title: "", what: "" },
		{ n: 3, title: "Three again", what: "w2" },
		"junk",
		null,
	];
	assert.deepEqual(normSlides(raw).map((s) => [s.n, s.title]), [[1, "One"], [3, "Three again"]]);
	assert.deepEqual(normSlides(raw)[0], { n: 1, title: "One", what: "", why: "", points: [], numbers: [], at: "" });
	assert.deepEqual(normSlides("nope"), []);
	const many = normSlides(Array.from({ length: 150 }, (_, i) => ({ n: i + 1, title: `t${i + 1}` })));
	assert.equal(many.length, MAX_SLIDE_SUMMARIES);
	assert.deepEqual([many[0].n, many.at(-1).n], [31, 150], "the newest 120 are kept");
	assert.deepEqual(withSummary([SUM(1), SUM(3)], SUM(2)).map((s) => s.n), [1, 2, 3]);
	assert.equal(withSummary([SUM(1)], SUM(1, { title: "New" }))[0].title, "New");
	assert.equal(withSummary(many, SUM(200)).length, MAX_SLIDE_SUMMARIES);
});

test("OCR: a leading 'Shared content |' title line is dropped, the rest trimmed and capped at 3k", () => {
	assert.equal(cleanOcr("Shared content | Roadmap.pptx - PowerPoint\nQ3 plan\n7\nOwner: Amy\n"), "Q3 plan\n7\nOwner: Amy", "stray page numbers stay");
	assert.equal(cleanOcr("\n  Shared content | x\n"), "");
	assert.equal(cleanOcr("Q3 plan\nShared content | later line stays"), "Q3 plan\nShared content | later line stays");
	assert.equal(cleanOcr("   "), "");
	const big = cleanOcr("a".repeat(5000));
	assert.ok(big.startsWith("a".repeat(3000)) && big.endsWith("[… cut]") && big.length < 3020);
});

test("waiting for the OCR: missing waits, 0 bytes is no text, a timeout goes on with the image alone", async () => {
	let t = 0;
	const sleeps = [];
	const sleep = async (ms) => {
		sleeps.push(ms);
		t += ms;
	};
	const now = () => t;
	// Missing twice, then there.
	let calls = 0;
	const late = await waitForOcr(async () => (++calls < 3 ? null : "Shared content | Teams\nHello"), { sleep, now });
	assert.deepEqual(late, { text: "Hello", state: "ready" });
	assert.deepEqual(sleeps, [1000, 1000]);
	// 0 bytes: complete, no text, no waiting.
	sleeps.length = 0;
	assert.deepEqual(await waitForOcr(async () => "", { sleep, now }), { text: "", state: "empty" });
	assert.deepEqual(await waitForOcr(async () => "Shared content | Window title only\n", { sleep, now }), { text: "", state: "empty" });
	assert.deepEqual(sleeps, []);
	// Never written: 90 s, then the image alone.
	t = 0;
	let reads = 0;
	const gone = await waitForOcr(async () => (reads++, null), { sleep, now });
	assert.deepEqual(gone, { text: "", state: "timeout" });
	assert.equal(t, 90_000);
	assert.ok(reads >= 90);
	// A shorter timeout, no waiting at all (the meeting ended), an abort.
	t = 0;
	assert.equal((await waitForOcr(async () => null, { sleep, now, timeoutMs: 2500 })).state, "timeout");
	assert.equal(t, 2500);
	t = 0;
	assert.equal((await waitForOcr(async () => null, { sleep, now, noWait: () => true })).state, "timeout");
	assert.equal(t, 0);
	const ac = new AbortController();
	ac.abort();
	assert.equal((await waitForOcr(async () => "x", { sleep, now, signal: ac.signal })).state, "aborted");
});

test("the queue: newest slide first, one at a time, one call per 10 s, 80 slides, revisits never queue", () => {
	const w = newSlideWork();
	for (const n of [1, 2, 3, 4]) assert.equal(queueSlide(w, n, `t${n}`, n * 1000), true);
	assert.equal(queueSlide(w, 3, "again", 0), false, "known already");
	assert.equal(queueSlide(w, 0, "x", 0), false);
	const a = takeSlide(w, 100_000);
	assert.equal(a.n, 4, "the newest first");
	assert.equal(takeSlide(w, 100_000), undefined, "one call at a time");
	noteSlideCall(w, 100_000);
	slideDone(w, a);
	assert.equal(takeSlide(w, 105_000), undefined, "not within 10 s of the last call");
	const b = takeSlide(w, 110_000);
	assert.equal(b.n, 3, "then backwards");
	noteSlideCall(w, 110_000);
	slideDone(w, b);
	// A new slide in the meantime jumps the line.
	queueSlide(w, 5, "t5", 5000);
	assert.equal(takeSlide(w, 120_000).n, 5);
	slideDone(w, { n: 5 });
	assert.equal(queueSlide(w, 5, "t5", 5000), false, "a summarized slide is not queued again");
	assert.deepEqual([...w.done].sort(), [3, 4, 5]);
	// A replay at 10x: 1 s between calls.
	assert.equal(slideGap(1), 10_000);
	assert.equal(slideGap(10), 1000);
	assert.equal(slideGap(100_000), 20);
	// The cap.
	const c = newSlideWork();
	let queued = 0;
	for (let n = 1; n <= 100; n++) if (queueSlide(c, n, "", 0)) queued++;
	assert.equal(queued, SLIDE_CAP);
	assert.equal(SLIDE_CAP, 80);
	// Restored summaries count against the cap, and are never queued.
	const r = newSlideWork();
	markSlideDone(r, 2);
	assert.equal(queueSlide(r, 2, "", 0), false);
	assert.equal(r.seen, 1);
	queueSlide(r, 1, "", 0);
	markSlideDone(r, 1);
	assert.equal(takeSlide(r, 100_000), undefined, "a restored slide leaves the queue");
});

test("failures: back off, retry later, give up after three, no retry storm", () => {
	const w = newSlideWork();
	queueSlide(w, 1, "", 0);
	queueSlide(w, 2, "", 0);
	let job = takeSlide(w, 100_000);
	assert.equal(job.n, 2);
	noteSlideCall(w, 100_000);
	assert.equal(slideFailed(w, job, 100_000, 60_000), "retry");
	assert.equal(takeSlide(w, 130_000), undefined, "on hold: not even the other slide goes");
	job = takeSlide(w, 160_000);
	assert.equal(job.n, 2, "after the backoff the newest due slide goes again");
	noteSlideCall(w, 160_000);
	assert.equal(slideFailed(w, job, 160_000, 120_000), "retry");
	assert.equal(w.streak, 2);
	job = takeSlide(w, 280_000);
	assert.equal(job.n, 2);
	noteSlideCall(w, 280_000);
	assert.equal(slideFailed(w, job, 280_000, 240_000), "gave-up");
	assert.deepEqual([...w.failed], [2]);
	assert.equal(queueSlide(w, 2, "", 0), false, "a given-up slide never comes back");
	assert.equal(takeSlide(w, 300_000), undefined, "still on hold for the other slide");
	job = takeSlide(w, 520_000);
	assert.equal(job.n, 1);
	noteSlideCall(w, 520_000);
	slideDone(w, job);
	assert.deepEqual([w.streak, w.holdUntil], [0, 0], "a success clears the backoff");
});

test("the talk around a slide: 90 s before and after, whatever exists, capped", () => {
	const lines = ["[a] 10:00", "[b] 10:01", "[c] 10:03", "[d] 10:04:10", "[e] 10:05", "[f] 10:06:10", "[g] 10:08", "[h] unknown"];
	const ms = ["10:00:00", "10:01:00", "10:03:00", "10:04:10", "10:05:00", "10:06:10", "10:08:00"].map((t) => Date.parse(`2026-10-28T${t}-05:00`)).concat(0);
	const shown = Date.parse("2026-10-28T10:05:00-05:00");
	const near = nearbyLines(lines, ms, shown);
	assert.deepEqual(near.before, ["[d] 10:04:10", "[e] 10:05"], "90 s back, the moment itself included; lines of unknown time are skipped");
	assert.deepEqual(near.after, ["[f] 10:06:10"], "90 s ahead: later lines don't exist yet or are too far");
	assert.deepEqual(nearbyLines(lines, ms, 0), { before: [], after: [] });
	// A talkative minute: the newest 30 before, the first 30 after.
	const talk = Array.from({ length: 80 }, (_, i) => `[l${i}]`);
	const when = talk.map((_, i) => shown - 80_000 + i * 2000);
	const crowd = nearbyLines(talk, when, shown);
	assert.equal(crowd.before.length, 30);
	assert.equal(crowd.before.at(-1), "[l40]");
	assert.equal(crowd.after.length, 30);
	assert.equal(crowd.after[0], "[l41]");
});

test("the slide prompt: the meeting, who you are, what you work on, the OCR, the talk around it, previous titles", () => {
	const system = buildSlideSystem("Eric Boehs", ["eric", "boehs"], "Engineer on the platform team.");
	assert.match(system, /^You describe one slide from a meeting Eric Boehs is sitting in/);
	assert.match(system, /Eric Boehs may be called eric or boehs/);
	assert.match(system, /<about>\nEngineer on the platform team\.\n<\/about>/);
	assert.match(system, /"why": ONE sentence.*"" \(empty\) is the normal answer.*Do not invent relevance/s);
	assert.match(system, /at most 4 key takeaways/);
	assert.match(system, /no speculation/);
	assert.match(system, /JSON only/);

	const digest = formatDigest(sessionDigest([{ type: "message", message: { role: "user", content: "fix the canary config" } }], "earl"));
	const user = buildSlidePrompt({
		title: "Platform Weekly",
		app: "Teams",
		focus: "learn the rollout date",
		me: "Eric Boehs",
		digest,
		n: 3,
		shownAt: "14:12:10",
		ocr: { text: "Q3 rollout\nCanary 10/28", state: "ready" },
		before: ["[14:11:30] Ada: next slide please"],
		after: ["[14:12:30] Ada: so canary goes Thursday"],
		previous: [{ n: 1, title: "Agenda" }, { n: 2, title: "Status" }],
	});
	assert.match(user, /^Meeting: Platform Weekly \(Teams\)\nEric Boehs's goals for this meeting: learn the rollout date\n\n<session>\nWhat the user is working on right now, from their pi session "earl":\nTheir last messages:\n- fix the canary config\n<\/session>\n/);
	assert.match(user, /<previous_slides>\nTitles of the slides before this one, for continuity:\n1\. Agenda\n2\. Status\n<\/previous_slides>/);
	assert.match(user, /This is slide 3, which came up at 14:12:10\. Its image is attached\.\n<ocr>\nQ3 rollout\nCanary 10\/28\n<\/ocr>/);
	assert.match(user, /<said_before>\n\[14:11:30\] Ada: next slide please\n<\/said_before>\n<said_after>\n\[14:12:30\] Ada: so canary goes Thursday\n<\/said_after>\n\nDescribe the slide\.$/);
	// No OCR text, and no OCR at all.
	assert.match(buildSlidePrompt({ ...base(), ocr: { text: "", state: "empty" } }), /<ocr>\n\(the OCR found no text on this slide\)\n<\/ocr>/);
	const none = buildSlidePrompt({ ...base(), ocr: { text: "", state: "timeout" } });
	assert.match(none, /<ocr>\n\(the OCR text was not ready: go by the image\)\n<\/ocr>/);
	assert.doesNotMatch(none, /<said_before>|<said_after>|<previous_slides>|<session>|goals for this meeting/);
	function base() {
		return { title: "T", app: "", focus: "", me: "", digest: "", n: 1, shownAt: "", before: [], after: [], previous: [] };
	}
});

test("summary text for the tool and the scout; searching a summary matches every word", () => {
	const s = SUM(3, { title: "Q3 Roadmap", what: "Epics by quarter.", why: "Your canary move is on it.", points: ["Canary first"], numbers: ["Oct 28 cutover"] });
	assert.deepEqual(formatSlideSummary(s), ["Summary: Q3 Roadmap", "What it shows: Epics by quarter.", "Why it matters to you: Your canary move is on it.", "Key points:", "- Canary first", "Numbers:", "- Oct 28 cutover"]);
	assert.deepEqual(formatSlideSummary(SUM(1, { title: "T", what: "" })), ["Summary: T"], "empty parts are left out");
	assert.equal(summaryMatches(s, "ROADMAP canary"), true);
	assert.equal(summaryMatches(s, "oct cutover"), true, "numbers too");
	assert.equal(summaryMatches(s, "roadmap kubernetes"), false);
});

test("the scout is told the summary (title, what, why) for slides that have one, raw OCR for the rest", () => {
	const t = formatSlides([
		{ n: 1, at: "14:01:00", text: "raw agenda text", onScreen: false },
		{ n: 2, at: "14:10:00", text: "", onScreen: false, summary: { title: "Status", what: "Red/green table.", why: "" } },
		{ n: 3, at: "14:14:00", text: "", onScreen: true, summary: { title: "Q3 plan", what: "Epics.", why: "Your canary move is on it." } },
	]);
	assert.equal(t, ["<slides>", "What the slides shown so far say:", "Slide 3 (14:14:00), on screen now (summary):", "Q3 plan: Epics. Why it matters: Your canary move is on it.", "Slide 2 (14:10:00) (summary):", "Status: Red/green table.", "Slide 1 (14:01:00):", "raw agenda text", "</slides>"].join("\n"));
});

test("the notes file and the archive carry slides: sorted, bounded; restore and readArchivedSlides read them back", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-slides-"));
	const saved = [process.env.PI_MEETING_NOTES_DIR, process.env.PI_MEETING_NOTES_FILE];
	process.env.PI_MEETING_NOTES_DIR = path.join(dir, "meetings");
	process.env.PI_MEETING_NOTES_FILE = path.join(dir, ".meeting-notes.json");
	try {
		const startedAt = "2026-10-28T14:00:00-05:00";
		const slides = [SUM(5, { why: "relevant", points: ["p"], numbers: ["n"] }), SUM(2), ...Array.from({ length: 150 }, (_, i) => SUM(i + 10))];
		const f = buildNotesFile({ pid: 5, sessionId: "s", sessionName: "", startedAt, appId: "teams", title: "T", at: "A", ended: false, me: [], notes: emptyNotes(), reply: null, alerts: [], alertSeq: 0, slides });
		assert.equal(f.slides.length, 120);
		assert.deepEqual(f.slides.slice(0, 1).map((s) => s.n), [40], "the newest 120 by number");
		const small = buildNotesFile({ ...{ pid: 5, sessionId: "s", sessionName: "", startedAt, appId: "teams", title: "T", at: "A", ended: false, me: [], notes: emptyNotes(), reply: null, alerts: [], alertSeq: 0 }, slides: slides.slice(0, 2) });
		assert.deepEqual(small.slides.map((s) => s.n), [2, 5], "sorted by n");
		assert.deepEqual(Object.keys(small.slides[0]), ["n", "title", "what", "why", "points", "numbers", "at"]);
		writeNotesFile(small);
		writeNotesArchive(small);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.PI_MEETING_NOTES_DIR, `${meetingId("teams", startedAt)}.json`), "utf8")).slides, small.slides, "the archive has them too");
		assert.deepEqual(restoreNotes(startedAt).slides, small.slides, "a reload gets them back");
		assert.deepEqual(readArchivedSlides("teams", startedAt), small.slides);
		assert.deepEqual(readArchivedSlides("zoom", startedAt), [], "another meeting has none");
		assert.deepEqual(readArchivedSlides("teams", ""), []);
		// An older file without slides restores with none.
		const old = JSON.parse(fs.readFileSync(process.env.PI_MEETING_NOTES_FILE, "utf8"));
		delete old.slides;
		fs.writeFileSync(process.env.PI_MEETING_NOTES_FILE, JSON.stringify(old));
		assert.deepEqual(restoreNotes(startedAt).slides, []);
	} finally {
		for (const [i, k] of ["PI_MEETING_NOTES_DIR", "PI_MEETING_NOTES_FILE"].entries()) saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the recap lists slides that matter to you (n. title — why), at most 8; none when no slide has a reason", () => {
	const slides = [SUM(1), SUM(2, { why: "Your canary move is on it." }), SUM(3, { title: "", what: "A chart.", why: "Amy owns it." }), ...Array.from({ length: 10 }, (_, i) => SUM(i + 4, { why: `reason ${i + 4}` }))];
	const body = recapBody(meetingNotes, null, slides);
	const at = body.indexOf("Slides:");
	assert.ok(at > body.indexOf("Open questions:"));
	assert.deepEqual(body.slice(at), ["Slides:", "2. Slide 2 title — Your canary move is on it.", "3. A chart. — Amy owns it.", "4. Slide 4 title — reason 4", "5. Slide 5 title — reason 5", "6. Slide 6 title — reason 6", "7. Slide 7 title — reason 7", "8. Slide 8 title — reason 8", "9. Slide 9 title — reason 9"]);
	assert.equal(recapBody(meetingNotes, null, [SUM(1), SUM(2)]).includes("Slides:"), false, "no why, no Slides section");
	assert.deepEqual(recapBody(emptyNotes(), null, [SUM(2, { why: "x" })]), ["Slides:", "2. Slide 2 title — x"]);
	assert.equal(recapBlock({ title: "T", file, from: "", to: "", updates: 1, notes: meetingNotes, slides }).includes("\nSlides:\n2. Slide 2 title"), true);
});

test("the OCR wait counts from when the slide appeared (live), and is scaled and pickup-based for a replay", () => {
	const now = 1_000_000_000;
	assert.equal(ocrTimeout(now - 1000, now), OCR_WAIT_MS - 1000, "a slide 1 s old has 89 s left");
	assert.equal(ocrTimeout(now - 2 * 60_000, now), 0, "shown minutes ago (a reload's catch-up): no wait at all");
	assert.equal(ocrTimeout(now - OCR_WAIT_MS, now), 0);
	assert.equal(ocrTimeout(now + 60_000, now), OCR_WAIT_MS, "a clock ahead never waits longer than 90 s");
	assert.equal(ocrTimeout(0, now), OCR_WAIT_MS, "no time known: the full wait");
	assert.equal(ocrTimeout(now - 2 * 60_000, now, 10, true), 9000, "a replay: its own times mean nothing here; 90 s scaled by the speed");
	assert.equal(ocrTimeout(now, now, 1_000_000, true), 500, "with a floor");
});

test("slides that will get no summary (given up on, or past the cap) are listed for the canvas, bounded and sorted", () => {
	const w = newSlideWork();
	for (let n = 1; n <= SLIDE_CAP + 3; n++) queueSlide(w, n, "", 0);
	assert.deepEqual([...w.failed].sort((a, b) => a - b), [SLIDE_CAP + 1, SLIDE_CAP + 2, SLIDE_CAP + 3], "the ones past the cap");
	assert.equal(queueSlide(w, SLIDE_CAP + 1, "", 0), false);
	assert.deepEqual(normFailed(new Set([5, 2, 2, 0, -1, 1.5, "3", null, 9])), [2, 5, 9]);
	assert.deepEqual(normFailed("nope"), []);
	assert.equal(normFailed(Array.from({ length: 300 }, (_, i) => i + 1)).length, MAX_SLIDE_SUMMARIES);
	assert.equal(normFailed(Array.from({ length: 300 }, (_, i) => i + 1)).at(-1), 300, "the highest are kept");
});

test("the notes file and the archive say whether summaries run and which slides were given up on; a reload gets the list back", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-slides-on-"));
	const saved = process.env.PI_MEETING_NOTES_FILE;
	process.env.PI_MEETING_NOTES_FILE = path.join(dir, ".meeting-notes.json");
	try {
		const startedAt = "2026-10-28T14:00:00-05:00";
		const base = { pid: 5, sessionId: "s", sessionName: "", startedAt, appId: "teams", title: "T", at: "A", ended: false, me: [], notes: emptyNotes(), reply: null, alerts: [], alertSeq: 0 };
		const off = buildNotesFile(base);
		assert.equal(off.slidesOn, false);
		assert.deepEqual(off.slidesFailed, []);
		const on = buildNotesFile({ ...base, slidesOn: true, slidesFailed: new Set([7, 3, 3, 0]) });
		assert.equal(on.slidesOn, true);
		assert.deepEqual(on.slidesFailed, [3, 7]);
		writeNotesFile(on);
		assert.deepEqual(restoreNotes(startedAt).failed, [3, 7]);
	} finally {
		saved === undefined ? delete process.env.PI_MEETING_NOTES_FILE : (process.env.PI_MEETING_NOTES_FILE = saved);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
