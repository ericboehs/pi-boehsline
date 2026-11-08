/**
 * The look and color auto-session-name picks for a new session, on its way to botsun-owner
 * (extensions/opt-in/botsun-owner), which is the one that can set a session's icon on Botsun.
 *
 * Two halves, both filled by botsun-owner and both empty unless it is loaded and talking to
 * Botsun: what Botsun offers (the icon catalog it sent down the connection, with what each look
 * draws when the host sends that too), and who takes a suggestion. auto-session-name asks for the
 * catalog and hands back one suggestion; with no catalog it names the session and says nothing
 * about an icon, so naming works with no Botsun at all.
 *
 * One registry per process, like lib/footer-snapshot.ts: the extensions share this module.
 */

export interface LookChoice {
	/** The look's saved name: a shape ("heart") or a set and a name ("hyrule.fairy"). */
	id: string;
	/** What it draws, in a few words, when the host sent that ("a tiny winged fairy"). */
	about?: string;
}

/** What a session could be dressed in: Botsun's looks and the colors they come in. */
export interface NamingCatalog {
	looks: LookChoice[];
	colors: string[];
}

/** A look (and, when the model gave one, a color) for a session: Botsun's to apply, if nothing is saved. */
export interface IconSuggestion {
	look: string;
	color?: string;
}

const KEY = "__boehslineIconSuggestion";

interface Store {
	/** botsun-owner's: the catalog as of now, or null when it has none to offer. */
	catalog?: () => NamingCatalog | null;
	/** botsun-owner's: take one suggestion (it sends it as an icon line). */
	sink?: (suggestion: IconSuggestion) => void;
}

function store(): Store {
	const g = globalThis as unknown as { [KEY]?: Store };
	g[KEY] ??= {};
	return g[KEY];
}

/** botsun-owner says where the catalog comes from; null (or on shutdown) unregisters. */
export function provideIconCatalog(read: (() => NamingCatalog | null) | null): void {
	if (read) store().catalog = read;
	else delete store().catalog;
}

/** The catalog now, or null when Botsun isn't connected or hasn't sent one. */
export function namingCatalog(): NamingCatalog | null {
	try {
		return store().catalog?.() ?? null;
	} catch {
		return null;
	}
}

/** botsun-owner takes suggestions; the returned function unregisters it. */
export function onIconSuggestion(take: (suggestion: IconSuggestion) => void): () => void {
	store().sink = take;
	return () => {
		if (store().sink === take) delete store().sink;
	};
}

/** Hand a suggestion over. False when nothing is listening (no botsun-owner): nothing happens. */
export function suggestIcon(suggestion: IconSuggestion): boolean {
	const sink = store().sink;
	if (!sink) return false;
	try {
		sink(suggestion);
		return true;
	} catch {
		return false;
	}
}

/**
 * A suggestion checked against the catalog, or null: a look it doesn't offer, or a color it
 * doesn't have, is dropped rather than sent (Botsun would refuse the whole line). With no color,
 * the session keeps whatever color it draws now.
 */
export function validSuggestion(raw: { look?: unknown; color?: unknown }, catalog: NamingCatalog | null): IconSuggestion | null {
	if (!catalog || typeof raw.look !== "string") return null;
	const look = raw.look.trim().toLowerCase();
	if (!catalog.looks.some((l) => l.id === look)) return null;
	if (raw.color === undefined || raw.color === null || raw.color === "") return { look };
	if (typeof raw.color !== "string") return null;
	const color = raw.color.trim().toLowerCase();
	return catalog.colors.includes(color) ? { look, color } : { look };
}
