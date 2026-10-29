/**
 * watch/settings.ts — the tunable parts of watch.ts, meeting.ts and models.ts,
 * resolved in this order:
 *
 *   1. The environment (PI_WATCH_*, PI_MEETING_*), as before.
 *   2. Boehsline config: blocks "work", "watch" and "meeting" (lib/config.ts),
 *      where other packages (say, a private work companion) add settings, and the user's
 *      ~/.pi/agent/boehsline.json overrides them.
 *   3. Neutral defaults: no workspaces, no bot feed, no work route, no notes.
 *
 * Callers read the exported bindings in watch.ts and models.ts. Those are
 * `export let` values that applySettings() refreshes at session_start, after
 * every package has loaded and registered its settings. Resolving any earlier
 * (at import, or in a factory) could miss a package that loads later.
 *
 * Not an extension: pi loads only top-level files and folders with an index.ts.
 */

import * as os from "node:os";
import * as path from "node:path";
import { type ConfigObject, settingsFor } from "../../../lib/config.ts";

/** A pattern for text that must never reach a model, the screen or the ledger. */
export interface Redaction extends ConfigObject {
	pattern: string;
	/** RegExp flags; "g" is always added. */
	flags: string;
	replace: string;
}

/** Which models may read work text, and how to talk about them. */
export interface WorkSettings extends ConfigObject {
	/** Shown in warnings: "Work text runs only on <label>". */
	label: string;
	/** Providers allowed to read work text. Empty: no model may. */
	providers: string[];
	/** The work scout. */
	models: string[];
	/** Meeting research when the session model can't read work text. */
	researchModel: string;
	/** Named in the scout prompt as data never to repeat, e.g. "employee IDs, ticket numbers". */
	sensitive: string;
	/** GitHub Enterprise host for research hints; "" leaves the line out. */
	ghHost: string;
	redact: Redaction[];
}

export interface FeedSettings extends ConfigObject {
	/** CLI that reads the feed: `<cli> read <channel> … --json`. "" disables the feed. */
	cli: string;
	workspace: string;
	channel: string;
	/** How the feed is named on screen, e.g. "#team-bot-feed". */
	label: string;
}

export interface WatchSettings extends ConfigObject {
	workspaces: string[];
	/** Workspaces whose text goes only to work models. */
	workWorkspaces: string[];
	feed: FeedSettings;
	vips: string[];
	/** ical calendar sources that count as work, for meeting prep. */
	prepSources: string[];
	/** ServiceNow base URL for ticket links; "" means no links. */
	snowUrl: string;
	/** The personal scout. */
	personalModels: string[];
	/** Daily notes folder for the recap; "" disables it. Falls back to meeting.dailyDir. */
	dailyDir: string;
	/** notif-watch binary; "" uses the one Boehsline builds (bin/notif-watch), else PATH. */
	notifBin: string;
}

export interface MeetingSettings extends ConfigObject {
	qmdCollections: string[];
	dailyDir: string;
	/** Where your code lives, for /q research ("Code under <dir>: rg"); "" leaves the hint out. */
	codeDir: string;
	/** Session name (agent-link name) that runs the copilot on its own, e.g. "earl"; "" means none. */
	owner: string;
}

export const WORK_DEFAULTS: WorkSettings = {
	label: "a work model",
	providers: [],
	models: [],
	researchModel: "",
	sensitive: "",
	ghHost: "",
	redact: [],
};

export const WATCH_DEFAULTS: WatchSettings = {
	workspaces: [],
	workWorkspaces: [],
	feed: { cli: "", workspace: "", channel: "", label: "bot feed" },
	vips: [],
	prepSources: [],
	snowUrl: "",
	personalModels: ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
	dailyDir: "",
	notifBin: "",
};

export const MEETING_DEFAULTS: MeetingSettings = { qmdCollections: [], dailyDir: "", codeDir: "", owner: "" };

const list = (raw: string) =>
	raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

/** "~/x" → "$HOME/x". */
export const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

export function workSettings(env: NodeJS.ProcessEnv = process.env): WorkSettings {
	const s = settingsFor("work", WORK_DEFAULTS);
	const models = list(env.PI_WATCH_WORK_MODEL ?? "").filter((m) => m.includes("/"));
	return { ...s, models: models.length ? models : s.models };
}

export function meetingSettings(env: NodeJS.ProcessEnv = process.env): MeetingSettings {
	const s = settingsFor("meeting", MEETING_DEFAULTS);
	return {
		...s,
		qmdCollections: env.PI_MEETING_QMD_COLLECTIONS !== undefined ? list(env.PI_MEETING_QMD_COLLECTIONS) : s.qmdCollections,
		dailyDir: expandHome(env.PI_MEETING_DAILY_DIR ?? s.dailyDir),
		codeDir: env.PI_MEETING_CODE_DIR ?? s.codeDir,
		owner: (env.PI_MEETING_OWNER ?? s.owner).trim(),
	};
}

export function watchSettings(env: NodeJS.ProcessEnv = process.env): WatchSettings {
	const s = settingsFor("watch", WATCH_DEFAULTS);
	const meeting = meetingSettings(env);
	return {
		...s,
		workspaces: env.PI_WATCH_WORKSPACES ? list(env.PI_WATCH_WORKSPACES) : s.workspaces,
		workWorkspaces: env.PI_WATCH_WORK_WORKSPACES !== undefined ? list(env.PI_WATCH_WORK_WORKSPACES) : s.workWorkspaces,
		vips: env.PI_WATCH_VIP !== undefined ? list(env.PI_WATCH_VIP) : s.vips,
		prepSources: env.PI_WATCH_PREP_SOURCES ? list(env.PI_WATCH_PREP_SOURCES) : s.prepSources,
		snowUrl: env.PI_WATCH_SNOW_URL ?? s.snowUrl,
		dailyDir: expandHome(env.PI_WATCH_DAILY_DIR ?? (s.dailyDir || meeting.dailyDir)),
		notifBin: expandHome(s.notifBin),
	};
}

/** Compile redactions, skipping bad patterns rather than failing the watcher. */
export function compileRedactions(rules: readonly Redaction[]): { re: RegExp; replace: string }[] {
	const out: { re: RegExp; replace: string }[] = [];
	for (const r of rules) {
		try {
			const flags = typeof r.flags === "string" ? r.flags : "g";
			out.push({ re: new RegExp(r.pattern, flags.includes("g") ? flags : `${flags}g`), replace: r.replace });
		} catch {
			// a bad pattern redacts nothing; /boehsline config shows it
		}
	}
	return out;
}
