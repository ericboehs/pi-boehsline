import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import approvalGuardian, {
	BYPASS_AGAIN_COMMAND,
	BYPASS_STATE_ENTRY_TYPE,
	bypassedWhenLeft,
	actionFromToolCall,
	APPROVAL_GUARDIAN_BYPASS_CONTROL_EVENT,
	APPROVAL_GUARDIAN_BYPASS_STATE_EVENT,
	enforceActionRequirements,
	guardianHealth,
	lockAllowedToolInput,
	lockReviewedToolInput,
	reviewerToolsForAction,
	runReviewWithFallbackChain,
	shouldFallbackReview,
	shouldInvalidateDirectoryScanCache,
	type ReviewerChannel,
	toolCallBatchInfo,
} from "../extensions/index.ts";
import { DEFAULT_REVIEW_RULES, loadGuardianConfig } from "../src/config.ts";
import { DirectoryScanCache } from "../src/directory-scan-cache.ts";
import { DenialCircuitBreaker, ReviewBatchTracker } from "../src/gate.ts";
import { buildGuardianTranscript } from "../src/review.ts";
import { ReviewerSessionController } from "../src/reviewer-session.ts";

function event(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { toolName, input, toolCallId: "test" } as unknown as ToolCallEvent;
}

function channel(
	role: ReviewerChannel["role"],
	modelSpec: string,
): ReviewerChannel {
	return { role, modelSpec };
}

