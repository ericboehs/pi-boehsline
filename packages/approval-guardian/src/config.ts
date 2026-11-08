import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DENY_CONFIG, DEFAULT_SECRET_COMMANDS, type DenyConfig, type SecretCommandConfig } from "./hard-deny.ts";
import {
	DEFAULT_REVIEWER_MODEL,
	REVIEW_TIMEOUT_MS,
	parseModelSpec,
} from "./review.ts";

export const MODEL_ENV = "PI_APPROVAL_GUARDIAN_MODEL";
export const FALLBACK_MODEL_ENV = "PI_APPROVAL_GUARDIAN_FALLBACK_MODEL";
export const POLICY_ENV = "PI_APPROVAL_GUARDIAN_POLICY";
export const TIMEOUT_ENV = "PI_APPROVAL_GUARDIAN_TIMEOUT_MS";
export const CONFIG_FILE_NAME = "approval-guardian.json";

export type ReviewLevel =
	| "always"
	| "outside-or-private"
	| "private-only"
	| "off";

export const DEFAULT_REVIEW_RULES: Readonly<Record<string, ReviewLevel>> = {
	"bash.command": "always",
	"read.path": "private-only",
	"grep.path": "outside-or-private",
	"find.path": "private-only",
	"ls.path": "private-only",
	"write.path": "outside-or-private",
	"edit.path": "outside-or-private",
};

interface GuardianConfigFile {
	model?: unknown;
	fallbackModel?: unknown;
	timeoutMs?: unknown;
	policy?: unknown;
	review?: unknown;
	deny?: unknown;
	secretCommands?: unknown;
}

type ConfigSource = "environment" | "project" | "global" | "default";

export interface GuardianConfig {
	model: string;
	fallbackModel: string;
	timeoutMs: number;
	policy?: string;
	review: Record<string, ReviewLevel>;
	/** Hard deny (hard-deny.ts): global `deny.paths`/`deny.commands` replace the defaults, a project's only add. */
	deny: DenyConfig;
	/** Secret CLIs reviewed as private-data reads (hard-deny.ts): global lists replace, a project's patterns add. */
	secretCommands: SecretCommandConfig;
	globalPath: string;
	projectPath: string;
	globalConfigPresent: boolean;
	projectConfigPresent: boolean;
	modelSource: ConfigSource;
	fallbackModelSource: ConfigSource;
	timeoutSource: ConfigSource;
	policySources: Array<"environment" | "project" | "global">;
	warnings: string[];
}

export interface LoadGuardianConfigOptions {
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
}

