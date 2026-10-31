// image-prune: drop old images from the model's context once they add up.
//
// pi resends every image in context as base64 on every request until the
// next compaction, and base64 PNGs don't compress. Over 14 days a third of
// requests carried images: median 2 MB, p90 10 MB, worst 23 MB (33 PNGs).
//
// At turn_end, when the images the next request would send exceed thresholdMB,
// this appends one batch of context_edit replacements: every entry with images
// older than the last keepTurns user turns keeps its text, role and metadata,
// and each image becomes a one-line note with a path the read tool can open.
// Pasted or tool-made images with no file are saved first under
// ~/.pi/agent/tmp/image-prune/. A read tool result points at the file it read.
//
// Why turn_end and durable edits rather than the per-request `context` hook:
// the edits are session entries, so every later request starts with the same
// prefix and the prompt cache holds. One batch, only past the threshold, so
// the cache is rewritten once per few megabytes of images instead of every
// turn. No `continue`: the edits simply apply to the next request.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	type ContextEditEntryDraft,
	type ExtensionAPI,
	type ExtensionContext,
	type ProjectedSessionEntry,
	resizeImage,
} from "@earendil-works/pi-coding-agent";
import { settingsFor } from "../../../lib/config.ts";
import { optIn } from "../../../lib/opt-in.ts";
import {
	DEFAULTS,
	extensionFor,
	formatBytes,
	type ImageBlock,
	type ImageEntry,
	normalize,
	plan,
	replaceImages,
	scan,
	type Settings,
	shouldShrink,
	shrinkNote,
	toolCallPaths,
} from "./prune.ts";

const NAME = "image-prune";
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;

export function saveDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "tmp", NAME);
}

/** Write the image under saveDir, named by content hash so a re-save is a no-op. Owner-only: screenshots can hold anything. */
export function saveImage(img: ImageBlock, dir = saveDir()): string | undefined {
	try {
		const bytes = Buffer.from(img.data, "base64");
		const path = join(dir, `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${extensionFor(img.mimeType)}`);
		if (!existsSync(path)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(path, bytes, { mode: 0o600 });
		}
		return path;
	} catch {
		return undefined;
	}
}

/** Saved images older than this go at session start. */
export const SAVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many saved images are kept (the newest). */
export const SAVED_MAX_FILES = 200;

/**
 * Keep saveDir bounded: drop files older than SAVED_MAX_AGE_MS, then all but
 * the newest SAVED_MAX_FILES, and tighten modes left by older versions (dir
 * 0700, files 0600). A note in an old session may then name a file that's
 * gone; the read tool just reports it missing. Returns how many were removed.
 */