test("routes private read and grep paths to the reviewer", () => {
	const read = actionFromToolCall(
		event("read", { path: ".env" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(read?.tool, "read");
	assert.equal(read?.payload.private_data_read, true);

	const grep = actionFromToolCall(
		event("grep", { path: "/home/test/.aws", pattern: "token" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(grep?.tool, "grep");
	assert.equal(grep?.payload.pattern, "token");

	const project = mkdtempSync(join(tmpdir(), "guardian-grep-"));
	writeFileSync(join(project, ".env"), "TOKEN=test");
	const broad = actionFromToolCall(
		event("grep", { pattern: "token" }),
		project,
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(broad?.tool, "grep");
	assert.equal(broad?.payload.private_data_read, true);

	const globbed = actionFromToolCall(
		event("grep", { path: ".", pattern: "token", glob: "**/.env*" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(globbed?.payload.private_data_read, true);
	for (const glob of [
		"**/.env.local",
		"**/.config/{gh,gcloud}/**",
		"**/{wireguard,openvpn}/**",
	]) {
		const selector = actionFromToolCall(
			event("grep", { path: ".", pattern: "token", glob }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(selector?.payload.private_data_read, true, glob);
	}
	for (const glob of ["*", "**/*", "**/{.env,.npmrc}"]) {
		const broadGlob = actionFromToolCall(
			event("grep", { path: ".", pattern: "token", glob }),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(broadGlob?.payload.private_data_read, true, glob);
	}

	const cleanProject = mkdtempSync(join(tmpdir(), "guardian-clean-grep-"));
	writeFileSync(join(cleanProject, "app.ts"), "export const token = true;");
	assert.equal(
		actionFromToolCall(
			event("grep", { path: ".", pattern: "token" }),
			cleanProject,
			{ ...DEFAULT_REVIEW_RULES },
		),
		undefined,
	);
});

test("defaults unconfigured path-based tools to private-only", () => {
	const privateAction = actionFromToolCall(
		event("custom_reader", { path: "C:\\Users\\test\\.ssh\\config" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(privateAction?.tool, "custom_reader");
	assert.equal(
		actionFromToolCall(
			event("custom_reader", { path: "docs/guide.md" }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		),
		undefined,
	);
});

test("marks obvious shell private-data access for high authorization", () => {
	for (const command of [
		"cat .env",
		"cat ~/.ssh/config",
		"cat /home/test/.aws/credentials",
		"cat $HOME/.kube/config",
		"type C:\\Users\\test\\.ssh\\config",
		"cat .npmrc",
		"cat credentials.json",
		"grep -R token ~/.ssh",
		"find ~/.aws -type f",
		"tar czf /tmp/kube.tgz $HOME/.kube",
		"type C:\\Users\\test\\.ssh",
		"cat ~/.[s]sh/config",
		"cat ~/.ssh/id_*",
		"cat se[ck]rets/token",
		"cat .env*",
		"cat .??v",
		"cat .{env,npmrc}",
		"cat certs/*.pem",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, command);
	}
});

test("shares structured private-path rules with shell literals and globs", () => {
	for (const path of [
		"/home/test/.config/gcloud/application_default_credentials.json",
		"/home/test/.config/gh/hosts.yml",
		"/etc/wireguard/wg0.conf",
		"/etc/openvpn/client.conf",
		"/Users/test/Library/Application Support/Google/Chrome/Default/Preferences",
		"C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Local State",
		"C:\\Windows\\System32\\config\\SAM",
	]) {
		const action = actionFromToolCall(
			event("bash", { command: `cat ${JSON.stringify(path)}` }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, path);
	}

	for (const command of [
		"cat /Users/test/Library/Application\\ Support/Google/Chrome/Default/Preferences",
		"cat ~/.config/{gh,gcloud}/*",
		"cat /etc/{wireguard,openvpn}/*",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, command);
	}

	for (const command of [
		"cat docs/config.yml",
		"cat src/password-reset.ts",
		'cat "/Users/test/Documents/Login Data notes.txt"',
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, false, command);
	}
});

test("does not treat ordinary shell source globs as private data", () => {
	for (const command of [
		"cat src/*.ts",
		"find src -name '*.test.ts'",
		"find src -name '*'",
		"printf '%s\\n' *",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, false, command);
	}
});

test("does not treat regex, sed, and extension-only globs as private data", () => {
	for (const command of [
		"rg -o 'import static .*\\.([a-zA-Z]+);' -r '$1' Foo.java",
		"grep -rn 'fetchUser<.*> load\\|parseConfig(' src/api.ts",
		"grep -n '^\\s*[0-9]+:\\s*;;' src/core.clj",
		"sed -E 's/^\\[[^]]*\\] ([^:]*):.*/\\1/' notes.txt",
		"sed 's|.*/||' files.txt",
		"sed 's/.*<td>//' page.html",
		"python3 -c \"import re; print(re.findall(r'<<<<<<< HEAD\\n(.*?)=======', s))\"",
		"rg -n -g '*.{ts,tsx,json}' handleSubmit .",
		"rg -n SessionStore --glob '!**/.*' app",
		"ls ~/.config/example-app/*.json",
		"cat ~/.local/state/example-app/*.json",
		"grep -n 'class .*\\(private' src/model.ts",
		"cat > notes.md <<'EOF'\n**2026** plan * [x] Star box\nEOF",
		"grep -n -iE 'timer|schedule' dotfiles/.pi-agent/extensions/*.ts",
		"grep -n '^\\[tools\\.pi\\]' mise.toml",
		"sed -n '/def self.pi_enabled?/,/^  end/p' lib/app.rb",
		"ls -d ~/.pi/agent/npm/node_modules/*",
		"rg -n launcher ~/.pi/agent/skills/example/*.md",
		"grep -n '^// ---------- state\\|^// ---------- credentials' src/index.ts",
		"python3 - <<'EOF'\nprint(\"\"\"Rotate the secret.\nSee the credentials doc.\"\"\")\nEOF",
		// An interpreter's program on stdin: its own comments (whole lines, or
		// after code with no quote in the comment) aren't reads, blank lines too.
		"python3 - <<'EOF'\ns = open('src/a.ts').read()\n\n# no session model with credentials\ns = s.replace('x', 'y')  # the secrets tab, .env too\n\nopen('src/a.ts', 'w').write(s)\nEOF\nnpm test",
		"node <<-'EOF'\n\tconst a = 1; // credentials come later\n\t/* .env\n\t * see credentials\n\t */\n\tconsole.log(a);\n\tEOF",
		"python3 - <<\\EOF\n# credentials\nprint(1)\nEOF",
		"cd src && python3 -u - <<'EOF' | tee out.txt\n# .netrc notes\nprint(1)\nEOF",
		"python3 <<'EOF' - && npm test\n# .netrc notes\nprint(1)\nEOF",
		"diff -rq --exclude=.git --exclude=.bundle a b",
		"cat .env.example",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, false, command);
	}

	for (const command of [
		"cat .*",
		"cat ~/.ssh/.*",
		"bash -c 'cat ~/.ssh/id_*'",
		"grep -r token --include=*.pem .",
		"cat *.env",
		"cat *.{json,key}",
		"rg -n 'x' ~/.aws/credentials",
		"node -e 'const a=require(\"./auth.json\"); console.log(a)'",
		// Comments are prose; code beside, after, or disguised as them is not.
		"python3 - <<'EOF'\nx = open('credentials').read() # note\nprint(x)\nEOF",
		"python3 - <<'EOF'\nprint('x # y', open('credentials').read())\nprint(1)\nEOF",
		"python3 - <<'EOF'\n*creds, = open('credentials')\nprint(creds)\nEOF",
		"python3 - <<'EOF'\n# read it\n\nprint(open('credentials').read())\nEOF",
		// A // line in Python is string data (here, TypeScript being written), not a comment.
		"python3 - <<'EOF'\ns = s.replace('x', '''\n  // no session model with credentials\n''')\nEOF",
		"node - <<'EOF'\n# .env is not a JS comment\nEOF",
		"bash <<'EOF'\n# just a comment\ncat credentials\nEOF",
		"python3 - <<'EOF'\n# fine\nEOF\ncat credentials",
		"python3 - <<EOF\n# unquoted heredocs expand\ncat credentials\nEOF",
		// Stdin as file names, or data for a program from elsewhere: no comments there.
		"xargs cat <<'EOF'\n# .env\nx\nEOF",
		"xargs cat <<'EOF'\n// .env\nx\nEOF",
		"xargs cat <<'EOF'\n* .env\nx\nEOF",
		"xargs cat <<'EOF'\nREADME.md # .env\nx\nEOF",
		"xargs cat <<-'EOF'\n\t# .env\n\tEOF",
		"tar czf /tmp/o.tgz -T - <<'EOF'\n# .netrc\nx\nEOF",
		"xargs cat <<'EOF'\ncredentials\nx\nEOF",
		"printf '%s\\n' 'a\n# .env' | sed 's/^# //' | xargs cat",
		"python3 -c 'import sys; print(open(sys.stdin.read().strip()).read())' <<'EOF'\n# .env\nEOF",
		"python3 script.py <<'EOF'\n# .env\nEOF",
		"python3 - x <<'EOF'\n# .env\nEOF",
		// An escaped or quoted operator is a literal argument: xargs receives it.
		"xargs cat \\| python3 - <<'EOF'\n# .env\nEOF",
		"xargs cat \\; python3 - <<'EOF'\n# .env\nEOF",
		"xargs cat \\& python3 - <<'EOF'\n# .env\nEOF",
		"xargs cat \\( python3 - <<'EOF'\n# .env\nEOF",
		"xargs cat \\| node - <<'EOF'\n// .env\nEOF",
		"xargs cat \\| python3 - <<'EOF'\n# /Users/me/.ssh/id_rsa\nEOF",
		"xargs cat '|' python3 - <<'EOF'\n# .env\nEOF",
		// Arguments after the heredoc: a script file reads stdin as data.
		"python3 <<'EOF' reader.py\n# .env\nEOF",
		"python3 - <<'EOF' \\| x\n# .env\nEOF",
		// Comment-shaped lines inside a string are data, which may become a path.
		// (A bare word there was already missed by the shell-word reading, which
		// sees the ''' block as a quoted prose string; paths are caught by both.)
		"python3 - <<'EOF'\np = '''\n# ~/.ssh/id_rsa\n'''.split()[1]\nprint(open(p).read())\nEOF",
		"python3 - <<'EOF'\ns = 'x # .env'\np = s.split()[2]\nprint(open(p).read())\nEOF",
		"node - <<'EOF'\nconst p = `\n// .env\n`.split(' ')[1];\nrequire('fs').readFileSync(p.trim());\nEOF",
		"sed 's/.*//' ~/.netrc",
		"ls ~/.pi/agent/skills/../*",
		"cat ~/.pi/agent/usage-budget*",
		"cat ~/.pi/agent/sessions/*/x.jsonl",
		"bash -c 'cat credentials'",
		"grep -r --exclude=.git token .env",
		"cat .env.local",
		"cat .env.production",
		"cat ~/.pi/agent/skills/.{.,}/*",
		"cat ~/.pi/agent/npm/node_modules/.{.,}/.{.,}/*",
		"cat ~/.pi/agent/skills/.[.]/settings.json",
		"cat ~/.pi/agent/skills/.?/settings.json",
		"cat ~/.pi/agent/skills/[.][.]/settings.json",
		"bash -c 'cd /tmp\nx=1; cat credentials'",
		"cat ~/.pi/agent/skills/.{.,}/settings.json",
		"cat ~/.pi/agent/{..,.}/settings.json",
		"cat ~/.pi/agent/skills/{..,.}/sessions/x.jsonl",
		"cat ~/.pi/agent/skills/\\.\\./settings.json",
		"cat ~/.pi/agent/skills/*/../../auth.json",
		"bash -c \"grep \\s credentials\"",
		"bash -c \"cat c* \\s\"",
		"bash -c \'cat credentials\ntrue\'",
		"bash <<< \'cat credentials\ntrue\'",
		"printf \'%s\' \'grep \\s credentials\' | sh",
		"ba\\sh -c \"grep \\s credentials\"",
		"s\\h -c \"grep \\s credentials\"",
		"ev\\al \"grep \\s credentials\"",
		"ba\\sh -c 'cat credentials\ntrue'",
		"printf '%s' 'grep \\s credentials' | s\\h",
		"/bin/ba\\sh -c \"grep \\s credentials\"",
		"env ba\\sh -c \"grep \\s credentials\"",
		"S=sh; $S -c \"grep \\s credentials\"",
		"S=/bin/sh; $S -c \"grep \\s credentials\"",
		"S=sh; ${S} -c \"grep \\s credentials\"",
		"python3 - <<'EOF'\nimport subprocess\nsubprocess.run(\"\"\"cat credentials\ntrue\"\"\", shell=True)\nEOF",
		"cat id_rsa\\*",
		"cat cred\"entials\"\\.json",
		"cat ~/.ss\\h/id_rsa",
		"cat ~/{x/../.ssh,y}/id_rsa",
		// Extension-only globs are not relaxed under directories holding private data.
		"grep -rn todo ~/.config/ --include=*.json --include=*.yaml",
		"find ~/.pi -name '*.json' -exec cat {} +",
		"grep -r token ~/.pi/agent --include=*.json",
		"grep -rn token ~ --include=*.json",
		// Relative words after `cd` are classified against the new directory.
		"cd ~/.pi/agent; cat settings.json",
		"cd ~/.pi && cat agent/auth.json",
		"cat ~/{.pi,}/agent/*",
		"cat ~/.pi/agent/{*,\\[}",
		"cat ~/.pi/agent/{*,x/.pi/skills/}",
		"cat ~/\\.pi/agent/*",
		"eval '--exclude=x; cat ~/.ssh/id_rsa'",
		"sh -c '--exclude=x && cat ~/.ssh/id_rsa'",
		"cat ~/.*/*\\s",
		"bash -c 'cat ~/.*/*\\s'",
		"bash -c 'cat credentials; printf \"\\n\"'",
		"bash -c \"grep '\\s' credentials\"",
		"bash -c 'cat c*'",
		"cat c*",
		"type C:\\Users\\test\\.pi\\agent\\*",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, command);
	}
});

test("does not route installed Pi package docs through private-read review", () => {
	const packageSkill = actionFromToolCall(
		event("read", {
			path: join(
				homedir(),
				".pi/agent/npm/node_modules/@upstash/context7-pi/skills/context7-docs/SKILL.md",
			),
		}),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(packageSkill, undefined);

	const settings = actionFromToolCall(
		event("read", { path: "/home/test/.pi/agent/settings.json" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES },
	);
	assert.equal(settings?.payload.private_data_read, true);
});

test("only marks known confidential Pi paths as private shell access", () => {
	for (const command of [
		"cat ~/.pi/agent/auth.json",
		"cat $HOME/.pi/agent/settings.json",
		"cat ~/.pi/agent/sessions/project/session.jsonl",
		"cat ~/.pi/memory/memory.db",
		"cat ~/.pi/agent/*",
		"cat ~/.pi/agent/{auth.json,settings.json}",
		"cat ~/.pi/agent/auth.*",
		'P=$HOME/.pi; A=auth; cat "$P/agent/$A.json"',
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, command);
	}

	for (const command of [
		"cat ~/.pi/agent/npm/node_modules/@upstash/context7-pi/skills/context7-docs/SKILL.md",
		"cat ~/.pi/agent/skills/custom/SKILL.md",
		"cat ~/.pi/agent/extensions/example/index.ts",
	]) {
		const action = actionFromToolCall(
			event("bash", { command }),
			"/repo/project",
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, false, command);
	}
});

test("reviews recursive find scopes and directly visible private ls entries", () => {
	const project = mkdtempSync(join(tmpdir(), "guardian-list-"));
	writeFileSync(join(project, ".env"), "TOKEN=test");
	for (const [toolName, input] of [
		["find", { path: project, pattern: "*" }],
		["ls", { path: project }],
	] as const) {
		const action = actionFromToolCall(
			event(toolName, input),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		);
		assert.equal(action?.payload.private_data_read, true, toolName);
	}
});

test("matches ls review scope to the direct entries Pi can return", () => {
	const project = mkdtempSync(join(tmpdir(), "guardian-ls-direct-"));
	const publicDirectory = join(project, "public");
	const nestedDirectory = join(publicDirectory, "nested");
	mkdirSync(publicDirectory);
	mkdirSync(nestedDirectory);
	writeFileSync(join(nestedDirectory, ".env"), "TOKEN=test");

	assert.equal(
		actionFromToolCall(
			event("ls", { path: project }),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		),
		undefined,
		"listing the root only exposes public/ and must not inherit nested privacy",
	);
	assert.equal(
		actionFromToolCall(
			event("ls", { path: nestedDirectory }),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		)?.payload.private_data_read,
		true,
	);
});

test("classifies ls direct entries by visible names instead of symlink targets", () => {
	const project = mkdtempSync(join(tmpdir(), "guardian-ls-symlink-"));
	const privateRoot = mkdtempSync(join(tmpdir(), "guardian-ls-private-"));
	const privateTarget = join(privateRoot, ".ssh");
	mkdirSync(privateTarget);
	writeFileSync(join(privateTarget, "id_rsa"), "private");
	const link = join(project, "docs");
	symlinkSync(
		privateTarget,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);

	assert.equal(
		actionFromToolCall(
			event("ls", { path: project }),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		),
		undefined,
		"listing the parent only exposes the ordinary entry name docs/",
	);
	assert.equal(
		actionFromToolCall(
			event("ls", { path: link }),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		)?.payload.private_data_read,
		true,
		"listing through the symlink exposes the private target contents",
	);
});

test("matches ls privacy checks to its sorted result limit", () => {
	const project = mkdtempSync(join(tmpdir(), "guardian-ls-limit-"));
	writeFileSync(join(project, "a.txt"), "public");
	writeFileSync(join(project, "z.env.key"), "TOKEN=test");

	assert.equal(
		actionFromToolCall(
			event("ls", { path: project, limit: 1 }),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		),
		undefined,
		"a private entry beyond Pi's visible result limit is not exposed",
	);
	assert.equal(
		actionFromToolCall(
			event("ls", { path: project, limit: 2 }),
			project,
			{ ...DEFAULT_REVIEW_RULES },
		)?.payload.private_data_read,
		true,
	);
});

test("invalidates cached directory scopes after potentially mutating tools", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	const cache = new DirectoryScanCache({ ttlMs: 1_000, now: () => 0 });
	approvalGuardian(
		{
			on: (name: string, handler: (event: unknown, ctx: never) => unknown) => {
				handlers.set(name, handler);
			},
			registerCommand: () => undefined,
		} as never,
		{ directoryScanCache: cache },
	);
	const root = mkdtempSync(join(tmpdir(), "guardian-action-cache-"));
	const project = join(root, "project");
	mkdirSync(project);
	writeFileSync(join(project, "app.ts"), "export const token = true;");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const input = { path: project, pattern: "token" };
	const branch = [
		{
			type: "message",
			id: "cache-prime-batch",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "cache-prime-call" }],
			},
		},
	];
	const ctx = {
		cwd: project,
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => branch },
		abort: () => undefined,
		ui: { notify: () => undefined },
	} as never;

	try {
		const initial = event("grep", input);
		(initial as { toolCallId: string }).toolCallId = "cache-prime-call";
		assert.equal(await handlers.get("tool_call")?.(initial, ctx), undefined);
		assert.equal(cache.size, 1, "the extension should populate the injected cache");

		writeFileSync(join(project, ".env"), "TOKEN=test");
		assert.equal(
			actionFromToolCall(
				event("grep", input),
				project,
				{ ...DEFAULT_REVIEW_RULES },
				cache,
			),
			undefined,
			"the unexpired scan should be reused before invalidation",
		);

		await handlers.get("tool_execution_end")?.(
			{ toolName: "write", toolCallId: "mutation-call" },
			ctx,
		);
		assert.equal(cache.size, 0, "the mutation event should clear the cache");
		const rescanned = actionFromToolCall(
			event("grep", input),
			project,
			{ ...DEFAULT_REVIEW_RULES },
			cache,
		);
		assert.equal(rescanned?.payload.private_data_read, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}

	for (const toolName of ["read", "grep", "find", "ls"]) {
		assert.equal(shouldInvalidateDirectoryScanCache(toolName), false, toolName);
	}
	for (const toolName of ["bash", "write", "edit", "custom_tool"]) {
		assert.equal(shouldInvalidateDirectoryScanCache(toolName), true, toolName);
	}
});

test("groups sibling tool calls from one assistant message", () => {
	const branch = [
		{
			type: "message",
			id: "assistant-batch",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1" },
					{ type: "toolCall", id: "call-2" },
					{ type: "toolCall", id: "call-3" },
				],
			},
		},
	];
	assert.deepEqual(toolCallBatchInfo("call-1", branch), {
		id: "assistant-batch",
		isLast: false,
	});
	assert.deepEqual(toolCallBatchInfo("call-2", branch), {
		id: "assistant-batch",
		isLast: false,
	});
	assert.deepEqual(toolCallBatchInfo("call-3", branch), {
		id: "assistant-batch",
		isLast: true,
	});
});

test("finalizes a denial batch when the final sibling has no tool-call review", () => {
	const branch = [
		{
			type: "message",
			id: "assistant-with-invalid-final-tool",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "reviewed-denial" },
					{ type: "toolCall", id: "invalid-final-tool" },
				],
			},
		},
	];
	const tracker = new ReviewBatchTracker();
	const breaker = new DenialCircuitBreaker();
	const first = toolCallBatchInfo("reviewed-denial", branch);
	tracker.record(first.id, true);
	const fallback = toolCallBatchInfo("invalid-final-tool", branch);
	assert.equal(fallback.isLast, true);
	assert.equal(breaker.record(tracker.finish(fallback.id) ?? false), false);
});

test("honors always rules when an optional path is omitted or empty", () => {
	const action = actionFromToolCall(
		event("find", { pattern: "**/*.pem" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES, "find.path": "always" },
	);
	assert.equal(action?.tool, "find");
	assert.match(
		String(action?.payload.path).replace(/\\/g, "/"),
		/repo\/project/,
	);
	const emptyPath = actionFromToolCall(
		event("ls", { path: "" }),
		"/repo/project",
		{ ...DEFAULT_REVIEW_RULES, "ls.path": "always" },
	);
	assert.equal(emptyPath?.tool, "ls");
});

test("falls back only for reviewer failure", () => {
	const assessment = {
		risk_level: "low" as const,
		user_authorization: "unknown" as const,
		outcome: "allow" as const,
		rationale: "",
	};
	assert.equal(shouldFallbackReview({ kind: "failure", message: "failed" }), true);
	assert.equal(
		shouldFallbackReview({ kind: "timeout", message: "timed out" }),
		false,
	);
	assert.equal(shouldFallbackReview({ kind: "allowed", assessment }), false);
	assert.equal(
		shouldFallbackReview({
			kind: "denied",
			assessment: { ...assessment, outcome: "deny" },
		}),
		false,
	);
	assert.equal(
		shouldFallbackReview({ kind: "cancelled", message: "cancelled" }),
		false,
	);
});

test("runs configured and current-model fallbacks in order", async () => {
	const channels = [
		channel("primary", "custom/reviewer"),
		channel("configured-fallback", "openai-codex/codex-auto-review"),
		channel("current-model", "anthropic/current-model"),
	];
	const calls: string[] = [];
	const switches: string[] = [];
	const assessment = {
		risk_level: "low" as const,
		user_authorization: "unknown" as const,
		outcome: "allow" as const,
		rationale: "",
	};
	const recovered = await runReviewWithFallbackChain(
		channels,
		async (reviewer) => {
			calls.push(reviewer.modelSpec);
			return reviewer.role === "current-model"
				? { kind: "allowed", assessment }
				: { kind: "failure", message: `${reviewer.role} unavailable` };
		},
		(from, to) => switches.push(`${from.role}→${to.role}`),
	);
	assert.deepEqual(calls, [
		"custom/reviewer",
		"openai-codex/codex-auto-review",
		"anthropic/current-model",
	]);
	assert.deepEqual(switches, [
		"primary→configured-fallback",
		"configured-fallback→current-model",
	]);
	assert.equal(recovered.finalChannel.role, "current-model");
	assert.equal(recovered.result.kind, "allowed");

	calls.length = 0;
	const denied = await runReviewWithFallbackChain(
		channels,
		async (reviewer) => {
			calls.push(reviewer.modelSpec);
			return reviewer.role === "primary"
				? { kind: "failure", message: "primary failed" }
				: {
						kind: "denied",
						assessment: { ...assessment, outcome: "deny" },
					};
		},
		() => undefined,
	);
	assert.deepEqual(calls, [
		"custom/reviewer",
		"openai-codex/codex-auto-review",
	]);
	assert.equal(denied.finalChannel.role, "configured-fallback");
	assert.equal(denied.result.kind, "denied");

	const timedOut = await runReviewWithFallbackChain(
		channels,
		async (reviewer) =>
			reviewer.role === "current-model"
				? { kind: "timeout", message: "current model timed out" }
				: { kind: "failure", message: `${reviewer.role} failed` },
		() => undefined,
	);
	assert.equal(timedOut.attempts.length, 3);
	assert.equal(timedOut.result.kind, "timeout");

	calls.length = 0;
	switches.length = 0;
	const primaryTimeout = await runReviewWithFallbackChain(
		channels,
		async (reviewer) => {
			calls.push(reviewer.modelSpec);
			return { kind: "timeout", message: "review timed out" };
		},
		(from, to) => switches.push(`${from.role}→${to.role}`),
	);
	assert.deepEqual(calls, ["custom/reviewer"]);
	assert.deepEqual(switches, []);
	assert.equal(primaryTimeout.attempts.length, 1);
	assert.equal(primaryTimeout.result.kind, "timeout");
});

test("keeps terminal primary results on one channel and deduplicates models", async () => {
	const assessment = {
		risk_level: "low" as const,
		user_authorization: "unknown" as const,
		outcome: "allow" as const,
		rationale: "",
	};
	const channels = [
		channel("primary", "custom/reviewer"),
		channel("configured-fallback", "openai-codex/codex-auto-review"),
		channel("current-model", "anthropic/current-model"),
	];
	for (const primaryResult of [
		{ kind: "allowed", assessment } as const,
		{
			kind: "denied",
			assessment: { ...assessment, outcome: "deny" as const },
		} as const,
		{ kind: "cancelled", message: "cancelled" } as const,
	]) {
		const calls: string[] = [];
		const result = await runReviewWithFallbackChain(
			channels,
			async (reviewer) => {
				calls.push(reviewer.modelSpec);
				return primaryResult;
			},
			() => assert.fail("fallback must not run"),
		);
		assert.deepEqual(calls, ["custom/reviewer"]);
		assert.equal(result.attempts.length, 1);
		assert.equal(result.result.kind, primaryResult.kind);
	}

	const calls: string[] = [];
	const identical = await runReviewWithFallbackChain(
		[
			channel("primary", "custom/reviewer"),
			channel("configured-fallback", "custom/reviewer"),
			channel("current-model", "custom/reviewer"),
		],
		async (reviewer) => {
			calls.push(reviewer.modelSpec);
			return { kind: "failure", message: "unavailable" };
		},
		() => assert.fail("duplicate fallback must not run"),
	);
	assert.deepEqual(calls, ["custom/reviewer"]);
	assert.equal(identical.attempts.length, 1);
});

test("wires primary failure through fallback and keeps fallback diagnostics UI-only", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: () => undefined,
	} as never);
	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPrimary = process.env.PI_APPROVAL_GUARDIAN_MODEL;
	const previousFallback = process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
	const root = mkdtempSync(join(tmpdir(), "guardian-wiring-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_APPROVAL_GUARDIAN_MODEL = "custom/reviewer";
	process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL =
		"openai-codex/codex-auto-review";
	let mode: "recover" | "fail" | "timeout" = "recover";
	const reviewCalls: string[] = [];
	const controllerInstances = new Map<string, Set<object>>();
	ReviewerSessionController.prototype.review = async function (
		this: ReviewerSessionController,
	) {
		const options = (
			this as unknown as {
				options: { model: { provider: string; id: string } };
			}
		).options;
		const model = `${options.model.provider}/${options.model.id}`;
		reviewCalls.push(model);
		const instances = controllerInstances.get(model) ?? new Set<object>();
		instances.add(this);
		controllerInstances.set(model, instances);
		if (mode === "timeout") {
			return { kind: "timeout", message: "review timed out" };
		}
		if (model === "custom/reviewer") {
			return { kind: "failure", message: "primary channel failed" };
		}
		if (model === "openai-codex/codex-auto-review") {
			return { kind: "failure", message: "configured fallback failed" };
		}
		return mode === "recover"
			? {
					kind: "allowed",
					assessment: {
						risk_level: "low",
						user_authorization: "unknown",
						outcome: "allow",
						rationale: "Safe test action.",
					},
				}
			: { kind: "failure", message: "current model failed" };
	} as typeof originalReview;

	const notices: string[] = [];
	let branch: unknown[] = [];
	const primary = { provider: "custom", id: "reviewer" };
	const fallback = {
		provider: "openai-codex",
		id: "codex-auto-review",
	};
	const current = { provider: "anthropic", id: "current-model" };
	const ctx = {
		cwd: join(root, "project"),
		isProjectTrusted: () => false,
		model: current,
		modelRegistry: {
			find: (provider: string, model: string) =>
				provider === primary.provider && model === primary.id
					? primary
					: provider === fallback.provider && model === fallback.id
						? fallback
						: provider === current.provider && model === current.id
							? current
							: undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: { getBranch: () => branch },
		signal: undefined,
		abort: () => undefined,
		ui: {
			setStatus: () => assert.fail("Guardian must not write footer status"),
			notify: (message: string) => notices.push(message),
		},
	} as never;

	try {
		branch = [
			{ type: "message", message: { role: "user", content: "Run the test." } },
			{
				type: "message",
				id: "batch-1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1" }],
				},
			},
		];
		const recovered = event("bash", { command: "echo safe" });
		(recovered as { toolCallId: string }).toolCallId = "call-1";
		assert.equal(await handlers.get("tool_call")?.(recovered, ctx), undefined);
		assert.deepEqual(reviewCalls, [
			"custom/reviewer",
			"openai-codex/codex-auto-review",
			"anthropic/current-model",
		]);
		assert.equal(Object.isFrozen(recovered.input), true);
		assert.match(notices.join("\n"), /using configured fallback/);
		assert.match(notices.join("\n"), /using current session model/);
		assert.match(notices.join("\n"), /Guardian · allowed/);

		mode = "fail";
		branch = [
			{ type: "message", message: { role: "user", content: "Run again." } },
			{
				type: "message",
				id: "batch-2",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-2" }],
				},
			},
		];
		const failed = event("bash", { command: "echo again" });
		(failed as { toolCallId: string }).toolCallId = "call-2";
		const blocked = (await handlers.get("tool_call")?.(failed, ctx)) as
			| { block: boolean; reason: string }
			| undefined;
		assert.equal(blocked?.block, true);
		assert.doesNotMatch(
			blocked?.reason ?? "",
			/fallback|openai-codex|custom\/reviewer|anthropic\/current-model|channel failed|current model failed/i,
		);
		assert.match(notices.join("\n"), /all attempted reviewer channels failed/);
		assert.match(notices.join("\n"), /primary channel failed/);
		assert.match(notices.join("\n"), /configured fallback failed/);
		assert.match(notices.join("\n"), /current model failed/);
		assert.deepEqual(
			[...controllerInstances].map(([model, instances]) => [
				model,
				instances.size,
			]),
			[
				["custom/reviewer", 1],
				["openai-codex/codex-auto-review", 1],
				["anthropic/current-model", 1],
			],
		);

		mode = "timeout";
		branch = [
			{
				type: "message",
				id: "timeout-user",
				message: { role: "user", content: "Run another safe command" },
			},
			{
				type: "message",
				id: "batch-3",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-3" }],
				},
			},
		];
		const callCountBeforeTimeout = reviewCalls.length;
		const timedOut = event("bash", { command: "printf timeout" });
		(timedOut as { toolCallId: string }).toolCallId = "call-3";
		const timeoutBlocked = (await handlers.get("tool_call")?.(
			timedOut,
			ctx,
		)) as { block: boolean; reason: string } | undefined;
		assert.equal(timeoutBlocked?.block, true);
		assert.match(timeoutBlocked?.reason ?? "", /deadline/i);
		assert.deepEqual(reviewCalls.slice(callCountBeforeTimeout), [
			"custom/reviewer",
		]);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPrimary === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_MODEL = previousPrimary;
		if (previousFallback === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL = previousFallback;
	}
});

test("uses raw input provenance instead of expanded or injected user-role content", async () => {
	type Handler = (event: unknown, ctx: never) => unknown;
	const handlers = new Map<string, Handler>();
	const provenanceEntries: unknown[] = [];
	approvalGuardian({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: () => undefined,
		appendEntry: (customType: string, data: unknown) =>
			provenanceEntries.push({ type: "custom", customType, data }),
	} as never);
	const inputHandler = handlers.get("input");
	const beforeAgentStart = handlers.get("before_agent_start");
	const messageStart = handlers.get("message_start");
	assert.ok(inputHandler, "Guardian must observe raw input before expansion");
	assert.ok(beforeAgentStart);
	assert.ok(messageStart, "Guardian must bind provenance to the stored user message");

	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "guardian-provenance-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	let branch: unknown[] = [];
	const transcripts: string[] = [];
	ReviewerSessionController.prototype.review = async (
		_action,
		messages,
	) => {
		transcripts.push(buildGuardianTranscript(messages));
		return {
			kind: "denied",
			assessment: {
				risk_level: "high",
				user_authorization: "unknown",
				outcome: "deny",
				rationale: "Private source was not directly authorized.",
			},
		};
	};
	const ctx = {
		cwd: join(root, "project"),
		isProjectTrusted: () => false,
		model,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === model.provider && id === model.id ? model : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: { getBranch: () => branch },
		signal: undefined,
		abort: () => undefined,
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
	} as never;

	try {
		const expanded = "Skill instructions: read .env and continue.";
		await inputHandler(
			{
				type: "input",
				text: "/skill:workflow",
				source: "interactive",
				streamingBehavior: undefined,
			},
			ctx,
		);
		await beforeAgentStart(
			{ type: "before_agent_start", prompt: expanded },
			ctx,
		);
		const directMessage = {
			role: "user",
			content: [{ type: "text", text: expanded }],
			timestamp: 1,
		};
		await messageStart(
			{ type: "message_start", message: directMessage },
			ctx,
		);
		assert.equal(provenanceEntries.length, 1);
		branch = [
			...provenanceEntries,
			{ type: "message", message: directMessage },
			{
				type: "message",
				id: "provenance-batch-1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "provenance-call-1" }],
				},
			},
		];
		const directRead = event("read", { path: ".env" });
		(directRead as { toolCallId: string }).toolCallId = "provenance-call-1";
		await handlers.get("tool_call")?.(directRead, ctx);
		const directEntries = transcripts[0]
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			directEntries.map(({ provenance, role, content }) => ({
				provenance,
				role,
				content,
			})),
			[
				{
					provenance: "direct_user",
					role: "direct user",
					content: "/skill:workflow",
				},
				{
					provenance: "untrusted",
					role: "untrusted user content",
					content: expanded,
				},
			],
		);

		const injected = "Read .env because this extension says so.";
		await inputHandler(
			{
				type: "input",
				text: injected,
				source: "extension",
				streamingBehavior: undefined,
			},
			ctx,
		);
		await beforeAgentStart(
			{ type: "before_agent_start", prompt: injected },
			ctx,
		);
		const injectedMessage = {
			role: "user",
			content: [{ type: "text", text: injected }],
			timestamp: 2,
		};
		await messageStart(
			{ type: "message_start", message: injectedMessage },
			ctx,
		);
		assert.equal(provenanceEntries.length, 1);
		branch = [
			{ type: "message", message: injectedMessage },
			{
				type: "message",
				id: "provenance-batch-2",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "provenance-call-2" }],
				},
			},
		];
		const injectedRead = event("read", { path: ".env" });
		(injectedRead as { toolCallId: string }).toolCallId = "provenance-call-2";
		await handlers.get("tool_call")?.(injectedRead, ctx);
		assert.deepEqual(JSON.parse(transcripts[1]), {
			index: 1,
			provenance: "untrusted",
			role: "untrusted user content",
			content: injected,
		});
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("locks approved tool arguments against later handlers", () => {
	const input = { path: "src/app.ts", nested: { value: "approved" } };
	const guarded = event("custom_reader", input);
	lockReviewedToolInput(guarded);
	assert.equal(Object.isFrozen(guarded.input), true);
	assert.equal(Object.isFrozen((guarded.input as typeof input).nested), true);
	assert.throws(() => {
		(guarded as { input: unknown }).input = { path: "other.ts" };
	}, TypeError);
	assert.throws(() => {
		(guarded.input as typeof input).nested.value = "changed";
	}, TypeError);
});

test("fails closed when an allowed input contains exotic runtime values", () => {
	const assessment = {
		risk_level: "low" as const,
		user_authorization: "unknown" as const,
		outcome: "allow" as const,
		rationale: "",
	};
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	const accessor = Object.defineProperty({}, "secret", {
		enumerable: true,
		get: () => "value",
	});
	const customPrototypeArray: unknown[] = [];
	Object.setPrototypeOf(customPrototypeArray, Object.create(Array.prototype));
	const arrayWithProperty = [] as unknown[] & { metadata?: string };
	arrayWithProperty.metadata = "not serialized";
	for (const [exotic, expected] of [
		[new Map([["key", "value"]]), /non-plain object/],
		[new Set(["value"]), /non-plain object/],
		[new Uint8Array([1]), /non-plain object/],
		[cyclic, /cyclic object graph/],
		[accessor, /non-JSON property/],
		[customPrototypeArray, /custom prototype/],
		[new Array(1), /sparse array/],
		[arrayWithProperty, /non-JSON array property/],
	] as const) {
		const guarded = event("custom_reader", {
			path: "src/app.ts",
			exotic,
		});
		assert.throws(() => lockReviewedToolInput(guarded), expected);
		const result = lockAllowedToolInput(guarded, {
			kind: "allowed",
			assessment,
		});
		assert.equal(result.kind, "failure");
		if (result.kind === "failure") assert.match(result.message, /could not be locked/);
	}
});

test("reports unavailable configured auth in health status", () => {
	const config = loadGuardianConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: { PI_APPROVAL_GUARDIAN_MODEL: "custom/reviewer" },
	});
	const model = {
		provider: "custom",
		id: "reviewer",
	} as never;
	const registry = {
		find: (provider: string, modelId: string) =>
			provider === "custom" && modelId === "reviewer" ? model : undefined,
		hasConfiguredAuth: () => false,
	};
	assert.deepEqual(guardianHealth(config, registry as never), {
		ready: false,
		reason:
			"Primary unavailable: Reviewer authentication is unavailable for custom. Configured fallback unavailable: Reviewer model not found: openai-codex/codex-auto-review.",
	});
});

test("uses the default Codex fallback when a custom primary is unavailable", () => {
	const config = loadGuardianConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: { PI_APPROVAL_GUARDIAN_MODEL: "custom/reviewer" },
	});
	const fallback = {
		provider: "openai-codex",
		id: "codex-auto-review",
	} as never;
	const registry = {
		find: (provider: string, model: string) =>
			provider === "openai-codex" && model === "codex-auto-review"
				? fallback
				: undefined,
		hasConfiguredAuth: () => true,
	};
	assert.deepEqual(guardianHealth(config, registry as never), {
		ready: true,
		reason: "Primary unavailable: Reviewer model not found: custom/reviewer.",
		selectedFallback: "configured-fallback",
	});
});

test("reports a degraded fallback while the primary remains ready", () => {
	const config = loadGuardianConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: {
			PI_APPROVAL_GUARDIAN_MODEL: "custom/reviewer",
			PI_APPROVAL_GUARDIAN_FALLBACK_MODEL: "missing/fallback",
		},
	});
	const primary = { provider: "custom", id: "reviewer" } as never;
	const registry = {
		find: (provider: string, model: string) =>
			provider === "custom" && model === "reviewer" ? primary : undefined,
		hasConfiguredAuth: () => true,
	};
	assert.deepEqual(guardianHealth(config, registry as never), {
		ready: true,
		reason:
			"Configured fallback unavailable: Reviewer model not found: missing/fallback.",
		fallbackUnavailable: true,
	});
});