export function loadGuardianConfig(
	options: LoadGuardianConfigOptions,
): GuardianConfig {
	const agentDir = options.agentDir ?? getAgentDir();
	const env = options.env ?? process.env;
	const globalPath = join(agentDir, CONFIG_FILE_NAME);
	const projectPath = join(options.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
	const warnings: string[] = [];
	if (env[MODEL_ENV] !== undefined && !isModelSpecString(env[MODEL_ENV])) {
		warnings.push(`Invalid ${MODEL_ENV}: expected provider/model-id.`);
	}
	if (
		env[FALLBACK_MODEL_ENV] !== undefined &&
		!isModelSpecString(env[FALLBACK_MODEL_ENV])
	) {
		warnings.push(
			`Invalid ${FALLBACK_MODEL_ENV}: expected provider/model-id.`,
		);
	}
	if (
		env[TIMEOUT_ENV] !== undefined &&
		firstTimeout(env[TIMEOUT_ENV]) === undefined
	) {
		warnings.push(
			`Invalid ${TIMEOUT_ENV}: expected an integer from 1000 to 300000.`,
		);
	}
	const globalConfig = readConfigFile(globalPath, warnings);
	const projectConfig = options.projectTrusted
		? readConfigFile(projectPath, warnings)
		: {};

	const modelValue = firstModelWithSource(
		["environment", env[MODEL_ENV]],
		["project", projectConfig.model],
		["global", globalConfig.model],
	);
	const fallbackModelValue = firstModelWithSource(
		["environment", env[FALLBACK_MODEL_ENV]],
		["project", projectConfig.fallbackModel],
		["global", globalConfig.fallbackModel],
	);
	const timeoutValue = firstTimeoutWithSource(
		["environment", env[TIMEOUT_ENV]],
		["project", projectConfig.timeoutMs],
		["global", globalConfig.timeoutMs],
	);
	const policies = [
		["global", globalConfig.policy],
		["project", projectConfig.policy],
		["environment", env[POLICY_ENV]],
	] as const;
	const policySources = policies.flatMap(([source, value]) =>
		typeof value === "string" && value.trim().length > 0 ? [source] : [],
	);

	const globalReview = parseReviewRules(
		globalConfig.review,
		globalPath,
		warnings,
	);
	const projectReview = parseReviewRules(
		projectConfig.review,
		projectPath,
		warnings,
	);
	const review = mergeReviewRules(globalReview, projectReview);
	const globalDeny = parseDeny(globalConfig.deny, globalPath, warnings);
	const projectDeny = parseDeny(projectConfig.deny, projectPath, warnings);
	// A project adds paths only: its regular expressions would run in every tool call, and one
	// that backtracks badly would hang pi.
	if (projectDeny.commands) warnings.push(`Ignored deny.commands in ${projectPath}: only the global config may add command rules.`);
	if (projectDeny.allow) warnings.push(`Ignored deny.allow in ${projectPath}: only the global config may make exceptions.`);
	if (globalDeny.paths?.length === 0) warnings.push(`deny.paths in ${globalPath} is empty: the deny list protects no folders.`);
	const deny: DenyConfig = {
		paths: [...new Set([...(globalDeny.paths ?? DEFAULT_DENY_CONFIG.paths), ...(projectDeny.paths ?? [])])],
		commands: [...(globalDeny.commands ?? DEFAULT_DENY_CONFIG.commands)],
		allow: [...(globalDeny.allow ?? DEFAULT_DENY_CONFIG.allow ?? [])],
		// The config files themselves: an approved write must not empty the list.
		protect: [globalPath, projectPath],
	};
	const globalSecret = parseRegexLists(globalConfig.secretCommands, ["patterns", "allow"], "secretCommands", globalPath, warnings);
	const projectSecret = parseRegexLists(projectConfig.secretCommands, ["patterns", "allow"], "secretCommands", projectPath, warnings);
	if (projectSecret.allow || projectSecret.patterns) warnings.push(`Ignored secretCommands in ${projectPath}: only the global config may set them.`);
	const secretCommands: SecretCommandConfig = {
		patterns: [...(globalSecret.patterns ?? DEFAULT_SECRET_COMMANDS.patterns)],
		allow: [...(globalSecret.allow ?? DEFAULT_SECRET_COMMANDS.allow)],
	};

	return {
		model: modelValue?.value ?? DEFAULT_REVIEWER_MODEL,
		fallbackModel: fallbackModelValue?.value ?? DEFAULT_REVIEWER_MODEL,
		timeoutMs: timeoutValue?.value ?? REVIEW_TIMEOUT_MS,
		policy:
			policySources.length > 0
				? policies
						.flatMap(([, value]) =>
							typeof value === "string" && value.trim() ? [value.trim()] : [],
						)
						.join("\n\n")
				: undefined,
		review,
		deny,
		secretCommands,
		globalPath,
		projectPath,
		globalConfigPresent: existsSync(globalPath),
		projectConfigPresent: existsSync(projectPath),
		modelSource: modelValue?.source ?? "default",
		fallbackModelSource: fallbackModelValue?.source ?? "default",
		timeoutSource: timeoutValue?.source ?? "default",
		policySources,
		warnings,
	};
}

function readConfigFile(path: string, warnings: string[]): GuardianConfigFile {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`Invalid ${path}: expected a JSON object.`);
			return {};
		}
		const config = parsed as GuardianConfigFile;
		validateConfigFile(config, path, warnings);
		return config;
	} catch (error) {
		warnings.push(
			`Invalid or unreadable ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

const CONFIG_FILE_KEYS = new Set([
	"model",
	"fallbackModel",
	"timeoutMs",
	"policy",
	"review",
	"deny",
	"secretCommands",
]);

const REVIEW_LEVEL_RANK: Record<ReviewLevel, number> = {
	off: 0,
	"private-only": 1,
	"outside-or-private": 2,
	always: 3,
};

function mergeReviewRules(
	globalRules: Record<string, ReviewLevel>,
	projectRules: Record<string, ReviewLevel>,
): Record<string, ReviewLevel> {
	const effective: Record<string, ReviewLevel> = {
		...DEFAULT_REVIEW_RULES,
		...globalRules,
	};
	for (const [key, projectLevel] of Object.entries(projectRules)) {
		const floor = effective[key] ?? "private-only";
		effective[key] =
			REVIEW_LEVEL_RANK[projectLevel] > REVIEW_LEVEL_RANK[floor]
				? projectLevel
				: floor;
	}
	return effective;
}

function validateConfigFile(
	config: GuardianConfigFile,
	path: string,
	warnings: string[],
): void {
	for (const key of Object.keys(config)) {
		if (!CONFIG_FILE_KEYS.has(key)) {
			warnings.push(`Unknown top-level key ${key} in ${path}.`);
		}
	}
	if (config.model !== undefined && !isModelSpecString(config.model)) {
		warnings.push(`Invalid model in ${path}: expected provider/model-id string.`);
	}
	if (
		config.fallbackModel !== undefined &&
		!isModelSpecString(config.fallbackModel)
	) {
		warnings.push(
			`Invalid fallbackModel in ${path}: expected provider/model-id string.`,
		);
	}
	if (
		config.timeoutMs !== undefined &&
		firstTimeout(config.timeoutMs) === undefined
	) {
		warnings.push(
			`Invalid timeoutMs in ${path}: expected an integer from 1000 to 300000.`,
		);
	}
	if (config.policy !== undefined && typeof config.policy !== "string") {
		warnings.push(`Invalid policy in ${path}: expected a string.`);
	}
}

function parseDeny(value: unknown, path: string, warnings: string[]): Partial<DenyConfig> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`Invalid deny in ${path}: expected an object with paths and/or commands.`);
		return {};
	}
	const out: Partial<DenyConfig> = {};
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "paths" && key !== "commands" && key !== "allow") warnings.push(`Unsupported deny.${key} in ${path}.`);
	}
	for (const key of ["paths", "commands", "allow"] as const) {
		const list = record[key];
		if (list === undefined) continue;
		if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.trim())) {
			warnings.push(`Invalid deny.${key} in ${path}: expected an array of non-empty strings.`);
			continue;
		}
		if (key === "commands") {
			const bad = list.filter((item) => {
				try {
					new RegExp(item, "i");
					return false;
				} catch {
					return true;
				}
			});
			if (bad.length) warnings.push(`Invalid deny.commands in ${path}: ${bad.length} not a regular expression.`);
			out.commands = list.filter((item) => !bad.includes(item)).map((item) => item.trim());
		} else out[key] = list.map((item) => item.trim());
	}
	return out;
}

function parseRegexLists(value: unknown, keys: string[], name: string, path: string, warnings: string[]): Record<string, string[] | undefined> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`Invalid ${name} in ${path}: expected an object with ${keys.join(" and/or ")}.`);
		return {};
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) if (!keys.includes(key)) warnings.push(`Unsupported ${name}.${key} in ${path}.`);
	const out: Record<string, string[] | undefined> = {};
	for (const key of keys) {
		const list = record[key];
		if (list === undefined) continue;
		if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.trim())) {
			warnings.push(`Invalid ${name}.${key} in ${path}: expected an array of regular expressions.`);
			continue;
		}
		const good = list.filter((item) => {
			try {
				new RegExp(item, "i");
				return true;
			} catch {
				return false;
			}
		});
		if (good.length < list.length) warnings.push(`Invalid ${name}.${key} in ${path}: ${list.length - good.length} not a regular expression.`);
		out[key] = good;
	}
	return out;
}

function parseReviewRules(
	value: unknown,
	path: string,
	warnings: string[],
): Record<string, ReviewLevel> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`Invalid review in ${path}: expected an object.`);
		return {};
	}
	const rules: Record<string, ReviewLevel> = {};
	for (const [key, level] of Object.entries(value)) {
		if (!isReviewRuleKey(key)) {
			warnings.push(`Unsupported review.${key} in ${path}.`);
			continue;
		}
		if (
			level === "always" ||
			level === "outside-or-private" ||
			level === "private-only" ||
			level === "off"
		) {
			rules[key] = level;
		} else {
			warnings.push(
				`Invalid review.${key} in ${path}: expected always, outside-or-private, private-only, or off.`,
			);
		}
	}
	return rules;
}

function isReviewRuleKey(key: string): boolean {
	if (Object.hasOwn(DEFAULT_REVIEW_RULES, key)) return true;
	const toolName = key.endsWith(".path") ? key.slice(0, -".path".length) : "";
	return toolName.length > 0 && !/\s/.test(toolName);
}

function isModelSpecString(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		parseModelSpec(value) !== undefined
	);
}

function firstModelWithSource(
	...values: Array<[GuardianConfig["modelSource"], unknown]>
): { source: GuardianConfig["modelSource"]; value: string } | undefined {
	for (const [source, value] of values) {
		if (isModelSpecString(value)) {
			return { source, value: value.trim() };
		}
	}
	return undefined;
}

function firstTimeoutWithSource(
	...values: Array<[GuardianConfig["timeoutSource"], unknown]>
): { source: GuardianConfig["timeoutSource"]; value: number } | undefined {
	for (const [source, value] of values) {
		const timeout = firstTimeout(value);
		if (timeout !== undefined) return { source, value: timeout };
	}
	return undefined;
}

function firstTimeout(...values: unknown[]): number | undefined {
	for (const value of values) {
		const parsed =
			typeof value === "number"
				? value
				: typeof value === "string"
					? Number(value)
					: NaN;
		if (Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 300_000)
			return parsed;
	}
	return undefined;
}
