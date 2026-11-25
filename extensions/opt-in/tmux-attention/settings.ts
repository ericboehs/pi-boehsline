/**
 * tmux-attention settings: Boehsline config only (no env override).
 *
 *   // ~/.pi/agent/boehsline.json, or a config source such as a work package
 *   "tmux-attention": {
 *     "programStatus": true
 *   }
 *
 * `programStatus` (off by default) forwards pi's program status (OSC 7501)
 * through tmux's DCS passthrough, so the outer terminal shows pi's state while
 * pi sits inside a pane. It needs `set -g allow-passthrough on` (or `all`) in
 * ~/.tmux.conf, and stays out of the way when pi reports for itself
 * (PI_PROGRAM_STATUS set) or the setting is off.
 *
 * Pure node (no pi imports), so tests run under plain `node --test`.
 */

import { type ConfigObject, type BoehslineConfig, settingsFor } from "../../../lib/config.ts";

export const NAME = "tmux-attention";

export interface TmuxAttentionSettings {
	/** Write pi's OSC 7501 state to stdout wrapped in tmux's DCS passthrough. */
	programStatus: boolean;
}

export const DEFAULTS: TmuxAttentionSettings = {
	programStatus: false,
};

/** Normalize a raw settings block (from config) into typed settings. */
export function normalize(raw: Record<string, unknown>): TmuxAttentionSettings {
	return {
		// Anything but a literal true leaves it off: this writes to the terminal.
		programStatus: raw.programStatus === true,
	};
}

export function attentionSettings(config?: BoehslineConfig): TmuxAttentionSettings {
	return normalize(settingsFor(NAME, DEFAULTS as unknown as ConfigObject, config));
}