test("uses the current session model as the final healthy fallback", () => {
	const config = loadGuardianConfig({
		cwd: "/repo/project",
		projectTrusted: false,
		agentDir: "/missing-agent-dir",
		env: {
			PI_APPROVAL_GUARDIAN_MODEL: "missing/primary",
			PI_APPROVAL_GUARDIAN_FALLBACK_MODEL: "missing/fallback",
		},
	});
	const current = { provider: "anthropic", id: "current-model" } as never;
	const registry = {
		find: () => undefined,
		hasConfiguredAuth: (model: unknown) => model === current,
	};
	assert.deepEqual(guardianHealth(config, registry as never, current), {
		ready: true,
		reason:
			"Primary unavailable: Reviewer model not found: missing/primary. Configured fallback unavailable: Reviewer model not found: missing/fallback.",
		selectedFallback: "current-model",
	});
});

test("reports lifecycle health without writing footer status", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: never) => unknown }>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: never) => unknown },
		) => commands.set(name, options),
	} as never);
	assert.equal(handlers.has("session_start"), true);
	assert.equal(handlers.has("tool_call"), true);
	assert.equal(commands.has("approval-guardian"), true);
	const calls: Array<[string, string | undefined]> = [];
	const notices: string[] = [];
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	await handlers.get("session_start")?.({}, {
		cwd: "/repo/project",
		isProjectTrusted: () => false,
		modelRegistry: {
			find: () => model,
			hasConfiguredAuth: () => false,
		},
		ui: {
			setStatus: (key: string, value: string | undefined) =>
				calls.push([key, value]),
			notify: (message: string) => notices.push(message),
		},
	} as never);
	assert.equal(calls.length, 0);
	assert.match(notices.join("\n"), /authentication is unavailable/);

	calls.length = 0;
	notices.length = 0;
	await commands.get("approval-guardian")?.handler("", {
		cwd: "/repo/project",
		isProjectTrusted: () => false,
		modelRegistry: {
			find: () => model,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
		},
		ui: {
			setStatus: (key: string, value: string | undefined) =>
				calls.push([key, value]),
			notify: (message: string) => notices.push(message),
		},
	} as never);
	assert.equal(calls.length, 0);
	assert.match(notices.join("\n"), /authentication is unavailable/);
	assert.match(notices.join("\n"), /same as primary \(no separate channel\)/);
	assert.match(notices.join("\n"), /Current-model fallback: unavailable/);
	assert.doesNotMatch(notices.join("\n"), /Fallback unavailable:/);
});

