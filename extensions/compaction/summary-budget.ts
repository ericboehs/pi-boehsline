/**
 * Iterative compaction used to say "PRESERVE all existing information".
 * One session grew 7,791 → 52,556 characters over six compacts, and the next
 * update has to re-emit all of it. Cap the growth, and the size.
 *
 * pi 1.4.0 dropped the fixed summary output cap (about 13k tokens) and gives
 * summaries the model's output limit, so size no longer makes a summary fail.
 * The cap still pays: every update re-emits the whole checkpoint, so a larger
 * one costs output tokens and latency on each compact, and it then sits in
 * context for the rest of the session. 32,000 characters is about 8,000
 * tokens, which also keeps models with small output limits safe. Under the ceiling, one
 * update may add 4,000 characters. At the ceiling, new facts replace older
 * Done items. The split-turn block and the file lists are kept; the oldest
 * Done bullets are what get dropped.
 *
 * Kept in sync with the pi fork `packages/coding-agent/src/core/compaction/summary-budget.ts`.
 */

export const SUMMARY_CHAR_CEILING = 32_000;
export const SUMMARY_GROWTH_CHARS = 4_000;

const SHORTENED_NOTE = "\n\n[Summary shortened to the compaction budget. Older completed detail was dropped.]";

const TURN_MARKER = "**Turn Context (split turn):**";

const TRIM_BULLETS = ["### Done", "## Critical Context", "## Key Decisions"] as const;

/** How long the next summary may be, given the previous one. */
export function summaryBudget(previousChars: number): number {
	if (!Number.isFinite(previousChars) || previousChars <= 0) return SUMMARY_CHAR_CEILING;
	if (previousChars >= SUMMARY_CHAR_CEILING) return SUMMARY_CHAR_CEILING;
	return Math.min(SUMMARY_CHAR_CEILING, previousChars + SUMMARY_GROWTH_CHARS);
}

/** Rules for an update. Replaces "PRESERVE all existing information". */
export function updateSummaryInstruction(budget: number): string {
	return `Update the existing structured summary with new information. RULES:
- Keep the whole summary at or under ${budget} characters. Do not grow past that.
- If the previous summary is already at the limit, compress older Done items and drop stale detail to make room. Do not copy it verbatim.
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move finished items from "In Progress" to "Done", and fold older Done items into fewer lines when the list is long
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, error messages, and open decisions
- Do not add sections beyond the format below`;
}

/** Previous summary to show the model. Already-over checkpoints are shortened first, so the model is not asked to copy a novel. */
export function promptSummary(previous: string | undefined, budget: number): string | undefined {
	if (!previous) return undefined;
	return previous.length > budget ? fitSummary(previous, budget) : previous;
}

interface Section {
	header: string;
	lines: string[];
}

function splitFileLists(summary: string): { body: string; lists: string } {
	const blocks: string[] = [];
	const body = summary
		.replace(/[ \t]*<(read-files|modified-files)>[\s\S]*?<\/\1>[ \t]*/g, (match) => {
			blocks.push(match.trim());
			return "";
		})
		.trimEnd();
	return { body, lists: blocks.length ? `\n\n${blocks.join("\n\n")}` : "" };
}

function splitTurn(body: string): { main: string; turn: string } {
	const markerAt = body.indexOf(TURN_MARKER);
	if (markerAt < 0) return { main: body, turn: "" };
	const splitAt = body.lastIndexOf("\n\n---", markerAt);
	const at = splitAt >= 0 ? splitAt : markerAt;
	return { main: body.slice(0, at).trimEnd(), turn: body.slice(at) };
}

function parseSections(body: string): Section[] {
	const sections: Section[] = [];
	let current: Section = { header: "", lines: [] };
	for (const line of body.split("\n")) {
		if (/^#{2,3} /.test(line)) {
			if (current.header || current.lines.some((item) => item.trim())) sections.push(current);
			current = { header: line, lines: [] };
		} else {
			current.lines.push(line);
		}
	}
	if (current.header || current.lines.some((item) => item.trim())) sections.push(current);
	return sections;
}

function render(sections: Section[]): string {
	return sections
		.map((section) => (section.header ? [section.header, ...section.lines] : section.lines).join("\n"))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

function isBullet(line: string): boolean {
	return /^- /.test(line);
}

function bulletCount(section: Section): number {
	return section.lines.filter(isBullet).length;
}

function dropOldestBullet(section: Section): boolean {
	const index = section.lines.findIndex(isBullet);
	if (index < 0) return false;
	section.lines.splice(index, 1);
	if (section.lines[index] === "") section.lines.splice(index, 1);
	return true;
}

function trimBullets(sections: Section[], keep: number, budget: number): void {
	let guard = 0;
	while (render(sections).length > budget && guard++ < 2_000) {
		let dropped = false;
		for (const name of TRIM_BULLETS) {
			const section = sections.find((item) => item.header === name);
			if (!section || bulletCount(section) <= keep) continue;
			if (dropOldestBullet(section)) {
				dropped = true;
				break;
			}
		}
		if (!dropped) return;
	}
}

function fitBody(body: string, budget: number): string {
	if (body.length <= budget) return body;
	const sections = parseSections(body);
	trimBullets(sections, 8, budget);
	if (render(sections).length > budget) trimBullets(sections, 3, budget);
	const text = render(sections);
	if (text.length <= budget) return text;
	return text
		.slice(0, Math.max(0, budget))
		.replace(/\n[^\n]*$/, "")
		.trimEnd();
}

function hardFit(text: string, budget: number): string {
	if (text.length <= budget) return text;
	if (budget < 1) return "";
	const cut = text
		.slice(0, budget)
		.replace(/\n[^\n]*$/, "")
		.trimEnd();
	return cut.length > 0 ? cut : text.slice(0, budget);
}

/**
 * Shorten a finished summary to `budget`. Keeps the split-turn block and the
 * file lists. Drops the oldest Done, Critical Context, and Key Decisions
 * bullets until it fits.
 */
export function fitSummary(summary: string, budget: number): string {
	if (budget < 1) return "";
	if (summary.length <= budget) return summary;

	const { body, lists } = splitFileLists(summary);
	const { main, turn } = splitTurn(body);
	const reserved = turn.length + lists.length + SHORTENED_NOTE.length;
	const mainBudget = budget - reserved;

	if (mainBudget < 80) {
		const fitted = hardFit(body, Math.max(0, budget - lists.length));
		const out = `${fitted}${lists}`;
		return out.length <= budget ? out : hardFit(out, budget);
	}

	const fitted = fitBody(main, mainBudget);
	const note = fitted.length < main.length ? SHORTENED_NOTE : "";
	const out = `${fitted}${note}${turn}${lists}`;
	if (out.length <= budget) return out;

	const withoutNote = `${hardFit(fitted, mainBudget)}${turn}${lists}`;
	return withoutNote.length <= budget ? withoutNote : hardFit(withoutNote, budget);
}