export function capSaved(dir = saveDir(), now = Date.now(), maxAgeMs = SAVED_MAX_AGE_MS, maxFiles = SAVED_MAX_FILES): number {
	let names: string[];
	try {
		names = readdirSync(dir);
		chmodSync(dir, 0o700);
	} catch {
		return 0;
	}
	const files: { path: string; mtime: number }[] = [];
	for (const name of names) {
		const path = join(dir, name);
		try {
			const st = lstatSync(path);
			if (st.isFile()) files.push({ path, mtime: st.mtimeMs });
		} catch {}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	let removed = 0;
	for (const [i, f] of files.entries()) {
		try {
			if (i >= maxFiles || now - f.mtime > maxAgeMs) {
				unlinkSync(f.path);
				removed++;
			} else chmodSync(f.path, 0o600);
		} catch {}
	}
	return removed;
}

/** The read tool's path for a one-image result, if that file is still an image on disk. */
function originalPath(target: ImageEntry, paths: Map<string, string>, cwd: string): string | undefined {
	if (target.role !== "toolResult" || target.images.length !== 1 || !target.message.toolCallId) return undefined;
	const raw = paths.get(target.message.toolCallId);
	if (!raw || !IMAGE_FILE.test(raw)) return undefined;
	const abs = isAbsolute(raw) ? raw : resolve(cwd, raw.replace(/^~(?=\/|$)/, homedir()));
	try {
		return statSync(abs).isFile() ? abs : undefined;
	} catch {
		return undefined;
	}
}

/** One context_edit draft per target entry, every image swapped for its note. */
export function drafts(
	entries: ProjectedSessionEntry[],
	targets: ImageEntry[],
	cwd: string,
	save: (img: ImageBlock) => string | undefined = (img) => saveImage(img),
): ContextEditEntryDraft[] {
	const paths = toolCallPaths(entries);
	return targets.map((target) => {
		const original = originalPath(target, paths, cwd);
		const content = replaceImages(target.message.content as unknown[], (img) => original ?? save(img));
		return { type: "context_edit", targetId: target.entryId, replacement: { content: content as never } };
	});
}

type Block = { type: string; [key: string]: unknown };

/**
 * Re-encode big images in a tool result: at most shrinkMaxPx on the long edge,
 * and under shrinkMinKB of base64. pi's resizer tries PNG first and keeps it
 * when it fits, so a 1500x2000 camera photo arrives as a 3.3 MB PNG when the
 * same photo is ~0.4 MB as JPEG. Returns null when nothing changed.
 */
export async function shrinkContent(
	content: Block[],
	s: Settings,
	resize: typeof resizeImage = resizeImage,
): Promise<{ content: Block[]; before: number; after: number } | null> {
	let changed = false;
	let before = 0;
	let after = 0;
	const out: Block[] = [];
	for (const block of content) {
		const img = block as unknown as ImageBlock;
		if (block.type !== "image" || typeof img.data !== "string" || !shouldShrink(img, s)) {
			out.push(block);
			continue;
		}
		const r = await resize(Buffer.from(img.data, "base64"), img.mimeType, {
			maxWidth: s.shrinkMaxPx,
			maxHeight: s.shrinkMaxPx,
			maxBytes: s.shrinkMinKB * 1024,
		}).catch(() => null);
		if (!r || r.data.length >= img.data.length) {
			out.push(block);
			continue;
		}
		changed = true;
		before += img.data.length;
		after += r.data.length;
		out.push({ type: "text", text: shrinkNote({ bytes: img.data.length, mimeType: img.mimeType }, { ...r, bytes: r.data.length }) });
		out.push({ type: "image", data: r.data, mimeType: r.mimeType });
	}
	return changed ? { content: out, before, after } : null;
}

function settings() {
	return normalize(settingsFor(NAME, { ...DEFAULTS }));
}

function main(pi: ExtensionAPI) {
	// `/image-prune now` can't append entries itself (commands have no way to);
	// it arms a forced batch for the next turn_end.
	let forceNext = false;

	// Saved images would otherwise pile up forever; trim them once per session.
	pi.on("session_start", () => {
		capSaved();
	});

	pi.on("tool_result", async (event) => {
		const s = settings();
		if (!s.shrink) return;
		const r = await shrinkContent(event.content as unknown as Block[], s);
		if (!r) return;
		// Replacing content drops structuredContent unless it's passed along.
		return { content: r.content as never, structuredContent: event.structuredContent };
	});

	pi.on("turn_end", (event, ctx) => {
		const force = forceNext;
		const s = settings();
		if (!force && !s.enabled) return;
		const entries = event.context.contextEntries;
		const p = plan(entries, s, force);
		if (!p.fire) {
			if (force) {
				forceNext = false;
				ctx.ui.notify(`image-prune: nothing to prune (${p.reason})`, "info");
			}
			return;
		}
		forceNext = false;
		const mine = drafts(entries, p.targets, ctx.cwd);
		const images = p.targets.reduce((n, t) => n + t.images.length, 0);
		const bytes = p.targets.reduce((n, t) => n + t.bytes, 0);
		ctx.ui.notify(
			`image-prune: removed ${images} image${images === 1 ? "" : "s"} (${formatBytes(bytes)}) from context; ${formatBytes(p.scan.totalBytes - bytes)} still visible`,
			"info",
		);
		// Boundary handlers chain: the returned list replaces event.entries.
		return { entries: [...event.entries, ...mine] };
	});

	pi.registerCommand(NAME, {
		description: "Images in context and the prune threshold; `/image-prune now` prunes at the next turn end",
		getArgumentCompletions: (prefix: string) => (("now".startsWith(prefix.trim()) ? [{ value: "now", label: "now" }] : null)),
		handler: async (args, ctx) => {
			const arg = args?.trim();
			if (arg === "now") {
				forceNext = true;
				ctx.ui.notify(
					ctx.isIdle()
						? "image-prune: will prune at the end of the next turn (the next request still carries the images)"
						: "image-prune: will prune at the end of this turn",
					"info",
				);
				return;
			}
			if (arg) {
				ctx.ui.notify("Usage: /image-prune [now]", "warning");
				return;
			}
			ctx.ui.notify(status(ctx), "info");
		},
	});
}

export function status(ctx: Pick<ExtensionContext, "sessionManager">, s = settings()): string {
	const sc = scan(ctx.sessionManager.buildSessionProjection().entries, s.keepTurns);
	return [
		`image-prune: ${sc.count} image${sc.count === 1 ? "" : "s"} in context, ${formatBytes(sc.totalBytes)} sent with every request`,
		`  older than the last ${s.keepTurns} user turns: ${sc.prunableCount} (${formatBytes(sc.prunableBytes)})`,
		`  threshold ${s.thresholdMB} MB${s.enabled ? "" : " (automatic pruning disabled in settings)"}; /image-prune now forces a batch`,
	].join("\n");
}

export default optIn(NAME, "Drop old images from context once they pass a size threshold", main);
