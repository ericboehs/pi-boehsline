/**
 * @-mention helpers for live agent-link sessions.
 *
 * Node built-ins only — no pi/agent deps, so it stays testable like
 * claude-protocol.ts.
 */

export type MentionPeer = {
  name: string;
  pid?: number;
  cwd: string;
  status: string;
};

export type AgentMention = {
  raw: string;
  peer: MentionPeer;
};

export type AutocompleteItem = {
  value: string;
  label: string;
  description: string;
};

const PATHISH = /[\\/]|^~|^\./;

/** File-like @ tokens: paths, home, relative, or quoted. */
export function isPathishQuery(query: string): boolean {
  if (!query) return false;
  if (query.startsWith('"')) return true;
  return PATHISH.test(query);
}

/**
 * If the cursor is in an @token, return the token (`@foo`) and the query
 * (`foo`). Quoted `@"...` paths are left to file completion.
 */
export function extractAtQuery(textBeforeCursor: string): { prefix: string; query: string } | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@[^\s]*)$/);
  if (!match) return null;
  const prefix = match[1] ?? "";
  if (prefix.startsWith('@"')) return null;
  return { prefix, query: prefix.slice(1) };
}

/**
 * A session name as one typeable token: lowercase, spaces to hyphens.
 * "Chicken Door Alert Tamer" is reachable as @chicken-door-alert-tamer (or
 * any unique prefix, like @chicken), since an @mention ends at a space.
 */
export function nameHandle(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** Resolve a token the way agent-link `to` does: pid, exact name, then unique prefix. */
export function matchPeer(token: string, peers: MentionPeer[]): MentionPeer | undefined {
  if (!token) return undefined;
  if (/^\d+$/.test(token)) {
    const byPid = peers.filter((p) => String(p.pid) === token);
    return byPid.length === 1 ? byPid[0] : undefined;
  }
  const exact = peers.filter((p) => p.name === token);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const pfx = peers.filter((p) => p.name.startsWith(token));
  if (pfx.length === 1) return pfx[0];
  const lower = token.toLowerCase();
  const ci = peers.filter((p) => p.name.toLowerCase() === lower);
  if (ci.length === 1) return ci[0];
  const ciPfx = peers.filter((p) => p.name.toLowerCase().startsWith(lower));
  if (ciPfx.length === 1) return ciPfx[0];
  if (ciPfx.length > 1) return undefined;
  // Spaced names, typed with hyphens: @chicken-door for "Chicken Door Tamer".
  const handle = nameHandle(token);
  const byHandle = peers.filter((p) => nameHandle(p.name) === handle);
  if (byHandle.length === 1) return byHandle[0];
  if (byHandle.length > 1) return undefined;
  const handlePfx = peers.filter((p) => nameHandle(p.name).startsWith(handle));
  return handlePfx.length === 1 ? handlePfx[0] : undefined;
}

export function filterPeers(peers: MentionPeer[], query: string): MentionPeer[] {
  if (!query) return [...peers];
  const q = nameHandle(query);
  const prefix: MentionPeer[] = [];
  const rest: MentionPeer[] = [];
  for (const peer of peers) {
    const name = nameHandle(peer.name);
    if (name.startsWith(q)) prefix.push(peer);
    else if (name.includes(q) || peer.cwd.toLowerCase().includes(query.toLowerCase())) rest.push(peer);
  }
  return [...prefix, ...rest];
}

export function findAgentMentions(text: string, peers: MentionPeer[]): AgentMention[] {
  if (!text || !peers.length) return [];
  const found: AgentMention[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s])@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let token = (m[1] ?? "").replace(/[.,:;!?)]+$/, "");
    if (!token || isPathishQuery(token)) continue;
    const peer = matchPeer(token, peers);
    if (!peer) continue;
    const key = String(peer.pid ?? peer.name);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ raw: `@${token}`, peer });
  }
  return found;
}

export function mentionHint(mentions: AgentMention[]): string {
  if (!mentions.length) return "";
  const lines = mentions.map((m) => {
    const who = m.peer.name;
    return `- ${m.raw} addresses live agent-link session "${who}" (${m.peer.status}, ${m.peer.cwd}). Use the agent-link tool to talk to "${who}" — action "ask" if you need a reply, "send" if fire-and-forget. Do not treat ${m.raw} as a file path.`;
  });
  return `The user addressed other agent sessions with @mentions:\n${lines.join("\n")}`;
}

export function formatAgentItem(peer: MentionPeer, home?: string): AutocompleteItem {
  const cwd = home && peer.cwd.startsWith(home) ? `~${peer.cwd.slice(home.length)}` : peer.cwd;
  return {
    // A space would end the @mention, so spaced names complete as their handle.
    value: `@${/\s/.test(peer.name) ? nameHandle(peer.name) : peer.name}`,
    label: peer.name,
    description: `agent · ${peer.status} · ${cwd}`,
  };
}

export function isInboundPeerPrompt(prompt: string): boolean {
  return prompt.startsWith("[cross-agent") || prompt.startsWith("[reply from");
}
