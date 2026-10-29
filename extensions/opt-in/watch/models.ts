/**
 * watch/models.ts — which models may read which text. Shared by watch.ts and
 * meeting.ts. Not an extension: pi loads only top-level files and folders with
 * an index.ts.
 *
 * Work text (work Slack, Outlook, Teams, calendar alerts, meetings) goes only to
 * the work providers (watch/settings.ts "work"). When no work model answers,
 * code rules decide; work text never falls back to a personal model. Personal
 * text goes to the personal scout. With no work providers configured, no model
 * reads work text at all.
 */

import { WATCH_DEFAULTS, WORK_DEFAULTS, type WorkSettings, watchSettings, workSettings } from "./settings.ts";

/** Providers allowed to read work text. */
export let WORK_PROVIDERS: readonly string[] = WORK_DEFAULTS.providers;
/** The work scout. */
export let WORK_MODELS: readonly string[] = WORK_DEFAULTS.models;
/** How warnings name the work models: "Work text runs only on <label>". */
export let WORK_LABEL = WORK_DEFAULTS.label;
/** The personal scout: flat-subscription models first; pay-per-token ones only by explicit opt-in. */
export let PERSONAL_MODELS: readonly string[] = WATCH_DEFAULTS.personalModels;

/** Refresh from settings (session_start). Tests pass a WorkSettings directly. */
export function applyWorkSettings(work: WorkSettings = workSettings(), personal: readonly string[] = watchSettings().personalModels): void {
	WORK_PROVIDERS = work.providers.map((p) => p.toLowerCase());
	WORK_MODELS = work.models;
	WORK_LABEL = work.label;
	PERSONAL_MODELS = personal;
}

/** Scout prompts stay well under the smallest provider prompt cap we route to (100k tokens). */
export const PROMPT_MAX_TOKENS = 60_000;
/** Rough and on the high side (~3 chars a token), so a fitted prompt never trips the cap. */
export const estTokens = (text: string) => Math.ceil(text.length / 3);

/** "a/b, c/d" → ["a/b", "c/d"]; anything without a provider is ignored. */
export const modelSpecs = (raw: string | undefined) => (raw ?? "").split(/[\s,]+/).filter((s) => s.includes("/"));

export const isWorkModel = (spec: string) => WORK_PROVIDERS.includes(spec.slice(0, spec.indexOf("/")).toLowerCase());

/** Specs that may read work text, and the ones refused (to report, never to use). */
export function workOnly(specs: readonly string[]): { ok: string[]; refused: string[] } {
	return { ok: specs.filter(isWorkModel), refused: specs.filter((s) => !isWorkModel(s)) };
}
