/**
 * cursor-agent settings: Boehsline config, then PI_CURSOR_* env vars on top.
 *
 *   // ~/.pi/agent/boehsline.json, or a config source such as a work package
 *   "cursor-agent": {
 *     "defaultModel": "composer-2.5",
 *     "blockedModels": ["fable"],
 *     "blockedReason": "no zero data retention",
 *     "note": "Work seat: never send customer data or secrets.",
 *     "rules": ["Never put customer data in the cursor tool's prompt."]
 *   }
 *
 * Env vars replace the matching setting for one shell or one `pi -e` run:
 *   PI_CURSOR_MODEL           defaultModel
 *   PI_CURSOR_BLOCKED_MODELS  blockedModels, comma-separated
 *   PI_CURSOR_BLOCKED_REASON  blockedReason
 *   PI_CURSOR_NOTE            note
 *   PI_CURSOR_RULES           rules, one per line (or separated by " || ")
 *
 * Pure node (no pi imports), so tests run under plain `node --test`.
 */

import { type ConfigObject, settingsFor } from "../../../lib/config.ts";

export interface CursorSettings {
	/** Model id when the tool call names none. "auto" lets Cursor pick. */
	defaultModel: string;
	/** Case-insensitive substrings; a model id containing one is refused. */
	blockedModels: string[];
	/** Why blocked models are refused, shown in the error. */
	blockedReason: string;
	/** Appended to the tool description the model reads. */
	note: string;
	/** Extra prompt rules, each naming the cursor tool. */
	rules: string[];
}

export const DEFAULTS: CursorSettings = {
	defaultModel: "auto",
	blockedModels: [],
	blockedReason: "blocked by your cursor-agent settings",
	note: "",
	rules: [],
};

const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const strList = (v: unknown, fallback: string[]): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : fallback;

/** Normalize a raw settings block (from config) into typed settings. */
export function normalize(raw: Record<string, unknown>): CursorSettings {
	return {
		defaultModel: str(raw.defaultModel, DEFAULTS.defaultModel).trim() || DEFAULTS.defaultModel,
		blockedModels: strList(raw.blockedModels, DEFAULTS.blockedModels),
		blockedReason: str(raw.blockedReason, DEFAULTS.blockedReason).trim() || DEFAULTS.blockedReason,
		note: str(raw.note, DEFAULTS.note).trim(),
		rules: strList(raw.rules, DEFAULTS.rules),
	};
}

/** Env vars replace whole settings; an empty var counts as unset. */
export function applyEnv(s: CursorSettings, env: NodeJS.ProcessEnv = process.env): CursorSettings {
	const out = { ...s };
	const v = (k: string) => {
		const x = env[k]?.trim();
		return x ? x : undefined;
	};
	const model = v("PI_CURSOR_MODEL");
	if (model) out.defaultModel = model;
	const blocked = v("PI_CURSOR_BLOCKED_MODELS");
	if (blocked) out.blockedModels = blocked.split(",").map((x) => x.trim()).filter(Boolean);
	const reason = v("PI_CURSOR_BLOCKED_REASON");
	if (reason) out.blockedReason = reason;
	const note = v("PI_CURSOR_NOTE");
	if (note) out.note = note;
	const rules = v("PI_CURSOR_RULES");
	if (rules) out.rules = rules.split(/\n|\s\|\|\s/).map((x) => x.trim()).filter(Boolean);
	return out;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): CursorSettings {
	return applyEnv(normalize(settingsFor("cursor-agent", DEFAULTS as unknown as ConfigObject)), env);
}

/** The blocked entry a model id matches, if any. */
export function blockedBy(model: string, s: CursorSettings): string | undefined {
	const id = model.toLowerCase();
	return s.blockedModels.find((b) => id.includes(b.toLowerCase()));
}