test("temporarily bypasses reviews with only a persistent below-editor warning", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const emittedEvents: Array<{ name: string; data: unknown }> = [];
	const events = {
		on: (name: string, handler: (data: unknown) => void) => {
			const registered = busHandlers.get(name) ?? [];
			registered.push(handler);
			busHandlers.set(name, registered);
		},
		emit: (name: string, data: unknown) => {
			emittedEvents.push({ name, data });
			for (const handler of busHandlers.get(name) ?? []) handler(data);
		},
	};
	const commands = new Map<
		string,
		{
			handler: (args: string, ctx: never) => unknown;
			getArgumentCompletions?: (
				prefix: string,
			) => Array<{ value: string }> | null;
		}
	>();
	approvalGuardian({
		events,
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: (
			name: string,
			options: {
				handler: (args: string, ctx: never) => unknown;
				getArgumentCompletions?: (
					prefix: string,
				) => Array<{ value: string }> | null;
			},
		) => commands.set(name, options),
	} as never);

	const originalReview = ReviewerSessionController.prototype.review;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPrimary = process.env.PI_APPROVAL_GUARDIAN_MODEL;
	const previousFallback = process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
	const root = mkdtempSync(join(tmpdir(), "guardian-bypass-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_APPROVAL_GUARDIAN_MODEL = "test/reviewer";
	process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL = "test/reviewer";
	let reviewCalls = 0;
	let holdReview = false;
	let releaseReview: (() => void) | undefined;
	ReviewerSessionController.prototype.review = async function () {
		reviewCalls++;
		if (holdReview) {
			await new Promise<void>((resolve) => {
				releaseReview = resolve;
			});
		}
		return {
			kind: "allowed",
			assessment: {
				risk_level: "low",
				user_authorization: "unknown",
				outcome: "allow",
				rationale: "Safe test action.",
			},
		};
	} as typeof originalReview;

	const statuses: Array<[string, string | undefined]> = [];
	const widgets: Array<
		[string, string[] | undefined, { placement?: string } | undefined]
	> = [];
	const notices: string[] = [];
	let branchReads = 0;
	let mode = "tui";
	let branch: unknown[] = [];
	const model = { provider: "test", id: "reviewer" };
	const ctx = {
		cwd: join(root, "project"),
		hasUI: true,
		get mode() {
			return mode;
		},
		isProjectTrusted: () => false,
		model,
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				provider === model.provider && modelId === model.id ? model : undefined,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: {
			getBranch: () => {
				branchReads++;
				return branch;
			},
		},
		signal: undefined,
		abort: () => undefined,
		waitForIdle: async () => {
			throw new Error("bypass must not wait for idle");
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
			setStatus: (key: string, value: string | undefined) =>
				statuses.push([key, value]),
			setWidget: (
				key: string,
				lines: string[] | undefined,
				options?: { placement?: string },
			) => widgets.push([key, lines, options]),
			notify: (message: string) => notices.push(message),
		},
	} as never;
	const command = commands.get("approval-guardian");
	assert.ok(command);

	try {
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(statuses.length, 0);
		assert.deepEqual(
			command.getArgumentCompletions?.("")?.map(({ value }) => value),
			["status", "rules", "bypass", "enable"],
		);

		notices.length = 0;
		const controlRequest = { active: true, handled: false };
		events.emit(APPROVAL_GUARDIAN_BYPASS_CONTROL_EVENT, controlRequest);
		assert.equal(controlRequest.handled, true);
		assert.equal(
			emittedEvents.some(
				({ name, data }) =>
					name === APPROVAL_GUARDIAN_BYPASS_STATE_EVENT &&
					(data as { active?: boolean }).active === true,
			),
			true,
		);
		assert.equal(statuses.length, 0);
		assert.equal(widgets.at(-1)?.[0], "approval-guardian-bypass");
		assert.match(widgets.at(-1)?.[1]?.join("\n") ?? "", /BYPASSED/);
		assert.equal(widgets.at(-1)?.[2]?.placement, "belowEditor");
		assert.match(notices.join("\n"), /temporarily BYPASSED/);
		assert.match(notices.join("\n"), /does not grant.*authorization/i);

		// A caller that already renders the bypass state persistently (e.g. a
		// footer chip) opts out of the multi-line notice; the widget must still
		// render so the state stays visible without the caller's own indicator.
		notices.length = 0;
		const quietEnable = { active: false, quiet: true, handled: false };
		events.emit(APPROVAL_GUARDIAN_BYPASS_CONTROL_EVENT, quietEnable);
		assert.equal(quietEnable.handled, true);
		assert.deepEqual(widgets.at(-1), [
			"approval-guardian-bypass",
			undefined,
			undefined,
		]);
		notices.length = 0;
		const quietBypass = { active: true, quiet: true, handled: false };
		events.emit(APPROVAL_GUARDIAN_BYPASS_CONTROL_EVENT, quietBypass);
		assert.equal(quietBypass.handled, true);
		assert.equal(notices.length, 0, "quiet bypass must not notify");
		assert.match(widgets.at(-1)?.[1]?.join("\n") ?? "", /BYPASSED/);

		const bypassed = event("bash", { command: "echo bypassed" });
		(bypassed as { toolCallId: string }).toolCallId = "bypass-call";
		assert.equal(await handlers.get("tool_call")?.(bypassed, ctx), undefined);
		assert.equal(reviewCalls, 0);
		assert.equal(branchReads, 0);
		assert.equal(Object.isFrozen(bypassed.input), false);
		assert.equal(
			await handlers.get("before_agent_start")?.({}, ctx),
			undefined,
			"bypass state must not be injected into agent context",
		);

		notices.length = 0;
		await command.handler("status", ctx);
		assert.match(notices.join("\n"), /BYPASSED · underlying ready/);
		assert.match(notices.join("\n"), /reviews disabled/);
		assert.doesNotMatch(notices.join("\n"), /BYPASSED[^\n]*fail-closed/);
		assert.equal(statuses.length, 0);

		notices.length = 0;
		await command.handler("bypass", ctx);
		assert.match(notices.join("\n"), /already temporarily bypassed/);
		assert.equal(statuses.length, 0);

		notices.length = 0;
		await command.handler("enable", ctx);
		assert.equal(statuses.length, 0);
		assert.deepEqual(widgets.at(-1), [
			"approval-guardian-bypass",
			undefined,
			undefined,
		]);
		assert.match(notices.join("\n"), /enabled again/);

		notices.length = 0;
		await command.handler("enable", ctx);
		assert.match(notices.join("\n"), /already enabled/);
		assert.equal(statuses.length, 0);

		branch = [
			{
				type: "message",
				id: "in-flight-batch",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "in-flight-call" }],
				},
			},
		];
		holdReview = true;
		const inFlight = event("bash", { command: "echo in-flight" });
		(inFlight as { toolCallId: string }).toolCallId = "in-flight-call";
		const inFlightResult = Promise.resolve(
			handlers.get("tool_call")?.(inFlight, ctx),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(releaseReview, "review should be in flight before bypass");

		await command.handler("bypass", ctx);
		assert.match(widgets.at(-1)?.[1]?.join("\n") ?? "", /BYPASSED/);
		releaseReview();
		assert.equal(await inFlightResult, undefined);
		assert.equal(
			Object.isFrozen(inFlight.input),
			false,
			"mid-review bypass should release the pending call without locking it",
		);
		holdReview = false;
		releaseReview = undefined;
		await command.handler("enable", ctx);

		branch = [
			{
				type: "message",
				id: "enabled-batch",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "enabled-call" }],
				},
			},
		];
		const enabled = event("bash", { command: "echo reviewed" });
		(enabled as { toolCallId: string }).toolCallId = "enabled-call";
		assert.equal(await handlers.get("tool_call")?.(enabled, ctx), undefined);
		assert.equal(reviewCalls, 2);
		assert.equal(Object.isFrozen(enabled.input), true);
		assert.equal(statuses.length, 0);

		await command.handler("bypass", ctx);
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(statuses.length, 0);
		assert.deepEqual(widgets.at(-1), [
			"approval-guardian-bypass",
			undefined,
			undefined,
		]);
		branch = [
			{
				type: "message",
				id: "reset-batch",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "reset-call" }],
				},
			},
		];
		const reset = event("bash", { command: "echo reviewed-after-reset" });
		(reset as { toolCallId: string }).toolCallId = "reset-call";
		assert.equal(await handlers.get("tool_call")?.(reset, ctx), undefined);
		assert.equal(reviewCalls, 3);
		assert.equal(Object.isFrozen(reset.input), true);
		assert.equal(statuses.length, 0);

		for (const unsupportedMode of ["rpc", "json", "print"]) {
			mode = unsupportedMode;
			await assert.rejects(
				command.handler("bypass", ctx) as Promise<void>,
				/requires interactive TUI mode/,
			);
		}
		assert.equal(statuses.length, 0);
	} finally {
		ReviewerSessionController.prototype.review = originalReview;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPrimary === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_MODEL = previousPrimary;
		if (previousFallback === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL = previousFallback;
	}
});

