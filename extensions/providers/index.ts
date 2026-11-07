/**
 * providers: two changes to pi's built-in providers, through the public
 * registerProvider() override (a complete pi-ai Provider with the same id
 * replaces the built-in; models.json still applies above it). They used to be
 * patches in Eric's pi fork.
 *
 * 1. disabledProviders (in ~/.pi/agent/settings.json, the fork's key): each
 *    listed provider is re-registered with filterModels returning nothing, so
 *    it drops out of every availability read (/model, cycling, startup
 *    selection, subagent model lists) while its models stay in the catalog and
 *    explicit lookups still resolve. For providers that show up through
 *    ambient credentials, such as AWS environment variables for Amazon Bedrock.
 *
 * 2. zstd for GitHub Copilot: Anthropic Messages request bodies are sent
 *    zstd-compressed (Content-Encoding: zstd). A ~535 KB body uploads ~100 ms
 *    faster per turn. A 400 or 415 to a compressed body is retried once
 *    uncompressed; when that retry is accepted, compression stays off for that
 *    base URL until pi exits. It wraps the built-in provider's stream calls,
 *    passing a fetch through StreamOptions.fetch, which anthropic-messages
 *    hands to its client.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as NodeZlib from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loose shapes: only the members used here, so a pi-ai change elsewhere in Provider can't break the typecheck.
type Fetch = typeof globalThis.fetch;
type Model = { api?: string; baseUrl?: string };
type Options = { fetch?: Fetch } & Record<string, unknown>;
type Provider = {
	id: string;
	stream: (model: Model, context: unknown, options?: Options) => unknown;
	streamSimple: (model: Model, context: unknown, options?: Options) => unknown;
	filterModels?: unknown;
	filterAllModels?: unknown;
};

export const ZSTD_PROVIDER = "github-copilot";
const ZSTD_LEVEL = 3; // as the official Codex client: cheap next to request latency

/** The zstd bytes of a request body, or null when this runtime has no zstd (then it goes uncompressed). */
export function zstd(body: string, zlib: typeof NodeZlib | null = loadZlib()): Uint8Array<ArrayBuffer> | null {
	if (!zlib || typeof zlib.zstdCompressSync !== "function") return null;
	try {
		const out = zlib.zstdCompressSync(body, { params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } });
		return new Uint8Array(out); // owns a plain ArrayBuffer, which fetch accepts as a body
	} catch {
		return null;
	}
}

function loadZlib(): typeof NodeZlib | null {
	const p = process as typeof process & { getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib };
	return p.getBuiltinModule?.("node:zlib") ?? null;
}

/** Base URLs that refused a compressed body; uncompressed from then on, until pi exits. */
export const refused = new Set<string>();

/**
 * fetch that sends a string body zstd-compressed. A 400 or 415 (before any of the response is
 * read) is retried once uncompressed; if that retry is not refused too, the 400/415 was about
 * compression, and the base URL stays uncompressed.
 */
export function zstdFetch(inner: Fetch | undefined, baseUrl: string, compress = zstd): Fetch {
	return async (input, init) => {
		const send = inner ?? globalThis.fetch;
		const body = init?.body;
		if (typeof body !== "string" || refused.has(baseUrl)) return send(input, init);
		const packed = compress(body);
		if (!packed) return send(input, init);
		const headers = new Headers(init?.headers);
		headers.set("content-encoding", "zstd");
		const response = await send(input, { ...init, headers, body: packed });
		if (response.status !== 400 && response.status !== 415) return response;
		await response.body?.cancel().catch(() => {});
		const retry = await send(input, init);
		if (retry.status !== 400 && retry.status !== 415) refused.add(baseUrl);
		return retry;
	};
}

/** The provider with its Anthropic Messages calls sent through zstdFetch; its other APIs unchanged. */
export function withZstd(base: Provider): Provider {
	const inject = (model: Model, options?: Options): Options | undefined =>
		model?.api === "anthropic-messages" ? { ...options, fetch: zstdFetch(options?.fetch, model.baseUrl ?? "") } : options;
	return {
		...base,
		stream: (model, context, options) => base.stream(model, context, inject(model, options)),
		streamSimple: (model, context, options) => base.streamSimple(model, context, inject(model, options)),
	};
}

/** The provider with no available models: gone from /model and cycling, still in the catalog. */
export function disabled(base: Provider): Provider {
	return { ...base, filterModels: () => [], filterAllModels: () => [] };
}

/** `disabledProviders` from the global settings file: provider ids, or [] when unset or unreadable. */
export function disabledProviders(file = settingsFile()): string[] {
	try {
		const list = (JSON.parse(readFileSync(file, "utf8")) as { disabledProviders?: unknown }).disabledProviders;
		return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string" && /^[a-z0-9-]+$/.test(id)) : [];
	} catch {
		return [];
	}
}

function settingsFile(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
}

/** A built-in provider by id: its module under @earendil-works/pi-ai/providers, its one *Provider factory. */
export async function builtin(id: string): Promise<Provider | undefined> {
	try {
		const mod = (await import(`@earendil-works/pi-ai/providers/${id}`)) as Record<string, unknown>;
		const factory = Object.entries(mod).find(([name, value]) => name.endsWith("Provider") && typeof value === "function")?.[1];
		const provider = (factory as (() => Provider) | undefined)?.();
		return provider && provider.id === id ? provider : undefined;
	} catch {
		return undefined;
	}
}

/** Async: pi awaits it, so the overrides are queued before startup picks a model. */
export default async function providers(
	pi: ExtensionAPI,
	options: { load?: typeof builtin; disabled?: string[] } = {},
): Promise<void> {
	const load = options.load ?? builtin;
	const off = new Set(options.disabled ?? disabledProviders());
	const register = (provider: Provider) => (pi.registerProvider as unknown as (p: Provider) => void)(provider);
	for (const id of off) {
		const base = await load(id);
		if (base) register(disabled(base));
	}
	if (!off.has(ZSTD_PROVIDER)) {
		const base = await load(ZSTD_PROVIDER);
		if (base) register(withZstd(base));
	}
}
