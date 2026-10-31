/**
 * A pi stub for smoke tests: records every registration and keeps the
 * handlers so a test can call them. `names()` gives "kind:name" strings.
 */
export function stubPi() {
	const handlers = new Map(); // event -> [fn]
	const commands = new Map();
	const tools = [];
	const providers = new Map();
	const renderers = new Map();
	const sent = [];
	const listeners = {};
	const pi = {
		on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		registerCommand: (name, options) => commands.set(name, options),
		registerTool: (tool) => tools.push(tool),
		registerProvider: (name, config) => providers.set(name, config),
		registerMessageRenderer: (type, fn) => renderers.set(type, fn),
		registerShortcut: () => {},
		registerFlag: () => {},
		sendUserMessage: async (content, options) => sent.push({ content, options }),
		sendMessage: (message) => sent.push({ message }),
		exec: async () => ({ stdout: "", stderr: "", code: 1 }),
		events: {
			on: (name, fn) => {
				(listeners[name] ??= []).push(fn);
				return () => (listeners[name] = listeners[name].filter((f) => f !== fn));
			},
			emit: (name, data) => (listeners[name] ?? []).forEach((fn) => fn(data)),
		},
	};
	const names = () => [
		...[...handlers.keys()].map((e) => `on:${e}`),
		...[...commands.keys()].map((c) => `command:${c}`),
		...tools.map((t) => `tool:${t.name}`),
		...[...providers.keys()].map((p) => `provider:${p}`),
		...[...renderers.keys()].map((r) => `renderer:${r}`),
	].sort();
	/** Run every handler for an event; returns their results. */
	const fire = async (event, payload, ctx) => Promise.all((handlers.get(event) ?? []).map((fn) => fn(payload, ctx)));
	return { pi, handlers, commands, tools, providers, renderers, sent, names, fire };
}

/** A command/event ctx that records notifications. */
export function stubCtx(over = {}) {
	const notes = [];
	return {
		notes,
		ctx: {
			cwd: process.cwd(),
			hasUI: true,
			signal: undefined,
			ui: { notify: (text, level) => notes.push([level, text]), setStatus: () => {}, setWidget: () => {} },
			...over,
		},
	};
}