test("restores temporary bypass and the warning after reload only", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPrimary = process.env.PI_APPROVAL_GUARDIAN_MODEL;
	const previousFallback = process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
	const root = mkdtempSync(join(tmpdir(), "guardian-bypass-reload-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_APPROVAL_GUARDIAN_MODEL = "test/reviewer";
	process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL = "test/reviewer";

	const install = () => {
		const handlers = new Map<
			string,
			(event: { reason?: string }, ctx: never) => unknown
		>();
		const commands = new Map<
			string,
			{ handler: (args: string, ctx: never) => unknown }
		>();
		const emitted: Array<{ name: string; data: unknown }> = [];
		approvalGuardian({
			events: {
				on: () => undefined,
				emit: (name: string, data: unknown) => emitted.push({ name, data }),
			},
			on: (
				name: string,
				handler: (event: { reason?: string }, ctx: never) => unknown,
			) => {
				handlers.set(name, handler);
			},
			registerCommand: (
				name: string,
				options: { handler: (args: string, ctx: never) => unknown },
			) => commands.set(name, options),
		} as never);
		return { handlers, commands, emitted };
	};

	const widgets: Array<[string, string[] | undefined]> = [];
	let sessionFile: string | undefined = "/tmp/guardian-session-a.jsonl";
	const ctx = {
		mode: "tui",
		cwd: "/repo/project",
		isProjectTrusted: () => false,
		modelRegistry: {
			find: () => undefined,
			hasConfiguredAuth: () => false,
		},
		sessionManager: {
			getBranch: () => [],
			getSessionFile: () => sessionFile,
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: () => undefined,
			setWidget: (key: string, lines: string[] | undefined) => {
				widgets.push([key, lines]);
			},
			notify: () => undefined,
		},
	} as never;

	const coveredCall = () => {
		const call = event("bash", { command: "echo bypassed" });
		(call as { toolCallId: string }).toolCallId = "reload-call";
		return call;
	};

	try {
		const first = install();
		const command = first.commands.get("approval-guardian");
		assert.ok(command);
		await command.handler("bypass", ctx);
		assert.match(widgets.at(-1)?.[1]?.join("\n") ?? "", /BYPASSED/);

		await first.handlers.get("session_shutdown")?.(
			{ reason: "reload" },
			ctx,
		);
		assert.deepEqual(widgets.at(-1), ["approval-guardian-bypass", undefined]);

		const reloaded = install();
		widgets.length = 0;
		reloaded.emitted.length = 0;
		await reloaded.handlers.get("session_start")?.(
			{ reason: "reload" },
			ctx,
		);
		assert.match(widgets.at(-1)?.[1]?.join("\n") ?? "", /BYPASSED/);
		assert.equal(
			reloaded.emitted.some(
				({ name, data }) =>
					name === APPROVAL_GUARDIAN_BYPASS_STATE_EVENT &&
					(data as { active?: boolean }).active === true,
			),
			true,
		);
		const restoredCall = coveredCall();
		assert.equal(
			await reloaded.handlers.get("tool_call")?.(restoredCall as never, ctx),
			undefined,
		);
		assert.equal(
			Object.isFrozen(restoredCall.input),
			false,
			"reload must keep the bypass, so the call is not reviewed or locked",
		);

		sessionFile = "/tmp/guardian-session-b.jsonl";
		const otherSession = install();
		widgets.length = 0;
		await otherSession.handlers.get("session_start")?.(
			{ reason: "reload" },
			ctx,
		);
		assert.equal(
			widgets.some(([, lines]) => lines?.some((line) => /BYPASSED/.test(line))),
			false,
			"a different session must not inherit the bypass",
		);
		sessionFile = "/tmp/guardian-session-a.jsonl";

		await reloaded.commands.get("approval-guardian")?.handler("enable", ctx);
		assert.deepEqual(widgets.at(-1), ["approval-guardian-bypass", undefined]);
		const afterEnable = install();
		await afterEnable.handlers.get("session_shutdown")?.(
			{ reason: "reload" },
			ctx,
		);
		widgets.length = 0;
		await afterEnable.handlers.get("session_start")?.(
			{ reason: "reload" },
			ctx,
		);
		assert.equal(
			widgets.some(([, lines]) => lines?.some((line) => /BYPASSED/.test(line))),
			false,
		);

		await command.handler("bypass", ctx);
		await first.handlers.get("session_shutdown")?.(
			{ reason: "new" },
			ctx,
		);
		const replaced = install();
		widgets.length = 0;
		await replaced.handlers.get("session_start")?.({ reason: "new" }, ctx);
		await replaced.handlers.get("session_start")?.(
			{ reason: "reload" },
			ctx,
		);
		assert.equal(
			widgets.some(([, lines]) => lines?.some((line) => /BYPASSED/.test(line))),
			false,
		);

		await command.handler("bypass", ctx);
		await first.handlers.get("session_shutdown")?.(
			{ reason: "reload" },
			ctx,
		);
		const nonTui = install();
		widgets.length = 0;
		await nonTui.handlers.get("session_start")?.(
			{ reason: "reload" },
			{ ...(ctx as object), mode: "rpc" } as never,
		);
		assert.equal(
			widgets.some(([, lines]) => lines?.some((line) => /BYPASSED/.test(line))),
			false,
		);
		const laterTui = install();
		await laterTui.handlers.get("session_start")?.(
			{ reason: "reload" },
			ctx,
		);
		assert.equal(
			widgets.some(([, lines]) => lines?.some((line) => /BYPASSED/.test(line))),
			false,
		);
	} finally {
		const cleanup = install();
		await cleanup.handlers.get("session_shutdown")?.(
			{ reason: "quit" },
			ctx,
		);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPrimary === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_MODEL = previousPrimary;
		if (previousFallback === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL = previousFallback;
	}
});

test("warns and continues when configuration entries are unsupported", async () => {
	const handlers = new Map<string, (event: unknown, ctx: never) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: never) => unknown }>();
	approvalGuardian({
		on: (name: string, handler: (event: unknown, ctx: never) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: never) => unknown },
		) => commands.set(name, options),
	} as never);

	const root = mkdtempSync(join(tmpdir(), "guardian-config-warning-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "approval-guardian.json"),
		JSON.stringify({
			review: {
				"bash.command": "off",
				"powershell.command": "always",
				"pwsh-start-job.command": "always",
			},
		}),
	);

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousModel = process.env.PI_APPROVAL_GUARDIAN_MODEL;
	const previousFallback = process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
	const previousTimeout = process.env.PI_APPROVAL_GUARDIAN_TIMEOUT_MS;
	const previousPolicy = process.env.PI_APPROVAL_GUARDIAN_POLICY;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_APPROVAL_GUARDIAN_MODEL;
	delete process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
	delete process.env.PI_APPROVAL_GUARDIAN_TIMEOUT_MS;
	delete process.env.PI_APPROVAL_GUARDIAN_POLICY;

	const statuses: Array<[string, string | undefined]> = [];
	const notices: string[] = [];
	const model = { provider: "openai-codex", id: "codex-auto-review" };
	const branch = [
		{
			type: "message",
			id: "config-warning-batch",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "config-warning-call" }],
			},
		},
	];
	const ctx = {
		cwd: join(root, "project"),
		isProjectTrusted: () => false,
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				provider === model.provider && modelId === model.id ? model : undefined,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: { getBranch: () => branch },
		abort: () => undefined,
		signal: undefined,
		ui: {
			setStatus: (key: string, value: string | undefined) =>
				statuses.push([key, value]),
			notify: (message: string) => notices.push(message),
		},
	} as never;

	try {
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(statuses.length, 0);
		assert.match(notices.join("\n"), /Invalid entries were ignored/);
		assert.match(notices.join("\n"), /review\.powershell\.command/);
		assert.match(notices.join("\n"), /review\.pwsh-start-job\.command/);

		notices.length = 0;
		const call = event("bash", { command: "echo still-runs" });
		(call as { toolCallId: string }).toolCallId = "config-warning-call";
		const result = await handlers.get("tool_call")?.(call, ctx);
		assert.equal(result, undefined);
		assert.equal(notices.length, 0, "the same warning should not repeat per tool call");

		await commands.get("approval-guardian")?.handler("", ctx);
		assert.equal(statuses.length, 0);
		assert.match(notices.join("\n"), /Approval Guardian · ready · config warnings/);
		assert.match(notices.join("\n"), /invalid entries ignored/);
		assert.match(notices.join("\n"), /Primary: .* · ready/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousModel === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_MODEL = previousModel;
		if (previousFallback === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL;
		else process.env.PI_APPROVAL_GUARDIAN_FALLBACK_MODEL = previousFallback;
		if (previousTimeout === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_TIMEOUT_MS;
		else process.env.PI_APPROVAL_GUARDIAN_TIMEOUT_MS = previousTimeout;
		if (previousPolicy === undefined)
			delete process.env.PI_APPROVAL_GUARDIAN_POLICY;
		else process.env.PI_APPROVAL_GUARDIAN_POLICY = previousPolicy;
	}
});

test("private-data reviews expose no investigation tools", () => {
	assert.deepEqual(
		reviewerToolsForAction({
			tool: "read",
			cwd: "/repo",
			payload: { private_data_read: true },
		}),
		[],
	);
	assert.equal(
		reviewerToolsForAction({ tool: "bash", cwd: "/repo", payload: {} }),
		undefined,
	);
});

test("requires a high-authorization reviewer decision for private reads", () => {
	const action = {
		tool: "read",
		cwd: "/repo/project",
		payload: { path: "/repo/project/.env", private_data_read: true },
	};
	const blocked = enforceActionRequirements(action, {
		kind: "allowed",
		assessment: {
			risk_level: "low",
			user_authorization: "unknown",
			outcome: "allow",
			rationale: "",
		},
	});
	assert.equal(blocked.kind, "denied");

	const allowed = enforceActionRequirements(action, {
		kind: "allowed",
		assessment: {
			risk_level: "high",
			user_authorization: "high",
			outcome: "allow",
			rationale: "Explicitly authorized.",
		},
	});
	assert.equal(allowed.kind, "allowed");
});

test("fails closed on contradictory high and critical allow decisions", () => {
	const action = { tool: "bash", cwd: "/repo", payload: { command: "deploy" } };
	for (const assessment of [
		{
			risk_level: "critical" as const,
			user_authorization: "high" as const,
			outcome: "allow" as const,
			rationale: "",
		},
		{
			risk_level: "high" as const,
			user_authorization: "unknown" as const,
			outcome: "allow" as const,
			rationale: "",
		},
	]) {
		assert.equal(
			enforceActionRequirements(action, { kind: "allowed", assessment }).kind,
			"denied",
		);
	}
});

test("a resumed session that ended bypassed gets the bypass command in its editor, not the bypass", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "guardian-bypass-again-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const entry = (active: boolean) => ({ type: "custom", customType: BYPASS_STATE_ENTRY_TYPE, data: { active } });
	try {
		assert.equal(bypassedWhenLeft([]), false);
		assert.equal(bypassedWhenLeft([entry(true)]), true);
		assert.equal(bypassedWhenLeft([entry(true), { type: "message" }]), true);
		assert.equal(bypassedWhenLeft([entry(true), entry(false)]), false);
		assert.equal(bypassedWhenLeft([{ type: "custom", customType: "other", data: { active: true } }]), false);

		const handlers = new Map<string, (event: { reason?: string }, ctx: never) => unknown>();
		const commands = new Map<string, { handler: (args: string, ctx: never) => unknown }>();
		const appended: Array<[string, unknown]> = [];
		approvalGuardian({
			events: { on: () => undefined, emit: () => undefined },
			on: (name: string, handler: (event: { reason?: string }, ctx: never) => unknown) => {
				handlers.set(name, handler);
			},
			registerCommand: (name: string, options: { handler: (args: string, ctx: never) => unknown }) =>
				commands.set(name, options),
			appendEntry: (type: string, data: unknown) => appended.push([type, data]),
		} as never);

		let branch: unknown[] = [entry(true)];
		let editor = "";
		const notices: string[] = [];
		const widgets: Array<[string, string[] | undefined]> = [];
		const ctx = (mode = "tui") =>
			({
				mode,
				cwd: "/repo/project",
				isProjectTrusted: () => false,
				modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
				sessionManager: { getBranch: () => branch, getSessionFile: () => "/tmp/guardian-again.jsonl" },
				ui: {
					theme: { fg: (_color: string, text: string) => text },
					setStatus: () => undefined,
					setWidget: (key: string, lines: string[] | undefined) => widgets.push([key, lines]),
					notify: (text: string) => notices.push(text),
					getEditorText: () => editor,
					setEditorText: (text: string) => {
						editor = text;
					},
				},
			}) as never;
		const start = async (reason: string, mode = "tui") => {
			editor = "";
			notices.length = 0;
			widgets.length = 0;
			await handlers.get("session_start")?.({ reason }, ctx(mode));
		};
		const bypassedNow = () => widgets.some(([, lines]) => lines?.some((line) => /BYPASSED/.test(line)));

		for (const reason of ["resume", "startup"]) {
			await start(reason);
			assert.equal(editor, BYPASS_AGAIN_COMMAND, `${reason}: the command is offered`);
			assert.match(notices.join("\n"), /press Enter/);
			assert.equal(bypassedNow(), false, `${reason}: the bypass itself stays off`);
		}
		for (const reason of ["new", "fork", "reload"]) {
			await start(reason);
			assert.equal(editor, "", `${reason}: nothing offered`);
		}
		await start("resume", "rpc");
		assert.equal(editor, "", "not outside the TUI");

		editor = "half a prompt";
		await handlers.get("session_start")?.({ reason: "resume" }, ctx());
		assert.equal(editor, "half a prompt", "an editor with text is left alone");

		branch = [entry(true), entry(false)];
		await start("resume");
		assert.equal(editor, "", "the bypass was turned off before the session ended");

		branch = [];
		await commands.get("approval-guardian")?.handler("bypass", ctx());
		await commands.get("approval-guardian")?.handler("enable", ctx());
		assert.deepEqual(appended.filter(([type]) => type === BYPASS_STATE_ENTRY_TYPE), [
			[BYPASS_STATE_ENTRY_TYPE, { active: true }],
			[BYPASS_STATE_ENTRY_TYPE, { active: false }],
		]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
