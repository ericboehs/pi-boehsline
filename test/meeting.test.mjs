/**
 * Meeting copilot: transcript parsing, trigger cadence, scout replies, prompts,
 * file picking and the widget.
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
	applyUpdate,
	briefAnswer,
	buildDigPrompt,
	buildSystemPrompt,
	buildUserPrompt,
	canClaim,
	clock,
	createLock,
	currentSlide,
	dailyNoteName,
	filterLive,
	filterRecords,
	formatLine,
	formatLive,
	formatRec,
	formatStatus,
	freshTrigger,
	HOLD_MS,
	isCandidate,
	isInvite,
	isLive,
	isMine,
	isMe,
	isoOffsetMin,
	lastPeople,
	markStopped,
	meetingKey,
	mentionsMe,
	nameMatches,
	nameTokens,
	ocrPath,
	parseArgs,
	parseDigArgs,
	parseDigInput,
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
	pickShown,
	pickStartedSince,
	previousTranscript,
	promptLine,
	queryMatches,
	readLock,
	readStopped,
	recapBlock,
	recapBody,
	recapMarker,
	releaseLock,
	roundedElapsed,
	shouldFire,
	slideCount,
	slideTimes,
	speakerMatches,
	stateReader,
	statusReport,
	stoppedPath,
	toStamp,
	TRIGGER,
	truncateLines,
	upsertRecap,
	writeLock,
	widgetLines,
} from "../extensions/opt-in/meeting/index.ts";

const plain = { fg: (_color, s) => s };
const Q = (id, overrides = {}) => ({ id, q: `question ${id}?`, why: "", at: 0, clock: "11:00", status: "open", ...overrides });

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
});

test("recognizes an invitation for questions", () => {
	assert.ok(isInvite("OK, any questions before we move on?"));
	assert.ok(isInvite("Thoughts?"));
	assert.ok(!isInvite("I had questions about the runner yesterday"));
});

// ── triggers ──

test("nothing new, nothing to do", () => {
	assert.equal(shouldFire(freshTrigger(), 1_000_000), null);
});

test("a batch of lines waits for a pause and the minimum gap", () => {
	const now = 1_000_000;
	const t = { unsent: TRIGGER.batch, firstUnsentAt: now - 10_000, lastLineAt: now - 3_000, lastCallAt: now - 20_000, cue: null };
	assert.equal(shouldFire(t, now), "batch");
	assert.equal(shouldFire({ ...t, lastLineAt: now - 500 }, now), null, "still talking");
	assert.equal(shouldFire({ ...t, lastCallAt: now - 5_000 }, now), null, "checked too recently");
	assert.equal(shouldFire({ ...t, unsent: 2 }, now), null, "too few lines");
});

test("a trickle fires once it has waited long enough", () => {
	const now = 1_000_000;
	const t = { unsent: 2, firstUnsentAt: now - TRIGGER.maxWaitMs, lastLineAt: now - 3_000, lastCallAt: now - 60_000, cue: null };
	assert.equal(shouldFire(t, now), "batch");
});

test("a flood fires without waiting for a pause", () => {
	const now = 1_000_000;
	const t = { unsent: TRIGGER.flood, firstUnsentAt: now - 1_000, lastLineAt: now, lastCallAt: now - 20_000, cue: null };
	assert.equal(shouldFire(t, now), "batch");
});

test("a cue skips the batch size and the gap, but lets the sentence land", () => {
	const now = 1_000_000;
	const t = { unsent: 1, firstUnsentAt: now - 2_000, lastLineAt: now - 2_000, lastCallAt: now - 1_000, cue: "mention" };
	assert.equal(shouldFire(t, now), "cue");
	assert.equal(shouldFire({ ...t, lastLineAt: now - 100 }, now), null);
});

test("a cue never holds back a flood", () => {
	const now = 1_000_000;
	const t = { unsent: TRIGGER.flood, firstUnsentAt: now - 5_000, lastLineAt: now, lastCallAt: now - 20_000, cue: "mention" };
	assert.equal(shouldFire(t, now), "batch");
});

test("once the meeting is over, any leftover lines get a look", () => {
	const now = 1_000_000;
	const t = { unsent: 1, firstUnsentAt: now - 5_000, lastLineAt: now - 5_000, lastCallAt: now - 20_000, cue: null };
	assert.equal(shouldFire(t, now), null);
	assert.equal(shouldFire(t, now, true), "batch");
});

// ── scout replies ──

test("reads the scout's JSON through fences and prose", () => {
	const u = parseScoutReply(
		'Sure:\n```json\n{"topic":"runner migration","add":[{"q":"Who owns the image rebuild?","why":"no owner named"}],"closed":[{"id":"Q2","by":"asked","note":""},{"id":3,"by":"answered","note":"Kyle: Friday"}],"top":["Q4",1],"reply":""}\n```',
	);
	assert.deepEqual(u, {
		topic: "runner migration",
		add: [{ q: "Who owns the image rebuild?", why: "no owner named" }],
		closed: [
			{ id: 2, by: "asked", note: "" },
			{ id: 3, by: "answered", note: "Kyle: Friday" },
		],
		top: [4, 1],
		reply: "",
	});
});

test("tolerates loose shapes and rejects non-JSON", () => {
	const u = parseScoutReply('{"add":["Is Friday firm?", {"question":"Who signs off?"}], "closed":[5, "Q6"], "drop":[1]}');
	assert.deepEqual(u.add, [
		{ q: "Is Friday firm?", why: "" },
		{ q: "Who signs off?", why: "" },
	]);
	assert.deepEqual(u.closed, [
		{ id: 5, by: "answered", note: "" },
		{ id: 6, by: "answered", note: "" },
	]);
	assert.deepEqual(u.top, [], "no top, no ranking");
	assert.equal(parseScoutReply("no questions right now"), null);
	assert.equal(parseScoutReply("{broken"), null);
});

const update = (overrides = {}) => ({ topic: "", add: [], closed: [], top: [], reply: "", ...overrides });

test("an update closes what was answered and adds the rest, deduped against everything", () => {
	const qs = [Q(1, { q: "Is Friday firm?" }), Q(2, { q: "Who signs off?", status: "answered" })];
	const r = applyUpdate(
		qs,
		update({
			add: [{ q: "who signs off", why: "" }, { q: "Does CSOC need a ticket?", why: "Kyle said pending" }],
			closed: [{ id: 1, by: "answered", note: "Blake: yes, Friday" }, { id: 2, by: "asked", note: "" }],
		}),
		3,
		1000,
		"11:05",
		2,
	);
	assert.deepEqual(r.closed, [{ ...qs[0], status: "answered", closedClock: "11:05", note: "Blake: yes, Friday" }]);
	assert.equal(r.questions[1].status, "answered", "an already-closed question stays as it was");
	assert.deepEqual(r.added, [{ id: 3, q: "Does CSOC need a ticket?", why: "Kyle said pending", at: 1000, clock: "11:05", status: "open" }]);
	assert.equal(r.questions.length, 3);
	assert.equal(r.nextId, 4);
});

test("no question leaves the list unless it's closed", () => {
	const qs = [1, 2, 3, 4, 5].map((id) => Q(id));
	const r = applyUpdate(qs, update({ add: [{ q: "one more", why: "" }, { q: "and another", why: "" }] }), 6, 0);
	assert.deepEqual(r.questions.map((q) => q.id), [1, 2, 3, 4, 5, 6], "one add per update by default");
	assert.ok(r.questions.every((q) => q.status === "open"));
});

test("the widget shows new questions first, then the scout's ranking, then the newest", () => {
	const qs = [1, 2, 3, 4, 5].map((id) => Q(id));
	assert.deepEqual(pickShown([], qs, [], 0).map((s) => s.id), [3, 4, 5]);
	assert.deepEqual(pickShown([], qs, [2, 1], 0).map((s) => s.id), [1, 2, 5]);
});

test("a re-ranked question waits for a shown one to have had its time", () => {
	const qs = [1, 2, 3, 4].map((id) => Q(id));
	const shown = [1, 2, 3].map((id) => ({ id, since: 0 }));
	assert.deepEqual(pickShown(shown, qs, [4], HOLD_MS - 1).map((s) => s.id), [1, 2, 3], "Q4 waits");
	const later = pickShown(shown, qs, [4, 1, 2], HOLD_MS);
	assert.deepEqual(later.map((s) => s.id), [1, 2, 4], "Q4 takes the worst-ranked slot");
	assert.equal(later.find((s) => s.id === 4).since, HOLD_MS);
	assert.equal(later.find((s) => s.id === 1).since, 0, "kept questions keep their clock");
});

test("a new question shows at once, bumping one past its hold if there is one", () => {
	const qs = [1, 2, 3, 4].map((id) => Q(id));
	const young = [1, 2, 3].map((id) => ({ id, since: 1000 }));
	assert.deepEqual(pickShown(young, qs, [4], 2000, [4]).map((s) => s.id), [2, 3, 4], "the worst-ranked young one goes");
	const mixed = [{ id: 1, since: 1000 }, { id: 2, since: 0 }, { id: 3, since: 1000 }];
	assert.deepEqual(pickShown(mixed, qs, [4, 1], HOLD_MS, [4]).map((s) => s.id), [1, 3, 4], "Q2 had its time");
});

test("an answered question frees its slot at once", () => {
	const qs = [Q(1, { status: "answered" }), Q(2), Q(3), Q(4)];
	const shown = [1, 2, 3].map((id) => ({ id, since: 0 }));
	assert.deepEqual(pickShown(shown, qs, [4], 10).map((s) => s.id), [2, 3, 4]);
});

// ── prompts ──

const promptInput = (overrides = {}) => ({
	title: "CORE Weekly Sync",
	app: "Microsoft Teams",
	people: ["Jordan Blake", "Eric Boehs"],
	lines: ["[13:00:00] Jordan Blake: Runner cutover is Friday.", "[13:00:05] Kyle: Pending CSOC."],
	newFrom: 0,
	open: [],
	focus: "",
	cue: null,
	me: "Eric Boehs",
	now: new Date(2026, 9, 5, 13, 0, 10),
	...overrides,
});

test("the first look says so; later looks point at the new lines", () => {
	assert.match(buildUserPrompt(promptInput()), /This is your first look\./);
	const later = buildUserPrompt(
		promptInput({
			newFrom: 1,
			open: [Q(4, { q: "Is Friday firm?", why: "no date set" })],
			closed: [Q(2, { q: "Who signs off?", status: "answered" })],
		}),
	);
	assert.match(later, /New since your last update: the lines from \[13:00:05\] Kyle/);
	assert.match(later, /Q4: Is Friday firm\? \(no date set\)/);
	assert.match(later, /Already answered or asked \(don't add again\):\nQ2: Who signs off\?/);
	assert.doesNotMatch(buildUserPrompt(promptInput()), /Already answered/);
});

test("the transcript comes before anything that changes between calls", () => {
	const p = buildUserPrompt(promptInput({ focus: "push for a cutover date", cue: "mention" }));
	assert.ok(p.indexOf("</transcript>") < p.indexOf("Now:"));
	assert.ok(p.indexOf("</transcript>") < p.indexOf("goals for this meeting"));
	assert.match(p, /Eric Boehs was just named/);
});

test("a very long transcript keeps its tail", () => {
	const lines = Array.from({ length: 3000 }, (_, i) => `[13:00:00] A: line ${i} ${"x".repeat(40)}`);
	const p = buildUserPrompt(promptInput({ lines, newFrom: 2999 }));
	assert.match(p, /earlier lines omitted/);
	assert.match(p, /line 2999 /);
	assert.doesNotMatch(p, /line 0 /);
});

test("the system prompt carries the rules, the JSON shape and the background", () => {
	const s = buildSystemPrompt("Eric Boehs", "Engineer on CORE.", "## Notes\n- runner");
	assert.match(s, /live meeting copilot for Eric Boehs/);
	assert.match(s, /"add": \[\{"q"/);
	assert.match(s, /"closed": \[\{"id": 1, "by": "answered"/);
	assert.match(s, /Never close a question just because the conversation moved on/);
	assert.match(s, /<about>\nEngineer on CORE\.\n<\/about>/);
	assert.match(s, /<background>\n## Notes/);
	assert.doesNotMatch(buildSystemPrompt("", "", ""), /<about>|<background>/);
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
	const a = parseArgs("replay 20 ~/x.jsonl --model inco/deepseek-v4.1-flash:fast");
	assert.deepEqual([a.sub, a.replay, a.target, a.model], ["replay", 20, `${os.homedir()}/x.jsonl`, "inco/deepseek-v4.1-flash:fast"]);
	assert.equal(parseArgs("replay").replay, 10, "ten times speed unless told");
	assert.equal(parseArgs("replay core").target, "core");
	assert.equal(parseArgs("replay core").replay, 10);
	assert.equal(parseArgs("start").sub, "start", "start is only a pointer to /meeting watch now");
	assert.equal(parseArgs("core").sub, "unknown", "a bare word no longer starts anything");
	assert.equal(parseArgs("list").sub, "list");
	assert.equal(parseArgs("expand").sub, "list");
	assert.equal(parseArgs("recap").sub, "recap");
});

// ── research ──

test("/q3 and /q 3 name a question, with optional steering", () => {
	assert.deepEqual(parseDigInput("/q3"), { id: 3, steer: "" });
	assert.deepEqual(parseDigInput("  /Q12 check the ATO docs \n"), { id: 12, steer: "check the ATO docs" });
	assert.equal(parseDigInput("/q"), null);
	assert.equal(parseDigInput("/quit"), null);
	assert.equal(parseDigInput("what about /q3"), null);
	assert.deepEqual(parseDigArgs("3"), { id: 3, steer: "" });
	assert.deepEqual(parseDigArgs("Q3 who owns it"), { id: 3, steer: "who owns it" });
	assert.equal(parseDigArgs(""), null);
	assert.equal(parseDigArgs("three"), null);
});

test("the brief's Answer line is the one-liner", () => {
	assert.equal(briefAnswer("Answer: Kyle's team owns DR, per the Sept runbook\n- runbook.md\nAsk: ..."), "Kyle's team owns DR, per the Sept runbook");
	assert.equal(briefAnswer("**Answer:** Not found\n- searched Slack"), "Not found");
	assert.equal(briefAnswer("\nNo answer line here\nmore"), "No answer line here");
	assert.equal(briefAnswer(`Answer: ${"x".repeat(300)}`).length, 160);
	const long = briefAnswer(`Answer: ${"milestone one closes on discovery, ".repeat(8)}`);
	assert.ok(long.length <= 160 && / (milestone|one|closes|on|discovery)…$/.test(long), `cut mid-word: ${long}`);
});

test("a research subagent gets the question, why, steer, background and the transcript tail", () => {
	const lines = Array.from({ length: 400 }, (_, i) => `[11:${String(i % 60).padStart(2, "0")}] Kyle: line ${i} ${"words ".repeat(5)}`);
	const { system, task } = buildDigPrompt({
		me: "Eric Boehs",
		about: "I work on CORE.",
		title: "EI: Cloud Config",
		app: "teams",
		question: Q(3, { q: "How did 97 systems pass ATO with no DR?", why: "0/97 with DR" }),
		steer: "check eMASS notes",
		lines,
		clock: "11:39",
	});
	assert.match(system, /Return only the brief/);
	assert.match(system, /under 3 minutes/);
	assert.match(system, /Read only/);
	assert.match(system, /qmd search/);
	assert.match(system, /^Answer: /m);
	assert.match(task, /^Meeting: EI: Cloud Config \(teams\) · now 11:39$/m);
	assert.match(task, /^Research Q3: How did 97 systems pass ATO with no DR\?$/m);
	assert.match(task, /^Why it came up: 0\/97 with DR$/m);
	assert.match(task, /^Eric Boehs adds: check eMASS notes$/m);
	assert.match(task, /<about>\nI work on CORE\.\n<\/about>/);
	assert.ok(task.includes("line 399"), "keeps the latest lines");
	assert.ok(!task.includes("line 0 "), "drops the oldest");
	assert.ok(task.length < 9000, `${task.length} chars`);
});

// ── recap ──

const meetingQs = [
	Q(1, { q: "Who picks the candidate systems?", status: "answered", note: "Kyle's team, by Friday", clock: "11:09", closedClock: "11:13" }),
	Q(2, { q: "Is the explainer due this week?", status: "asked", clock: "11:10", closedClock: "11:10" }),
	Q(3, { q: "How did 97 systems pass ATO with no DR recorded?", why: "Eric found 0/97 with DR", clock: "11:17" }),
];

test("the recap groups every question by outcome", () => {
	assert.deepEqual(recapBody(meetingQs), [
		"Still open (never asked):",
		"- Q3 How did 97 systems pass ATO with no DR recorded? (11:17; Eric found 0/97 with DR)",
		"",
		"Answered:",
		"- Q1 Who picks the candidate systems? → Kyle's team, by Friday (11:09–11:13)",
		"",
		"Asked:",
		"- Q2 Is the explainer due this week? (11:10)",
	]);
	assert.deepEqual(recapBody([]), ["No questions came up."]);
});

test("a researched question carries its answer into the recap", () => {
	const qs = [...meetingQs];
	qs[2] = { ...qs[2], dig: { state: "done", startedAt: 0, answer: "Inherited from the GovCloud package" } };
	qs[1] = { ...qs[1], dig: { state: "failed", startedAt: 0, error: "timed out" } };
	const body = recapBody(qs);
	assert.deepEqual(body.slice(0, 3), [
		"Still open (never asked):",
		"- Q3 How did 97 systems pass ATO with no DR recorded? (11:17; Eric found 0/97 with DR)",
		"  - Researched: Inherited from the GovCloud package",
	]);
	assert.ok(!body.some((l) => l.includes("timed out")), "a failed run leaves no trace");
});

const file = `${os.homedir()}/.local/share/meeting-capture/20261006_110421-teams-ei-cloud-config.jsonl`;
const block = recapBlock({ title: "EI: Cloud Config", file, from: "11:04", to: "11:20", checks: 14, questions: meetingQs });
const marker = recapMarker(file);

test("the daily-note block has a heading, a hidden marker and the transcript", () => {
	const lines = block.split("\n");
	assert.equal(lines[0], "### 11:04–11:20 EI: Cloud Config · copilot questions");
	assert.equal(lines[1], "<!-- meeting-copilot:20261006_110421-teams-ei-cloud-config -->");
	assert.equal(lines[2], "Transcript: `~/.local/share/meeting-capture/20261006_110421-teams-ei-cloud-config.txt` · 14 checks");
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
	const newer = block.replace("14 checks", "15 checks");
	const twice = upsertRecap(once, newer, marker);
	assert.equal(twice, once.replace("14 checks", "15 checks"));
	assert.equal(twice.split(marker).length, 2, "one block");
	assert.equal(upsertRecap(twice, newer, marker), twice, "idempotent");
});

test("two meetings stack under the heading; a note without one gets the section", () => {
	const other = recapBlock({ title: "Fraud sync", file: "/x/20261006_140500-teams-fraud.jsonl", from: "14:05", to: "14:30", checks: 3, questions: [] });
	const both = upsertRecap(upsertRecap(note, block, marker), other, recapMarker("/x/20261006_140500-teams-fraud.jsonl"));
	assert.ok(both.indexOf("EI: Cloud Config · copilot") < both.indexOf("Fraud sync · copilot"));
	assert.ok(both.indexOf("Fraud sync · copilot") < both.indexOf("## Standup"));
	assert.equal(upsertRecap("# Tue\n\nnotes", "### x", "m"), "# Tue\n\nnotes\n\n## Meetings\n\n### x\n");
	assert.equal(upsertRecap("", "### x", "m"), "## Meetings\n\n### x\n");
});

// ── widget ──

const view = (overrides = {}) => ({
	phase: "live",
	title: "CORE Weekly Sync",
	startedMs: 0,
	topic: "runner migration",
	checks: 3,
	cost: 0,
	busy: false,
	error: "",
	questions: [],
	shown: [],
	expanded: false,
	reply: "",
	replay: false,
	endsAt: 0,
	...overrides,
});

test("waiting shows one line", () => {
	assert.deepEqual(widgetLines(view({ phase: "waiting", title: "Weekly Sync" }), plain, 120), ["◌ meeting · Weekly Sync · waiting for captions · /meeting stop"]);
	assert.deepEqual(widgetLines(view({ phase: "waiting", title: "" }), plain, 120), ["◌ meeting · waiting for captions · /meeting stop"]);
});

test("live shows the header, the shown questions, what's hidden, and a reply", () => {
	const now = 1_000_000_000;
	const lines = widgetLines(
		view({
			startedMs: now - 16 * 60_000,
			questions: [Q(1), Q(2, { status: "answered" }), Q(3, { q: "Is the Friday cutover still blocked on CSOC?", why: "Kyle said pending" }), Q(4)],
			shown: [3],
			reply: "Yes, PR is up and waiting on review.",
		}),
		plain,
		120,
		now,
	);
	assert.deepEqual(lines, [
		"● meeting · CORE Weekly Sync · 16m · runner migration · 3 checks · /meeting stop",
		"  Q3 Is the Friday cutover still blocked on CSOC? — Kyle said pending",
		"  +2 more open · 1 answered or asked · /meeting list",
		"  ↳ say: Yes, PR is up and waiting on review.",
	]);
});

test("expanded lists every question, open first", () => {
	const lines = widgetLines(
		view({ expanded: true, shown: [3], questions: [Q(1), Q(2, { status: "answered", note: "Friday" }), Q(3), Q(4, { status: "asked" })] }),
		plain,
		120,
	);
	assert.deepEqual(lines.slice(1), [
		"  Q1 question 1?",
		"  Q3 question 3?",
		"  ✓ Q2 question 2? → Friday",
		"  ✓ Q4 question 4? (asked)",
		"  /meeting list to collapse",
	]);
});

test("expanded stays bounded however long the meeting runs", () => {
	const questions = Array.from({ length: 40 }, (_, i) => Q(i + 1, { status: i < 25 ? "answered" : "open" }));
	const lines = widgetLines(view({ expanded: true, questions }), plain, 120);
	assert.ok(lines.length <= 21, `${lines.length} lines`);
	assert.ok(lines.includes("  Q40 question 40?"), "every open question fits here");
	assert.ok(lines.some((l) => /✓ \d+ more answered or asked · \/meeting recap/.test(l)));
});

test("an ended call counts down to the stop", () => {
	const now = 1_000_000;
	const head = (v) => widgetLines(view({ phase: "ended", ...v }), plain, 200, now)[0];
	assert.match(head({ endsAt: now + 72_000 }), / · call ended · stopping in 1:12 unless it resumes · /);
	assert.match(head({ endsAt: now - 1 }), / · call ended · /);
	assert.match(head({ replay: true }), / · replay done · /);
});

test("research shows a timer while it runs and the answer once it lands", () => {
	const now = 1_000_000;
	const lines = widgetLines(
		view({
			questions: [
				Q(1, { dig: { state: "running", startedAt: now - 80_000 } }),
				Q(2, { dig: { state: "done", startedAt: 0, answer: "Kyle's team, per the runbook" } }),
				Q(3, { dig: { state: "failed", startedAt: 0, error: "x" } }),
			],
			shown: [1, 2, 3],
		}),
		plain,
		120,
		now,
	);
	assert.deepEqual(lines.slice(1), [
		"  Q1 🔎 1:20 question 1?",
		"  Q2 🔎✓ question 2?",
		"    → Kyle's team, per the runbook",
		"  Q3 🔎✕ question 3?",
	]);
	const ended = (v) => widgetLines(view({ phase: "ended", questions: [Q(1, { dig: { state: "running", startedAt: now } })], ...v }), plain, 200, now)[0];
	assert.match(ended({ endsAt: now - 1 }), / · call ended · finishing research · /);
	assert.match(ended({ replay: true }), / · replay done · finishing research · /);
	assert.match(ended({ endsAt: now + 5000 }), /stopping in 0:05/, "the countdown still shows first");
});

test("every widget line fits the width", () => {
	const lines = widgetLines(view({ questions: [Q(1, { q: "a long question ".repeat(12), why: "because ".repeat(6) })], shown: [1], busy: true }), plain, 40);
	assert.ok(lines.length > 2);
	for (const l of lines) assert.ok(visibleWidth(l) <= 40, `too wide: ${JSON.stringify(l)}`);
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
