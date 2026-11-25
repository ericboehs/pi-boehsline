/**
 * The `blocked` option for `ctx.ui.custom`: what pi reports over OSC 7501 while
 * an extension dialog waits on the user.
 *
 * pi's built-in `select`/`confirm`/`input` report `blocked` by themselves, but a
 * custom component is invisible to pi, so a picker that holds up a tool call
 * (the ask tool's option lists, say) leaves the terminal showing `working`
 * while the agent is in fact waiting. Passing the option fixes that.
 *
 * Only pass it for a dialog that waits on the user *while the agent needs an
 * answer*. A menu, settings list or picker opened by the user's own slash
 * command or shortcut is their own detour, not the agent being blocked.
 *
 * The message is a short dialog title ("Answer the agent's question"), never
 * prompt text, tool arguments, secrets or anything the model wrote: it goes to
 * the terminal (and to whatever watches it), not just to this screen.
 *
 * Type safety across pi versions: the option arrived with pi 1.5. Typing it as
 * the caller's own options type means a pi whose `custom()` options predate it
 * still typechecks; that pi ignores the unknown key at runtime.
 *
 * Pure node: no pi imports, so tests run under plain `node --test`.
 */

import type { BlockedKind } from "./program-status.ts";

export type { BlockedKind } from "./program-status.ts";

/**
 * `ctx.ui.custom` options with `blocked` added:
 *
 *   ctx.ui.custom(factory, withBlocked("question", "Answer the agent's question"));
 *   ctx.ui.custom(factory, withBlocked("auth", "Unlock 1Password", { overlay: true }));
 *
 * Returns `options`' own type, so a pi whose option type predates `blocked`
 * still accepts it (and ignores the key at runtime).
 */
export function withBlocked<T extends object = {}>(kind: BlockedKind, message: string, options?: T): T {
  return { ...(options ?? ({} as T)), blocked: { kind, message } } as T;
}
