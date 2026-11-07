/**
 * What a Cursor run changed, for the phone (Botsun's Show work).
 *
 * Two halves. The capture (diff.ts) runs against real git repos in a temp dir:
 * tracked edits, untracked files, binary files, the cap and secret masking. The
 * plumbing runs the cursor tool over a fake cursor-agent (PI_CURSOR_AGENT_BIN)
 * and checks details.diff/diffStats/diffPath on a foreground result and on a
 * background job's completion message. The real cursor-agent never runs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "cursor-diff-test-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

process.env.BOEHSLINE_CONFIG = path.join(scratch, "none.json");
process.env.BOEHSLINE_ENABLE = "cursor-agent";
process.env.PI_BG_DIR = path.join(scratch, "bg");
process.env.PI_BG_STATE_DIR = path.join(scratch, "bg-state");
process.env.PI_BG_WAKE = "followUp";
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
process.env.PI_CURSOR_STATE_DIR = path.join(scratch, "state");
for (const k of Object.keys(process.env)) if (k.startsWith("PI_CURSOR_") && k !== "PI_CURSOR_AGENT_BIN" && k !== "PI_CURSOR_STATE_DIR") delete process.env[k];

// A failing Keychain shim first on PATH, so nothing can read a real Cursor token.
const shims = path.join(scratch, "shims");
mkdirSync(shims);
writeFileSync(path.join(shims, "security"), "#!/bin/sh\nexit 44\n");
chmodSync(path.join(shims, "security"), 0o755);
process.env.PATH = `${shims}${path.delimiter}${process.env.PATH}`;

const {
	assembleDiff,
	captureBase,
	captureChanges,
	cursorStateDir,
	MAX_FILE_DIFF_BYTES,
	MAX_UNTRACKED_BYTES,
	PRUNE_AGE_MS,
	PRUNE_KEEP,
	pruneStateDir,
	STOP_GIT_TIMEOUT_MS,
	writeDiffFile,
} = await import("../extensions/opt-in/cursor-agent/diff.ts");
const { describeTool, editOf } = await import("../extensions/opt-in/cursor-agent/events.ts");
const { acceptDiffPath, commandRunsCursorRunner, cursorRunnerFile, detailsPath, isSensitivePath, maskDiffSecrets, pathsInText, readJobDetails, reduceDiffText, shellArgv, trustCursorDiff, writeExclusive, writeJobDetails } = await import("../lib/cursor-diff.ts");
const { cursorDetailsRequested } = await import("../extensions/opt-in/cursor-agent/runner.ts");
const qArg = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const runnerCommand = (spec = path.join(scratch, "spec.json")) => `${qArg(process.execPath)} ${qArg(cursorRunnerFile)} ${qArg(spec)}`;
const { bindChildren, childTranscript, listChildren, pollOnce, trackChild } = await import("../lib/children.ts");

/** git in a temp repo the way this machine's tests must: unsigned, no filters, no hooks. */
const git = (cwd, ...args) =>
	execFileSync(
		"git",
		[
			"-C", cwd,
			"-c", "user.email=t@t",
			"-c", "user.name=t",
			"-c", "commit.gpgsign=false",
			"-c", "tag.gpgsign=false",
			"-c", "core.hooksPath=/dev/null",
			...args,
		],
		{ encoding: "utf8" },
	);

let repoCount = 0;
/** A repo with one commit (fizz.rb, logo.bin, a .gitignore that ignores ignored/). */
function newRepo() {
	const repo = path.join(scratch, `repo-${++repoCount}`);
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
	writeFileSync(path.join(repo, "fizz.rb"), "a\nb\nc\n");
	writeFileSync(path.join(repo, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff, 0x00]));
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "init");
	return repo;
}

// A secret-shaped pair, built at runtime: no token-shaped literal in the source.
const SECRET_NAME = ["api", "key"].join("_");
const SECRET_VALUE = ["abcd", "1234efgh", "5678"].join("");
const SECRET_LINE = `${SECRET_NAME} = "${SECRET_VALUE}"`;

const modeOf = (p) => statSync(p).mode & 0o777;

test("captureChanges: tracked edits, untracked files and a binary file, masked, out of the way", async () => {
	const repo = newRepo();
	const base = await captureBase(repo, false);
	assert.equal(base?.kind, "tree", "an in-place run is measured from a tree");
	writeFileSync(path.join(repo, "fizz.rb"), "a\nB\nc\n");
	writeFileSync(path.join(repo, "new.rb"), `# ${SECRET_LINE}\nhi\n`);
	writeFileSync(path.join(repo, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x02, 0xfe, 0x00, 0x07]));
	mkdirSync(path.join(repo, "ignored"));
	writeFileSync(path.join(repo, "ignored", "noise.log"), "noise\n");

	const stateDir = path.join(scratch, "state-one");
	const diff = await captureChanges(repo, base.base, { stateDir, runId: "run-one" });

	assert.match(diff.full, /^diff --git a\/fizz\.rb b\/fizz\.rb$/m);
	assert.match(diff.full, /^-b$/m);
	assert.match(diff.full, /^\+B$/m);
	assert.match(diff.full, /^\+hi$/m, "the untracked file is in the diff");
	assert.ok(diff.full.includes("Binary file logo.bin changed"), "a binary file is named, not dumped");
	assert.ok(!diff.full.includes("\u0000"), "no binary body");
	assert.ok(!diff.full.includes("noise.log"), "gitignored paths are not the run's diff");
	assert.ok(diff.full.includes("api_key = •••"), "the secret value is masked");
	assert.ok(!diff.full.includes(SECRET_VALUE), "and never appears raw");
	assert.deepEqual(diff.diffStats, { files: 3, insertions: 3, deletions: 1, truncated: false });
	assert.ok(diff.diff.length > 0 && diff.transcriptDiff.length > 0);

	// The file keeps the full diff, owner-only.
	assert.equal(path.dirname(diff.diffPath), stateDir);
	assert.match(path.basename(diff.diffPath), /^run-one-[0-9a-f]{8}\.diff$/, "named for the run, plus a random suffix");
	assert.equal(readFileSync(diff.diffPath, "utf8"), diff.full);
	assert.equal(modeOf(diff.diffPath), 0o600);
	assert.equal(modeOf(stateDir), 0o700);
});

test("captureChanges: dirt that was there before the run is not the run's", async () => {
	const repo = newRepo();
	writeFileSync(path.join(repo, "fizz.rb"), "a\nPRE-EXISTING\nc\n");
	const base = await captureBase(repo, false);
	writeFileSync(path.join(repo, "fizz.rb"), "a\nPRE-EXISTING\nC\n"); // the run's own edit

	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-two") });
	assert.match(diff.full, /^\+C$/m);
	assert.match(diff.full, /^ PRE-EXISTING$/m, "the earlier dirt is a context line, not the run's");
	assert.doesNotMatch(diff.full, /^[+-]PRE-EXISTING$/m);
});

test("captureChanges: a worktree run is measured from the commit it started at", async () => {
	const repo = newRepo();
	const wt = path.join(scratch, "repo-wt");
	git(repo, "worktree", "add", "-q", "-b", "pi-test", wt);
	const base = await captureBase(repo, true);
	assert.equal(base?.kind, "commit", "a worktree run is measured from a commit");
	writeFileSync(path.join(wt, "fizz.rb"), "a\nWT\nc\n");
	writeFileSync(path.join(wt, "added.rb"), "new\n");

	const diff = await captureChanges(wt, base.base, { stateDir: path.join(scratch, "state-three"), runId: "wt" });
	assert.match(diff.full, /^\+WT$/m);
	assert.match(diff.full, /^\+new$/m);
	assert.deepEqual(diff.diffStats, { files: 2, insertions: 2, deletions: 1, truncated: false });
});

test("captureChanges: nothing changed is no diff and no file", async () => {
	const repo = newRepo();
	const base = await captureBase(repo, false);
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-four"), runId: "empty" });
	assert.equal(diff.full, "");
	assert.deepEqual(diff.diffStats, { files: 0, insertions: 0, deletions: 0, truncated: false });
	assert.equal(diff.diffPath, undefined);
	const four = path.join(scratch, "state-four");
	assert.deepEqual(existsSync(four) ? readdirSync(four) : [], [], "no file written");
});

test("captureChanges: a symlinked state dir is refused, so the diff is not written through it", async () => {
	const repo = newRepo();
	const base = await captureBase(repo, false);
	writeFileSync(path.join(repo, "fizz.rb"), "a\nB\nc\n");
	const elsewhere = path.join(scratch, "elsewhere");
	mkdirSync(elsewhere);
	const linked = path.join(scratch, "linked-state");
	symlinkSync(elsewhere, linked);

	const diff = await captureChanges(repo, base.base, { stateDir: linked, runId: "linked" });
	assert.equal(diff.diffPath, undefined);
	assert.deepEqual(readdirSync(elsewhere), []);
});

/** One `diff --git` chunk for a file whose single line is `text`. */
const chunk = (file, text) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${text}\n`;

test("assembleDiff: the cap cuts at a file boundary and says how much is left", () => {
	const raw = [chunk("a.rb", "A"), chunk("b.rb", "B"), chunk("c.rb", "C"), chunk("d.rb", "D")].join("");
	const capped = assembleDiff(raw, false, 180, 90);

	assert.equal(capped.diffStats.files, 4, "the count is every file, capped or not");
	assert.equal(capped.diffStats.truncated, true);
	assert.match(capped.diff, /^… \d+ more files?, \d+ more bytes$/m);
	const kept = capped.diff.split(/^diff --git /m).slice(1);
	assert.ok(kept.length >= 1 && kept.length < 4, "some files kept, some not");
	for (const part of kept.slice(0, -0)) assert.ok(part.includes("@@ -1 +1 @@"), "each kept file is whole");
	assert.ok(capped.transcriptDiff.length < capped.diff.length, "the transcript copy is smaller");
	assert.equal(capped.transcriptStats.truncated, true);
	assert.ok(capped.full.includes("d.rb"), "the full diff has every file whatever the caps");
});

test("assembleDiff: one file bigger than the whole cap is kept, cut, with a note", () => {
	const big = `diff --git a/big.rb b/big.rb\n--- a/big.rb\n+++ b/big.rb\n@@ -1 +1 @@\n-old\n+${"y".repeat(400)}\n`;
	const capped = assembleDiff(big, false, 200, 100);
	assert.match(capped.diff, /^diff --git a\/big\.rb b\/big\.rb$/m);
	assert.match(capped.diff, /… \(file cut at \d+ bytes\)$/m);
	assert.equal(capped.diffStats.truncated, true);
});

test("assembleDiff: a binary patch is one line naming the file, and secrets are masked", () => {
	const raw = [
		"diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 12\nzcmZ?wbhEHb00000\n\nliteral 0\nHcmV?d00001\n",
		chunk("conf.rb", `token = "${SECRET_VALUE}"`),
	].join("");
	const out = assembleDiff(raw);
	assert.match(out.full, /^diff --git a\/img\.png b\/img\.png$/m);
	assert.match(out.full, /^Binary file img\.png changed$/m);
	assert.ok(!out.full.includes("GIT binary patch"), "no binary patch in the diff");
	assert.ok(out.full.includes("token = •••"));
	assert.ok(!out.full.includes(SECRET_VALUE));
});

// Token-shaped values, built at runtime so no literal in the source looks like one.
const TOKENS = {
	"ghp_": ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join(""),
	"ghs_": ["gh", "s_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join(""),
	"github_pat_": ["github", "_pat_", "11ABCDEFG0", "abcdefghij".repeat(5)].join(""),
	"AKIA": ["AK", "IA", "ABCDEFGHIJ234567"].join(""),
	"sk-": ["s", "k-", "proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8"].join(""),
	"xoxb-": ["xo", "xb-", "123456789012-abcdefABCDEF1234"].join(""),
	"glpat-": ["gl", "pat-", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7"].join(""),
	"AIza": ["AI", "za", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"].join(""),
	"npm_": ["np", "m_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
	"JWT": ["ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(""),
};
const KEY_HEAD = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
const KEY_TAIL = ["-----END", "OPENSSH PRIVATE KEY-----"].join(" ");
const KEY_BODY = ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB", "AAAAMwAAAAtzc2gtZWQyNTUxOQAAACDkVnWb0OvUr6JmcRQ4B9Bs"];

test("maskDiffSecrets: every token family, URL credentials and a private key block", () => {
	for (const [family, token] of Object.entries(TOKENS)) {
		const out = maskDiffSecrets(`+v = "${token}"\n`);
		assert.equal(out, '+v = "•••"\n', `${family} is masked`);
	}
	assert.equal(maskDiffSecrets("+u = https://me:hunter22@git.example.com/x\n"), "+u = https://•••@git.example.com/x\n");
	for (const plain of ["pk_users_email_index", "npm_config_cache_dir", "sk-learn", "github_pages_build", "AKIA-style"]) {
		assert.equal(maskDiffSecrets(`+${plain}\n`), `+${plain}\n`, `${plain} is an identifier, not a token`);
	}

	const block = [`+${KEY_HEAD}`, ...KEY_BODY.map((l) => `+${l}`), `+${KEY_TAIL}`].join("\n");
	const removed = block.replaceAll("\n+", "\n-").replace(/^\+/, "-");
	const raw = `diff --git a/k b/k\n--- a/k\n+++ b/k\n@@ -1,4 +1,4 @@\n${removed}\n${block}\n`;
	const out = maskDiffSecrets(raw);
	for (const l of KEY_BODY) assert.ok(!out.includes(l), "the key body is gone");
	assert.equal(out.split("\n").length, raw.split("\n").length, "the line count is kept, so hunk counts still add up");
	assert.ok(out.includes(`+${KEY_HEAD}\n+•••\n+•••\n+${KEY_TAIL}`), "added lines keep their marker");
	assert.ok(out.includes(`-${KEY_HEAD}\n-•••\n-•••\n-${KEY_TAIL}`), "removed lines too");
	assert.ok(!maskDiffSecrets(`+${KEY_HEAD}\n+${KEY_BODY[0]}\n`).includes(KEY_BODY[0]), "an unterminated block is masked to the end");
	const oneLine = `+cfg = "${KEY_HEAD}\\n${KEY_BODY[0]}\\n${KEY_TAIL}"\n`;
	assert.ok(!maskDiffSecrets(oneLine).includes(KEY_BODY[0]), "a block on one line (escaped newlines) too");
});

test("maskDiffSecrets masks letter-only sk- and pk- keys of 20 or more characters", () => {
	const letters = "abcdefghijklmnopqrstuvwxyz";
	const sk = ["sk", "-", letters.slice(0, 17)].join("");
	const pk = ["pk", "-", letters.slice(0, 20)].join("");
	const rk = ["rk", "-", letters.slice(0, 20)].join("");
	const underscored = ["sk", "_", letters.slice(0, 18)].join("");
	assert.equal(sk.length, 20);
	assert.equal(maskDiffSecrets(`+${sk}\n`), "+•••\n", "a letter-only sk- key is masked");
	assert.equal(maskDiffSecrets(`+${pk}\n`), "+•••\n", "a letter-only pk- key is masked");
	assert.equal(maskDiffSecrets(`+${rk}\n`), `+${rk}\n`, "a letter-only rk- string is not that key");
	assert.equal(maskDiffSecrets(`+${underscored}\n`), `+${underscored}\n`, "an underscore identifier stays");
	assert.equal(maskDiffSecrets("+sk-learn\n"), "+sk-learn\n");
});

test("oneLine masks a token in an omitted file's path", () => {
	const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
	const assembled = assembleDiff("", false, undefined, undefined, [`dir/${token}/big.rb`]);
	assert.match(assembled.full, /Large file/);
	assert.ok(!assembled.full.includes(token), "the path's token is masked");
	assert.match(assembled.full, /•••/);
});

test("captureChanges: bare tokens and a key block in a new file are masked", async () => {
	const repo = newRepo();
	const base = await captureBase(repo, false);
	writeFileSync(path.join(repo, "conf.rb"), `${Object.values(TOKENS).map((t, i) => `V${i} = "${t}"`).join("\n")}\n${KEY_HEAD}\n${KEY_BODY.join("\n")}\n${KEY_TAIL}\n`);
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-tokens") });
	for (const t of [...Object.values(TOKENS), ...KEY_BODY]) {
		assert.ok(!diff.full.includes(t), "never in the diff");
		assert.ok(!readFileSync(diff.diffPath, "utf8").includes(t), "nor in the file");
	}
	assert.match(diff.full, /^\+V0 = "•••"$/m);
});

test("isSensitivePath: credential files by name, ordinary code not", () => {
	const yes = [".env", ".env.local", "app/.env.production", ".envrc", "certs/server.pem", "tls/app.key", "id_rsa", ".ssh/id_ed25519", "id_ecdsa_sk", ".npmrc", ".netrc", "config/credentials.json", "credentials-prod.json", "store.p12", "cert.PFX", ".pgpass"];
	const no = ["env.rb", "lib/environment.rb", "keys.rb", "id_helpers.rb", "credentials.rb", "src/key.ts", "id_rsa.pub.md", "pem.txt"];
	for (const p of yes) assert.equal(isSensitivePath(p), true, p);
	for (const p of no) assert.equal(isSensitivePath(p), false, p);
	assert.equal(isSensitivePath(".env/"), true, "a trailing slash is the same file");
	assert.equal(isSensitivePath("config/.env/"), true);
	assert.equal(isSensitivePath("config\\.env"), true, "a backslash is the same file");
	assert.equal(isSensitivePath("config\\.env\\"), true);
	assert.equal(isSensitivePath("notes.md/"), false);
});

test("captureChanges: sensitive files are one line naming them, their content never shown", async () => {
	const repo = newRepo();
	const base = await captureBase(repo, false);
	const files = [".env", ".env.local", "id_rsa", "id_ed25519", ".npmrc", ".netrc", ".pgpass", "config/credentials.json", "certs/server.pem", "tls/app.key", "store.p12", "store.pfx"];
	for (const f of files) {
		mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
		writeFileSync(path.join(repo, f), `${SECRET_LINE}\nplain-${f}\n`);
	}
	writeFileSync(path.join(repo, "fizz.rb"), "a\nB\nc\n");
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-sensitive") });
	for (const f of files) assert.ok(diff.full.includes(`diff --git a/${f} b/${f}\nSensitive file ${f} changed\n`), f);
	assert.ok(!diff.full.includes("plain-"), "no sensitive file's content");
	assert.ok(!diff.full.includes(SECRET_VALUE));
	assert.match(diff.full, /^\+B$/m, "ordinary files still diff");
	assert.equal(diff.diffStats.files, files.length + 1);
	assert.equal(diff.diffStats.insertions, 1, "a sensitive file counts as a file, not its lines");
});

test("captureChanges forces rename detection, so renaming .env does not show its body as an add", async () => {
	const repo = newRepo();
	writeFileSync(path.join(repo, ".env"), `${SECRET_LINE}\n`);
	git(repo, "add", ".env");
	// Plumbing, not `commit`: a machine's config-based pre-commit hook (gitleaks) would refuse the
	// secret, and core.hooksPath doesn't turn those off.
	const tree = git(repo, "write-tree").trim();
	const commit = git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "env").trim();
	git(repo, "update-ref", "HEAD", commit);
	git(repo, "config", "diff.renames", "false");
	const base = await captureBase(repo, false);
	git(repo, "mv", "fizz.rb", "buzz.rb");
	git(repo, "mv", ".env", "foo.rb");
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-rename") });
	assert.match(diff.full, /rename from fizz\.rb/, "-M still reports an ordinary rename");
	assert.match(diff.full, /Sensitive file foo\.rb changed/, "the sensitive rename is one line");
	assert.ok(!diff.full.includes(SECRET_VALUE), "its body is not shown as an add");
	assert.ok(!readFileSync(diff.diffPath, "utf8").includes(SECRET_VALUE));
});

test("captureChanges uses -M1%, so a small edited rename of .env is not an add of its body", async () => {
	const repo = newRepo();
	writeFileSync(path.join(repo, ".env"), `${SECRET_LINE}\n${"A".repeat(80)}\n`);
	git(repo, "add", ".env");
	const tree = git(repo, "write-tree").trim();
	const commit = git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "env").trim();
	git(repo, "update-ref", "HEAD", commit);
	git(repo, "config", "diff.renames", "false");
	const base = await captureBase(repo, false);
	git(repo, "mv", ".env", "foo.rb");
	const marker = "B".repeat(40);
	writeFileSync(path.join(repo, "foo.rb"), `${SECRET_LINE.slice(0, 2)}${marker}${"B".repeat(160)}\n`);
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-rename-edit") });
	assert.match(diff.full, /Sensitive file foo\.rb changed/, "still one line, not an add");
	assert.ok(!diff.full.includes(marker), "the edited body is not shown as an add");
	assert.ok(!diff.full.includes(SECRET_VALUE));
	assert.ok(!readFileSync(diff.diffPath, "utf8").includes(marker));
});

const asRoot = process.getuid?.() === 0;

test("captureChanges: a snapshot that fails is no diff, not a partial one", { skip: asRoot && "root reads unreadable files" }, async () => {
	const repo = newRepo();
	const base = await captureBase(repo, false);
	writeFileSync(path.join(repo, "fizz.rb"), "a\nB\nc\n");
	const locked = path.join(repo, "locked.rb");
	writeFileSync(locked, "x\n");
	chmodSync(locked, 0o000); // git add can't read it, so the untracked add fails
	try {
		assert.equal(await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-fail") }), undefined, "no diff rather than tracked-only");
		assert.equal(await captureBase(repo, false), undefined, "a base that can't be taken is none");
	} finally {
		chmodSync(locked, 0o644);
	}
});

test("snapshots reuse the real index's stat cache: unchanged tracked files are not read again", async () => {
	const repo = newRepo();
	const old = new Date(Date.now() - 100_000);
	writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=count\n");
	for (let i = 0; i < 20; i++) {
		writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`);
		utimesSync(path.join(repo, `f${i}.txt`), old, old);
	}
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "many");
	// A clean filter runs once per file git hashes: count them.
	const reads = path.join(scratch, "filter-reads.log");
	git(repo, "config", "filter.count.clean", `sh -c 'echo x >> ${reads}; cat'`);
	const base = await captureBase(repo, false);
	writeFileSync(path.join(repo, "f3.txt"), "three\n");
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-stat") });
	assert.match(diff.full, /^\+three$/m);
	const n = existsSync(reads) ? readFileSync(reads, "utf8").split("\n").filter(Boolean).length : 0;
	assert.ok(n <= 2, `only the edited file is read (${n} reads for 20 files over two snapshots)`);
});

test("captureChanges: a same-size edit whose stat matches the index is still seen (the seeded index stays racy-safe)", async () => {
	const repo = newRepo();
	git(repo, "config", "core.trustctime", "false");
	const file = path.join(repo, "fizz.rb");
	const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 100_000);
	writeFileSync(file, "x\ny\nz\n");
	utimesSync(file, when, when);
	git(repo, "add", "fizz.rb");
	git(repo, "commit", "-qm", "dated");
	// The index written in the same second as the file: git must re-read the file to trust it.
	const index = path.join(repo, ".git", "index");
	utimesSync(index, when, when);
	const base = await captureBase(repo, false);
	writeFileSync(file, "a\nB\nc\n"); // same size as before
	utimesSync(file, when, when); // and the same mtime, as an edit in that second would have
	assert.match(git(repo, "diff", "--stat"), /fizz\.rb/, "git itself sees it");
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-racy") });
	assert.match(diff?.full ?? "", /^\+B$/m, "so does the snapshot");
});

test("captureChanges: an in-place run started in a subdir counts the whole repo", async () => {
	const repo = newRepo();
	mkdirSync(path.join(repo, "sub"));
	writeFileSync(path.join(repo, "sub", "inner.rb"), "in\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "sub");
	const sub = path.join(repo, "sub");
	const base = await captureBase(sub, false);
	writeFileSync(path.join(repo, "fizz.rb"), "a\nOUTSIDE\nc\n");
	writeFileSync(path.join(repo, "top-new.rb"), "top\n");
	writeFileSync(path.join(sub, "inner.rb"), "INSIDE\n");
	const diff = await captureChanges(sub, base.base, { stateDir: path.join(scratch, "state-sub") });
	assert.match(diff.full, /^diff --git a\/fizz\.rb b\/fizz\.rb$/m, "a tracked edit outside the subdir");
	assert.match(diff.full, /^\+OUTSIDE$/m);
	assert.match(diff.full, /^\+top$/m, "an untracked file outside it");
	assert.match(diff.full, /^diff --git a\/sub\/inner\.rb b\/sub\/inner\.rb$/m, "paths are from the repo top");
	assert.equal(diff.diffStats.files, 3);
});

test("captureChanges: large files are one line, and a big untracked file is never hashed into .git", async () => {
	const repo = newRepo();
	writeFileSync(path.join(repo, "data.txt"), "small\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "data");
	const before = path.join(repo, "before-big.log");
	writeFileSync(before, Buffer.alloc(MAX_UNTRACKED_BYTES + 1, "p"));
	const base = await captureBase(repo, false);
	assert.deepEqual(base.large.map((f) => f.path), ["before-big.log"], "the base remembers what it left out");

	const big = path.join(repo, "big.bin");
	writeFileSync(big, Buffer.alloc(MAX_UNTRACKED_BYTES + 1, "z"));
	writeFileSync(path.join(repo, "data.txt"), "line\n".repeat(Math.ceil((MAX_FILE_DIFF_BYTES + 10) / 5)));
	writeFileSync(path.join(repo, "fizz.rb"), "a\nB\nc\n");
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-large"), baseLarge: base.large });
	assert.ok(diff.full.includes("diff --git a/big.bin b/big.bin\nLarge file big.bin changed\n"), "a new big untracked file");
	assert.ok(diff.full.includes("diff --git a/data.txt b/data.txt\nLarge file data.txt changed\n"), "a tracked file past the per-file cap");
	assert.ok(!diff.full.includes("before-big.log"), "a big file that was there, unchanged, is not the run's");
	assert.match(diff.full, /^\+B$/m);
	assert.ok(Buffer.byteLength(diff.full) < 4096, "no body of either");
	const sha = git(repo, "hash-object", big).trim();
	assert.throws(() => git(repo, "cat-file", "-e", sha), "the big untracked file's blob was not written");
});

test("captureChanges on stop: short timeouts, tracked files only", async () => {
	const repo = newRepo();
	writeFileSync(path.join(repo, "pre.txt"), "was here\n");
	writeFileSync(path.join(repo, "fizz.rb"), "a\nDIRTY\nc\n"); // tracked dirt in the base, not in the real index
	const base = await captureBase(repo, false);
	writeFileSync(path.join(repo, "fizz.rb"), "a\nSTOP\nc\n");
	writeFileSync(path.join(repo, "made-by-run.rb"), "new\n");
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-stop"), stopped: true });
	assert.match(diff.full, /^-DIRTY$/m, "measured from the base, dirt and all");
	assert.match(diff.full, /^\+STOP$/m);
	assert.ok(!diff.full.includes("made-by-run.rb"), "no untracked walk on stop");
	assert.ok(!diff.full.includes("pre.txt"), "and a file the base had is not reported deleted");

	// A git that hangs on add: the stop path gives up after its short timeout, not 30 s.
	const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const slow = path.join(scratch, "slow-git");
	mkdirSync(slow, { recursive: true });
	writeFileSync(path.join(slow, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = add ] && exec sleep 60; done\nexec ${JSON.stringify(realGit)} "$@"\n`);
	chmodSync(path.join(slow, "git"), 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${slow}${path.delimiter}${savedPath}`;
	try {
		const t0 = Date.now();
		const hung = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-stop"), stopped: true });
		const took = Date.now() - t0;
		assert.equal(hung, undefined, "a timed-out snapshot is no diff");
		assert.ok(took >= STOP_GIT_TIMEOUT_MS - 500 && took < STOP_GIT_TIMEOUT_MS + 5_000, `stopped within the stop timeout (${took} ms)`);
	} finally {
		process.env.PATH = savedPath;
	}
});

test("captureChanges: names with spaces, \" b/\" and quotes are read whole", async () => {
	const repo = newRepo();
	const base = await captureBase(repo, false);
	const bin = Buffer.from([0x00, 0x01, 0x02, 0x00]);
	mkdirSync(path.join(repo, "x b"));
	writeFileSync(path.join(repo, "x b", "y.bin"), bin);
	writeFileSync(path.join(repo, 'we"ird.bin'), bin);
	writeFileSync(path.join(repo, "x b", "z z.rb"), "spaced\n");
	const diff = await captureChanges(repo, base.base, { stateDir: path.join(scratch, "state-names") });
	assert.ok(diff.full.includes("Binary file x b/y.bin changed\n"), diff.full);
	assert.ok(diff.full.includes('Binary file we"ird.bin changed\n'), "a quoted name, unquoted");
	assert.match(diff.full, /^\+spaced$/m);
	assert.equal(diff.diffStats.files, 3);
});

test("captureChanges: two runs with the same id get their own files", async () => {
	const repo = newRepo();
	const base = await captureBase(repo, false);
	writeFileSync(path.join(repo, "fizz.rb"), "a\nB\nc\n");
	const dir = path.join(scratch, "state-same-id");
	const one = await captureChanges(repo, base.base, { stateDir: dir, runId: "bg-123" });
	const two = await captureChanges(repo, base.base, { stateDir: dir, runId: "bg-123" });
	assert.ok(one.diffPath && two.diffPath, `both wrote a file: ${one.diffPath} ${two.diffPath}`);
	assert.notEqual(one.diffPath, two.diffPath);
	assert.ok(existsSync(one.diffPath) && existsSync(two.diffPath), `neither overwrote the other: ${readdirSync(dir)}`);
});

test("pruneStateDir keeps diffs newer than 14 days, at most 200; writing a diff prunes", async () => {
	const dir = path.join(scratch, "state-prune");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const now = Date.now();
	const at = (name, ageMs) => {
		const f = path.join(dir, name);
		writeFileSync(f, "x");
		utimesSync(f, (now - ageMs) / 1000, (now - ageMs) / 1000);
		return f;
	};
	const old = [at("old-1.diff", PRUNE_AGE_MS + 60_000), at("old-2.diff", 30 * 86_400_000), at("old.diff.1.tmp", PRUNE_AGE_MS + 60_000)];
	const recent = Array.from({ length: PRUNE_KEEP + 5 }, (_, i) => at(`r-${i}.diff`, (i + 1) * 1000));
	const other = at("notes.txt", 40 * 86_400_000);
	pruneStateDir(dir, now);
	for (const f of old) assert.equal(existsSync(f), false, `${path.basename(f)} is past 14 days`);
	assert.equal(recent.filter((f) => existsSync(f)).length, PRUNE_KEEP);
	assert.ok(recent.slice(0, PRUNE_KEEP).every((f) => existsSync(f)), "the newest are the ones kept");
	assert.ok(existsSync(other), "only diffs and temp files are ours to drop");

	const stale = at("stale.diff", PRUNE_AGE_MS + 60_000);
	const repo = newRepo();
	const base = await captureBase(repo, false);
	writeFileSync(path.join(repo, "fizz.rb"), "a\nB\nc\n");
	const diff = await captureChanges(repo, base.base, { stateDir: dir, runId: "prune" });
	assert.ok(existsSync(diff.diffPath), "the new diff is kept");
	assert.equal(existsSync(stale), false, "writing pruned the stale one");
});

test("editOf keeps a patch or old/new text when the event has it, and nothing when it does not", () => {
	assert.equal(editOf({ args: { path: "/ws/fizz.rb" } }), undefined, "a started event only names a path");
	assert.equal(editOf({ args: { command: "npm test" }, result: { success: { exitCode: 0 } } }), undefined);
	const done = editOf({
		args: { path: "/ws/fizz.rb", old_string: "puts 1\n", new_string: `${SECRET_LINE}\n` },
		result: { success: { diffString: `+${SECRET_LINE}\n` } },
	});
	assert.match(done.diff, /api_key = •••/);
	assert.equal(done.old, "puts 1\n");
	assert.match(done.new, /api_key = •••/);
	assert.ok(!JSON.stringify(done).includes(SECRET_VALUE));
});

test("editOf never keeps whole-file content, and keeps nothing for a sensitive path", () => {
	const WHOLE = "WHOLE-FILE-BODY";
	const full = { beforeFullFileContent: WHOLE, afterFullFileContent: WHOLE, before_full_file_content: WHOLE, after_full_file_content: WHOLE };
	const edit = editOf({ args: { path: "/ws/fizz.rb", old_string: "a\n", new_string: "b\n" }, result: { success: { diffString: "-a\n+b\n", ...full } } });
	assert.deepEqual(edit, { diff: "-a\n+b\n", old: "a\n", new: "b\n" }, "the patch and old/new, not the files around them");
	assert.equal(editOf({ args: { path: "/ws/fizz.rb" }, result: { success: full } }), undefined, "an edit with only whole files keeps nothing");
	const write = { args: { path: "/ws/new.rb", fileText: WHOLE, file_text: WHOLE, streamContent: WHOLE }, result: { success: { fileContentAfterWrite: WHOLE, file_content_after_write: WHOLE } } };
	assert.equal(editOf(write), undefined, "a write's file text is whole-file content");
	assert.equal(editOf({ args: { path: "/ws/old.rb" }, result: { success: { prevContent: WHOLE, prev_content: WHOLE } } }), undefined, "so is a delete's");

	for (const p of ["/ws/.env", "/ws/.env.local", "/ws/config/credentials.json", "/home/me/.ssh/id_ed25519", "/ws/.npmrc", "/ws/tls/server.key"]) {
		const step = editOf({ args: { path: p, old_string: "A=1\n", new_string: `${SECRET_LINE}\n` }, result: { success: { diffString: `+${SECRET_LINE}\n` } } });
		assert.equal(step, undefined, `nothing kept for ${p}`);
	}
	const viaResult = editOf({ args: {}, result: { success: { path: "/ws/.netrc", diffString: "+machine x\n" } } });
	assert.equal(viaResult, undefined, "the result's path counts too");

	const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
	const masked = editOf({ args: { path: "/ws/a.rb", new_string: `T = "${token}"\n` }, result: { success: { diffString: `+T = ${token}\n` } } });
	assert.ok(!JSON.stringify(masked).includes(token), "bare tokens are masked in edit text");
	assert.equal(masked.new, 'T = "•••"\n');
	assert.equal(editOf({ args: { path: "/ws/a.rb", new_string: "x".repeat(20_000) } }).new.length, 8_000, "capped");
});

test("editOf keeps nothing but the path when any path key or patch header is sensitive", () => {
	const body = `+${SECRET_LINE}\n`;
	const keys = ["path", "filePath", "file_path", "targetFile", "target_file", "old_path", "new_path", "uri", "fileUri", "file_uri"];
	for (const key of keys) {
		assert.equal(editOf({ args: { [key]: "secrets/.env", old_string: "a\n", new_string: body }, result: { success: { diffString: body } } }), undefined, `${key} on args`);
		assert.equal(editOf({ args: { old_string: "a\n", new_string: body }, result: { success: { [key]: "secrets/.env", diffString: body } } }), undefined, `${key} on success`);
	}
	const renamed = editOf({
		args: { path: "foo.rb", old_string: "a\n", new_string: body },
		result: { success: { diffString: `diff --git a/.env b/foo.rb\nrename from .env\nrename to foo.rb\n${body}` } },
	});
	assert.equal(renamed, undefined, "rename from .env drops the body");
	assert.equal(editOf({ args: { path: "foo.rb" }, result: { success: { diffString: "diff --git a/.npmrc b/foo.rb\ncopy from .npmrc\ncopy to foo.rb\n" } } }), undefined, "copy from a sensitive file");
	const headers = ["*** Update File: secrets/.env", "*** Add File: .env.local", "*** Delete File: .npmrc", "*** Move to: id_rsa"];
	for (const header of headers) {
		assert.equal(editOf({ args: { path: "foo.rb", patch: `${header}\n${body}` } }), undefined, header);
	}
	assert.equal(editOf({ args: { path: "config/.env/", new_string: body } }), undefined, "a trailing slash still counts");
	assert.equal(editOf({ args: { path: "config\\.env", new_string: body } }), undefined, "a backslash still counts");
	assert.equal(editOf({ args: { path: "foo.rb", patch: `--- .env\n+++ .env\n${body}` } }), undefined, "a noprefix .env header");
	assert.equal(editOf({ args: { fileUri: "file:///tmp/secrets%2F.env", new_string: body } }), undefined, "an encoded slash in a file URI");
	assert.equal(editOf({ args: { uri: "file:///tmp/%2Eenv", new_string: body } }), undefined, "a decoded file URI");
	const kept = editOf({ args: { path: "foo.rb" }, result: { success: { diffString: "diff --git a/bar.rb b/foo.rb\nrename from bar.rb\nrename to foo.rb\n+ok\n" } } });
	assert.match(kept.diff, /rename from bar.rb/, "an ordinary rename still keeps its patch");
	const shown = describeTool({ editToolCall: { args: { path: "/ws/secrets/.env", new_string: body, patch: body } } }, "/ws");
	assert.equal(shown.summary, "edit secrets/.env", "the path stays on the step");
	assert.equal(shown.edit, undefined);
	assert.ok(!JSON.stringify(shown).includes(SECRET_VALUE), "and nothing else does");
});

test("describeTool masks secrets in the step summary before it is shortened", () => {
	const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"].join("");
	const head = "x".repeat(60);
	const step = describeTool({ shellToolCall: { args: { command: `${head} ${token}` } } }, "/ws");
	assert.ok(!step.summary.includes(token.slice(0, 8)), "a token cut by the summary cap is still masked");
	assert.match(step.summary, /•••/);
	const viaPath = describeTool({ editToolCall: { args: { path: `/tmp/${token}.rb` } } }, "/tmp");
	assert.ok(!viaPath.summary.includes(token));
});

test("pathsInText counts noprefix ---/+++ headers and ignores /dev/null", () => {
	const paths = pathsInText(["--- .env", "+++ .env", "--- a/.npmrc", "+++ b/foo.rb", "--- /dev/null", "+++ /dev/null", "diff --git .env .env", "--- .env\t2020-01-01 00:00:00.000000000 +0000"].join("\n"));
	assert.ok(paths.includes(".env"));
	assert.ok(paths.includes(".npmrc"));
	assert.ok(paths.includes("foo.rb"));
	assert.ok(!paths.includes("/dev/null"));
	const reduced = reduceDiffText(`--- .env\n+++ .env\n@@ -1 +1 @@\n+${SECRET_LINE}\n`);
	assert.match(reduced, /Sensitive file/);
	assert.ok(!reduced.includes(SECRET_VALUE));
	const inside = reduceDiffText(`diff --git a/foo.rb b/foo.rb\n--- .env\n+++ .env\n+${SECRET_LINE}\n`);
	assert.match(inside, /Sensitive file/);
	assert.ok(!inside.includes(SECRET_VALUE));
});

test("commandRunsCursorRunner requires argv[1] to realpath to this package's runner", () => {
	assert.equal(commandRunsCursorRunner(runnerCommand()), true);
	const tricky = path.join(scratch, "it' s", "spec.json");
	assert.deepEqual(shellArgv(`${qArg("node")} ${qArg(cursorRunnerFile)} ${qArg(tricky)}`), ["node", cursorRunnerFile, tricky]);
	assert.equal(commandRunsCursorRunner(`${qArg(process.execPath)} ${qArg(cursorRunnerFile)} ${qArg(tricky)}`), true);
	assert.equal(commandRunsCursorRunner(`${qArg(process.execPath)} ${qArg(cursorRunnerFile)} ${qArg("/tmp/spec")}; echo hi`), false);
	const lookalike = path.join(scratch, "not-cursor-agent", "runner.ts");
	mkdirSync(path.dirname(lookalike), { recursive: true });
	writeFileSync(lookalike, "");
	assert.equal(commandRunsCursorRunner(`${qArg("node")} ${qArg(lookalike)} ${qArg("spec")}`), false, "a path that merely ends in runner.ts is not this package");
	assert.equal(commandRunsCursorRunner(`${qArg("bash")} ${qArg(cursorRunnerFile)} ${qArg("spec")}`), false);
});

test("a cursor child's transcript ends with a cursor_diff entry; the edit's patch stays on the call", () => {
	const c = trackChild({ kind: "cursor", agent: "cursor", task: "fix fizz", sessionId: "shape-1" });
	c.cursorState({
		tools: [{ summary: "edit fizz.rb", ok: true, edit: { diff: `+${SECRET_LINE}\n`, old: "a\n", new: "b\n" } }],
	});
	c.finish("done", {
		lastText: "Done.",
		diff: {
			diff: `diff --git a/fizz.rb b/fizz.rb\n+${SECRET_LINE}\n+T = "${TOKENS.ghp_}"\n`,
			diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false },
			diffPath: path.join(scratch, "shape.diff"),
		},
	});
	const entries = transcript("shape-1", c.id);
	assert.deepEqual(
		entries.filter((e) => e.type === "message").map((e) => e.message.role),
		["user", "assistant", "toolResult", "assistant"],
		"a reader that only knows messages still walks the conversation",
	);
	const call = entries[1].message.content[0];
	assert.equal(call.name, "edit");
	assert.equal(call.arguments.path, "fizz.rb");
	assert.equal(call.arguments.old_string, "a\n");
	assert.equal(call.arguments.new_string, "b\n");
	assert.match(call.arguments.diff, /api_key = •••/);
	assert.ok(!call.arguments.diff.includes(SECRET_VALUE));
	const last = entries.at(-1);
	assert.equal(last, diffEntry(entries), "the diff is the last entry, after the reply");
	assert.equal(last.type, "custom");
	assert.equal(last.customType, "cursor_diff");
	assert.equal(last.id, String(last.seq));
	assert.ok(!Number.isNaN(Date.parse(last.timestamp)));
	assert.match(last.data.diff, /api_key = •••/);
	assert.ok(!JSON.stringify(last).includes(SECRET_VALUE));
	assert.ok(!JSON.stringify(last).includes(TOKENS.ghp_), "the entry masks bare tokens too");
	assert.equal(last.data.diffPath, undefined, "a diffPath outside the state dir is dropped");
	assert.deepEqual(last.data.diffStats, { files: 1, insertions: 1, deletions: 0, truncated: false });

	const empty = trackChild({ kind: "cursor", agent: "cursor", task: "look", sessionId: "shape-2" });
	empty.finish("done", { lastText: "Nothing." });
	assert.equal(diffEntry(transcript("shape-2", empty.id)), undefined, "no changes, no diff entry");
});

test("a background run's sidecar edits attach by step number: a trimmed log and an extra ✓ line can't misplace them", () => {
	const handlers = new Map();
	bindChildren({ on: (channel, fn) => (handlers.set(channel, fn), () => handlers.delete(channel)), emit: () => {} });
	const log = path.join(scratch, "steps.log");
	const lines = ["cursor composer-2 · /ws", "session s-steps · Composer Two"];
	// Enough steps that the oldest calls are trimmed from the transcript (LOG_ENTRIES).
	const STEPS = 450;
	for (let i = 0; i < STEPS; i++) {
		if (i === 420) lines.push(`✓ #${i + 1} edit f${i}.rb`); // a ✓ with no → before it
		else lines.push(`→ #${i + 1} edit f${i}.rb`, `✓ #${i + 1} edit f${i}.rb`);
		if (i === 430) lines.push(`✓ #${i + 1} edit f${i}.rb`); // the same step reported twice
	}
	lines.push("", "── cursor result · done · composer-2 · 1m · cost not found ──", "Done.", "", "Model: composer-2", "Exit code: 0", "");
	writeFileSync(log, lines.join("\n"));
	const patch = (i) => `@@ -1 +1 @@\n-old ${i}\n+new ${i}\n`;
	const edits = [5, 420, 430, 440, 449, 999].map((i) => ({ i, diff: patch(i) }));
	writeJobDetails(log, {
		diff: "diff --git a/f440.rb b/f440.rb\n+new 440\n",
		diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false },
		transcriptDiff: "diff --git a/f440.rb b/f440.rb\n+new 440\n",
		transcriptStats: { files: 1, insertions: 1, deletions: 0, truncated: false },
		edits,
	});
	const c = trackChild({ kind: "cursor", agent: "cursor", task: "many edits", sessionId: "steps-1", bg: { id: "st1234", logPath: log } });
	pollOnce();
	handlers.get("bg:jobs")([{ id: "st1234", endedAt: Date.now(), exitCode: 0, signal: null, killedByUser: false, command: runnerCommand() }]);

	const entries = transcript("steps-1", c.id);
	const calls = entries.flatMap((e) => (e.type === "message" ? e.message.content.filter((b) => b.type === "toolCall") : []));
	assert.ok(calls.length < STEPS, "the oldest steps were trimmed");
	assert.equal(new Set(calls.map((b) => b.id)).size, calls.length, "a repeated ✓ line is not a second call");
	for (const b of calls) {
		const i = Number(b.arguments.path.replace(/^f(\d+)\.rb$/, "$1"));
		assert.equal(b.id, `bg-step-${i}`, "each call's id is its step");
		if (b.arguments.diff !== undefined) assert.equal(b.arguments.diff, patch(i), `step ${i} carries its own patch, not another's`);
	}
	const patched = calls.filter((b) => b.arguments.diff !== undefined).map((b) => b.arguments.path);
	assert.deepEqual(patched, ["f420.rb", "f430.rb", "f440.rb", "f449.rb"], "a trimmed step (5) or an unknown one (999) gets nothing");
	assert.equal(diffEntry(entries)?.data.diffStats.files, 1);
});

test("a cursor bg job whose command is not the runner does not attach the sidecar", () => {
	const handlers = new Map();
	bindChildren({ on: (channel, fn) => (handlers.set(channel, fn), () => handlers.delete(channel)), emit: () => {} });
	const log = path.join(scratch, "not-runner.log");
	writeFileSync(log, "→ #1 edit fizz.rb\n✓ #1 edit fizz.rb\n");
	const marker = "NOT-RUNNER-SIDECAR";
	writeJobDetails(log, {
		diff: `diff --git a/fizz.rb b/fizz.rb\n+${marker}\n`,
		diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false },
		edits: [{ i: 0, diff: `+${marker}\n` }],
	});
	const c = trackChild({ kind: "cursor", agent: "cursor", task: "nope", sessionId: "not-runner", bg: { id: "nr1234", logPath: log } });
	pollOnce();
	handlers.get("bg:jobs")([{ id: "nr1234", endedAt: Date.now(), exitCode: 0, command: "printf hi" }]);
	const entries = transcript("not-runner", c.id);
	assert.ok(!JSON.stringify(entries).includes(marker), "a plain command does not get the sidecar");
	assert.equal(diffEntry(entries), undefined);
});

test("writeJobDetails drops edit patches before the diff, so a huge sidecar stays readable", () => {
	const log = path.join(scratch, "huge-job.log");
	const edits = Array.from({ length: 80 }, (_, i) => ({ i, diff: "x".repeat(20_000) }));
	writeJobDetails(log, {
		diff: "diff --git a/a.rb b/a.rb\n+a\n",
		diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false },
		edits,
	});
	const side = readJobDetails(log);
	assert.ok(side, "the reader accepts the file");
	assert.match(side.diff, /^\+a$/m, "the diff was kept");
	assert.ok(!side.edits || side.edits.length < edits.length, "patches were what got dropped");
	assert.ok(statSync(detailsPath(log)).size <= 1024 * 1024);
	assert.equal(modeOf(detailsPath(log)), 0o600);
});

test("temp writes do not follow a planted symlink", () => {
	const stats = { files: 1, insertions: 1, deletions: 0, truncated: false };
	const cases = [
		["lib", (file) => writeExclusive(file, "safe body\n")],
		["diff", (file) => writeDiffFile(path.dirname(file), "run", "safe body\n")],
		["sidecar", (file) => writeJobDetails(file.slice(0, -".details.json".length), { diff: "diff --git a/f b/f\n+ok\n", diffStats: stats })],
	];
	for (const [name, write] of cases) {
		const dir = path.join(scratch, `excl-${name}`);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = name === "sidecar" ? path.join(dir, "job.log.details.json") : path.join(dir, "run.diff");
		const sink = path.join(dir, "sink");
		writeFileSync(sink, "untouched\n");
		const planted = `${file}.${process.pid}.tmp`;
		symlinkSync(sink, planted);
		write(file);
		assert.ok(lstatSync(planted).isSymbolicLink(), `${name} unlinked the planted temp name`);
		assert.equal(readFileSync(sink, "utf8"), "untouched\n", `${name} followed the temp symlink`);
		assert.equal(readFileSync(file, "utf8").includes("untouched"), false, `${name} wrote the sink's old text`);
		assert.equal(modeOf(file), 0o600, name);
	}
});

test("readJobDetails opens without following a symlink, re-reduces, and drops a bad diffPath", () => {
	const log = path.join(scratch, "trust.log");
	const side = detailsPath(log);
	const stats = { files: 1, insertions: 1, deletions: 0, truncated: false };
	const outside = path.join(scratch, "outside.diff");
	writeFileSync(outside, "nope\n");
	chmodSync(outside, 0o600);
	const state = process.env.PI_CURSOR_STATE_DIR;
	mkdirSync(state, { recursive: true, mode: 0o700 });
	chmodSync(state, 0o700);
	const loose = path.join(state, "loose.diff");
	writeFileSync(loose, "loose\n");
	chmodSync(loose, 0o644);
	const raw = {
		diff: `diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n+${SECRET_LINE}\n`,
		diffStats: stats,
		diffPath: outside,
		edits: [{ i: 0, diff: `diff --git a/.env b/foo.rb\nrename from .env\nrename to foo.rb\n+${SECRET_LINE}\n`, old: SECRET_LINE, new: "x\n" }],
	};
	writeFileSync(side, JSON.stringify(raw));
	chmodSync(side, 0o600);
	const got = readJobDetails(log);
	assert.ok(got, "a regular sidecar is read");
	assert.match(got.diff, /Sensitive file/);
	assert.ok(!JSON.stringify(got).includes(SECRET_VALUE), "the body is reduced again");
	assert.equal(got.diffPath, undefined, "a path outside the state dir is dropped");
	assert.equal(acceptDiffPath(outside), undefined);
	assert.match(got.edits[0].diff, /Sensitive file/);
	assert.equal(got.edits[0].old, undefined, "old text of a sensitive edit is not kept");
	assert.equal(got.edits[0].new, undefined, "new text of a sensitive edit is not kept");

	const good = path.join(state, "good.diff");
	writeFileSync(good, "ok\n");
	chmodSync(good, 0o600);
	writeFileSync(side, JSON.stringify({ diff: "diff --git a/fizz.rb b/fizz.rb\n+ok\n", diffStats: stats, diffPath: good, edits: [{ i: 1, diff: "+ok\n", old: SECRET_LINE, new: "kept-new\n" }, { i: 2, old: SECRET_LINE, new: "x" }] }));
	chmodSync(side, 0o600);
	const kept = readJobDetails(log);
	assert.equal(kept.diffPath, realpathSync(good), "a regular 0600 file inside the state dir is kept, as its real path");
	assert.equal(kept.edits.length, 1, "an edit with only old/new is dropped");
	assert.equal(kept.edits[0].diff, "+ok\n");
	assert.equal(kept.edits[0].old, undefined, "old/new bodies are dropped even when the diff is kept");
	assert.equal(kept.edits[0].new, undefined);
	assert.ok(!JSON.stringify(kept).includes(SECRET_VALUE));
	assert.equal(acceptDiffPath(good), realpathSync(good));
	assert.notEqual(`${state}/./good.diff`, realpathSync(good));
	assert.equal(acceptDiffPath(`${state}/./good.diff`), realpathSync(good), "the returned path is the real path, not the path we were handed");

	const planted = path.join(state, "planted.diff");
	writeFileSync(planted, `diff --git a/.env b/.env\n--- .env\n+++ .env\n+${SECRET_LINE}\n`);
	chmodSync(planted, 0o600);
	writeFileSync(side, JSON.stringify({ diff: "diff --git a/f b/f\n+ok\n", diffStats: stats, diffPath: planted }));
	chmodSync(side, 0o600);
	const sealed = readJobDetails(log);
	assert.equal(sealed.diffPath, realpathSync(planted));
	assert.ok(!readFileSync(sealed.diffPath, "utf8").includes(SECRET_VALUE), "the file's bytes are reduced before the path is kept");
	assert.match(readFileSync(sealed.diffPath, "utf8"), /Sensitive file/);

	const linked = path.join(state, "hard.diff");
	writeFileSync(linked, "ok\n");
	chmodSync(linked, 0o600);
	const extra = path.join(state, "hard-extra.diff");
	linkSync(linked, extra);
	assert.equal(acceptDiffPath(linked), undefined, "a second link is not kept");
	assert.equal(acceptDiffPath(extra), undefined);

	const outsideFile = path.join(scratch, "id_rsa.diff");
	writeFileSync(outsideFile, "secret-key\n", { mode: 0o600 });
	const outLink = path.join(state, "out.link");
	symlinkSync(outsideFile, outLink);
	assert.equal(acceptDiffPath(outLink), undefined, "a symlink to a file outside the dir is not kept");

	writeFileSync(side, JSON.stringify({ diff: "diff --git a/f b/f\n+ok\n", diffStats: stats, diffPath: loose }));
	chmodSync(side, 0o600);
	assert.equal(readJobDetails(log).diffPath, undefined, "a loose mode is dropped");
	assert.equal(acceptDiffPath(loose), undefined);

	const sink = path.join(scratch, "side-read-sink");
	writeFileSync(sink, JSON.stringify({ diff: `+${SECRET_LINE}\n`, diffStats: stats }));
	rmSync(side);
	symlinkSync(sink, side);
	assert.equal(readJobDetails(log), undefined, "a symlink sidecar is not followed");
});

test("acceptDiffPath rejects a symlinked state dir and a loose directory mode", () => {
	const real = path.join(scratch, "state-real");
	mkdirSync(real, { mode: 0o700 });
	chmodSync(real, 0o700);
	const file = path.join(real, "x.diff");
	writeFileSync(file, "ok\n");
	chmodSync(file, 0o600);
	const linkDir = path.join(scratch, "state-link");
	symlinkSync(real, linkDir);
	const env = { ...process.env, PI_CURSOR_STATE_DIR: linkDir };
	assert.equal(acceptDiffPath(file, env), undefined, "the state dir's final component must not be a symlink");
	const looseEnv = { ...process.env, PI_CURSOR_STATE_DIR: real };
	chmodSync(real, 0o755);
	assert.equal(acceptDiffPath(file, looseEnv), undefined, "the state dir must be 0700");
	chmodSync(real, 0o700);
	assert.equal(acceptDiffPath(file, looseEnv), realpathSync(file));
});

test("addCursorDiff re-reduces a sensitive body and drops a diffPath outside the state dir", () => {
	const info = {
		diff: `diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n+${SECRET_LINE}\n`,
		diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false },
		diffPath: path.join(scratch, "not-in-state.diff"),
	};
	const trusted = trustCursorDiff(info);
	assert.match(trusted.diff, /Sensitive file/);
	assert.equal(trusted.diffPath, undefined);
	const c = trackChild({ kind: "cursor", agent: "cursor", task: "leak", sessionId: "trust-diff" });
	c.finish("done", { lastText: "Done.", diff: info });
	const last = diffEntry(transcript("trust-diff", c.id));
	assert.match(last.data.diff, /Sensitive file/);
	assert.ok(!JSON.stringify(last).includes(SECRET_VALUE));
	assert.equal(last.data.diffPath, undefined);
});

// ---- the tool and the bg completion

const fake = path.join(scratch, "fake-cursor-agent");
writeFileSync(
	fake,
	`#!${process.execPath}
const fs = require("node:fs");
const nodePath = require("node:path");
const e = process.env;
if (e.FAKE_CURSOR_ENV_OUT) {
  const bg = { PI_BG_LOG: e.PI_BG_LOG ?? null };
  for (const k of Object.keys(e)) if (k.startsWith("PI_BG_")) bg[k] = e[k];
  fs.writeFileSync(e.FAKE_CURSOR_ENV_OUT, JSON.stringify(bg));
}
const out = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");
for (const edit of JSON.parse(e.FAKE_CURSOR_EDIT ?? "[]")) {
  const file = nodePath.join(process.cwd(), edit.file);
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, edit.text);
}
const ws = e.FAKE_CURSOR_WS || process.cwd();
const edited = nodePath.join(ws, "fizz.rb");
out({ type: "system", subtype: "init", ...(e.FAKE_CURSOR_SESSION ? { session_id: e.FAKE_CURSOR_SESSION } : {}), model: "Composer Two", cwd: ws });
out({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { editToolCall: { args: { path: edited } } } });
out({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { editToolCall: { args: { path: edited }, result: { success: { path: edited, diffString: "@@ -1 +1 @@\\n-puts 1\\n+puts 2\\n" } } } } });
out({ type: "assistant", message: { content: [{ text: e.FAKE_CURSOR_ANSWER ?? "Fixed the bug." }] } });
out({ type: "result", subtype: "success", duration_ms: 1000, usage: { inputTokens: 10, outputTokens: 2 } });
if (e.FAKE_CURSOR_HOLD) setInterval(() => {}, 1 << 30);
else process.exitCode = Number(e.FAKE_CURSOR_EXIT ?? 0);
`,
);
chmodSync(fake, 0o755);
process.env.PI_CURSOR_AGENT_BIN = fake;

const fakeEnv = (vars) => {
	for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_CURSOR_")) delete process.env[k];
	Object.assign(process.env, vars);
};

const { default: cursorAgent } = await import("../extensions/opt-in/cursor-agent/index.ts");

/** A repo with a commit, and a worktree of it with one changed file (what Cursor leaves). */
const repo = path.join(scratch, "app");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "fizz.rb"), "puts 1\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");
const wt = path.join(scratch, "app-wt");
git(repo, "worktree", "add", "-q", "-b", "pi-diff-branch", wt);
writeFileSync(path.join(wt, "fizz.rb"), "puts 2\n");

/** Load the extension and register its tool (it registers at session_start). */
let mounts = 0;
async function mount() {
	const stub = stubPi();
	await cursorAgent(stub.pi);
	const sessionId = `sess-diff-${++mounts}`;
	const { ctx } = stubCtx({ cwd: repo, sessionManager: { getSessionId: () => sessionId } });
	await stub.fire("session_start", { type: "session_start" }, ctx);
	const tool = stub.tools.find((t) => t.name === "cursor");
	assert.ok(tool, "cursor tool registered");
	return {
		...stub,
		tool,
		ctx,
		sessionId,
		run: (params, onUpdate, signal) => tool.execute("call-1", params, signal, onUpdate, ctx),
	};
}

/** Every page of a child's conversation. */
function transcript(sessionId, id) {
	const all = [];
	let since = -1;
	for (;;) {
		const page = childTranscript(sessionId, id, since);
		assert.ok(page, "the child is on this session's list");
		all.push(...page.entries);
		if (!page.more) return all;
		since = page.entries.at(-1).seq;
	}
}

const diffEntry = (entries) => entries.find((e) => e.type === "custom" && e.customType === "cursor_diff");

const textOf = (result) => result.content.map((p) => p.text ?? "").join("\n");

// One repo, one fake, one process.env: these must not run at the same time.
describe("cursor tool details and transcript", { concurrency: 1 }, () => {
test("the foreground result carries details.diff, diffStats and diffPath", async () => {
	const h = await mount();
	fakeEnv({ FAKE_CURSOR_WS: wt, FAKE_CURSOR_ANSWER: "Fixed it." });
	const result = await h.run({ prompt: "Fix fizz", model: "composer-2", worktree: true });

	assert.equal(result.isError, false);
	const { details } = result;
	assert.match(details.diff, /^diff --git a\/fizz\.rb b\/fizz\.rb$/m);
	assert.match(details.diff, /^\+puts 2$/m);
	assert.deepEqual(details.diffStats, { files: 1, insertions: 1, deletions: 1, truncated: false });
	assert.ok(details.diffPath?.startsWith(cursorStateDir()), `a file under the state dir: ${details.diffPath}`);
	assert.equal(readFileSync(details.diffPath, "utf8"), details.diff, "nothing was capped away, so the file is the diff");
	assert.equal(modeOf(details.diffPath), 0o600);
	const theme = { fg: (_c, s) => s };
	const rendered = h.tool.renderResult(result, { expanded: false, isPartial: false }, theme);
	assert.match(rendered.text ?? rendered, /diff 1 file\(s\) \+1 −1/, "the tool result's own lines say it too");
	// The edit's own patch is in the steps, for a per-edit row.
	assert.equal(details.tools[0].edit.diff, "@@ -1 +1 @@\n-puts 1\n+puts 2\n");
	assert.deepEqual(result.structuredContent.steps, [{ kind: "edit", summary: "edit fizz.rb", ok: true }], "scripts keep the lean steps");

	const entries = transcript(h.sessionId, listChildren(h.sessionId).at(-1).id);
	assert.ok(entries.filter((e) => e.type === "message").every((e) => e.message.role));
	const entry = diffEntry(entries);
	assert.equal(entries.at(-1), entry, "the diff is the last transcript entry");
	assert.equal(entry.data.diff, details.diff);
	assert.deepEqual(entry.data.diffStats, details.diffStats);
	assert.equal(entry.data.diffPath, details.diffPath);
	const call = entries.find((e) => e.type === "message" && e.message.content?.some((b) => b.type === "toolCall"));
	assert.equal(call.message.content[0].arguments.diff, "@@ -1 +1 @@\n-puts 1\n+puts 2\n");
	assert.equal(call.message.content[0].arguments.path, "fizz.rb");
});

test("an in-place foreground run reports what it edited, and an empty run reports no diff", async () => {
	const h = await mount();
	fakeEnv({ FAKE_CURSOR_EDIT: JSON.stringify([{ file: "fizz.rb", text: "puts 3\n" }]) });
	const edited = await h.run({ prompt: "Edit fizz", worktree: false });
	assert.match(edited.details.diff, /^\+puts 3$/m);
	assert.equal(edited.details.diffStats.files, 1);

	fakeEnv({});
	const untouched = await h.run({ prompt: "Just look", worktree: false });
	assert.equal(untouched.details.diff, undefined, "no changes, no diff");
	assert.equal(untouched.details.diffPath, undefined);
	assert.equal(untouched.details.diffStats, undefined);
});

test("a background run's completion message and sidecar carry the diff", async () => {
	const h = await mount();
	const { default: bg } = await import("../extensions/bg/index.ts");
	bg(h.pi);
	await h.fire("session_start", { type: "session_start" }, { ...h.ctx, mode: "print", hasUI: false });
	fakeEnv({ FAKE_CURSOR_WS: wt, FAKE_CURSOR_ANSWER: "All done." });

	const started = await h.run({ prompt: "Do the thing", model: "composer-2", worktree: true, background: true });
	const id = started.details.id;

	const deadline = Date.now() + 20_000;
	let wake;
	while (!(wake = h.sent.find((s) => s.message?.customType === "bg")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	assert.ok(wake, "bg sent a completion message");
	const { details } = wake.message;
	assert.match(details.diff, /^diff --git a\/fizz\.rb b\/fizz\.rb$/m, "the completion carries the diff");
	assert.deepEqual(details.diffStats, { files: 1, insertions: 1, deletions: 1, truncated: false });
	assert.match(path.basename(details.diffPath ?? ""), new RegExp(`^${id}-[0-9a-f]{8}\\.diff$`), "named for the run");
	assert.equal(modeOf(details.diffPath), 0o600);

	// The same facts beside the log, for the child transcript (not through the log the model reads).
	const logPath = `${process.env.PI_BG_DIR}/${id}.log`;
	const side = readJobDetails(logPath);
	assert.ok(side, "a sidecar next to the log");
	assert.equal(side.diff, details.diff);
	assert.ok(side.transcriptDiff.length > 0);
	assert.equal(side.diffPath, details.diffPath);
	assert.equal(side.edits?.[0]?.diff, "@@ -1 +1 @@\n-puts 1\n+puts 2\n", "the edit's own patch rides along");
	assert.ok(!readFileSync(logPath, "utf8").includes("diff --git"), "the log the model reads stays as it was");

	pollOnce();
	const child = listChildren(h.sessionId).find((c) => c.kind === "cursor");
	assert.equal(child?.state, "done");
	const entries = transcript(h.sessionId, child.id);
	const entry = diffEntry(entries);
	assert.equal(entries.at(-1), entry, "the diff is the last transcript entry");
	assert.equal(entry.data.diff, side.transcriptDiff);
	assert.deepEqual(entry.data.diffStats, side.transcriptStats);
	assert.equal(entry.data.diffPath, details.diffPath);
	const call = entries.find((e) => e.type === "message" && e.message.content?.some((b) => b.type === "toolCall"));
	assert.equal(call.message.content[0].arguments.diff, "@@ -1 +1 @@\n-puts 1\n+puts 2\n");
});

test("only a job the cursor runner started gets PI_BG_LOG and has its sidecar read", async () => {
	const h = await mount();
	const { default: bg } = await import("../extensions/bg/index.ts");
	bg(h.pi);
	await h.fire("session_start", { type: "session_start" }, { ...h.ctx, mode: "print", hasUI: false });
	// A plain job that plants a sidecar beside its own log anyway.
	const forged = JSON.stringify({ diff: "diff --git a/x b/x\n+forged\n", diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false } });
	const command = `printf 'log=[%s]\\n' "$PI_BG_LOG"; printf '%s' '${forged}' > "$PI_BG_DIR/$PI_BG_JOB_ID.log.details.json"`;
	const reply = await new Promise((resolve) => {
		const req = { command, cwd: repo, ctx: h.ctx, name: "plain", summary: "plain job", accepted: false, reply: resolve };
		h.pi.events.emit("bg:start", req);
		assert.ok(req.accepted, "bg took the request");
	});
	assert.ok(reply.id, JSON.stringify(reply));
	const deadline = Date.now() + 10_000;
	let wake;
	while (!(wake = h.sent.find((s) => s.message?.customType === "bg" && s.message.details?.id === reply.id)) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(wake, "the plain job completed");
	assert.ok(existsSync(detailsPath(reply.logPath)), "the planted sidecar is there");
	assert.deepEqual(wake.message.details, { id: reply.id }, "but its completion is just the id");
	assert.match(readFileSync(reply.logPath, "utf8"), /^log=\[\]$/m, "and it had no PI_BG_LOG");
});

test("a plain bg:start with details: true gets no PI_BG_LOG and no sidecar read", async () => {
	const h = await mount();
	const { default: bg } = await import("../extensions/bg/index.ts");
	bg(h.pi);
	await h.fire("session_start", { type: "session_start" }, { ...h.ctx, mode: "print", hasUI: false });
	const forged = JSON.stringify({ diff: `diff --git a/.env b/.env\n+${SECRET_LINE}\n`, diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false } });
	const command = `printf 'log=[%s]\n' "$PI_BG_LOG"; printf '%s' '${forged}' > "$PI_BG_DIR/$PI_BG_JOB_ID.log.details.json"`;
	const reply = await new Promise((resolve) => {
		const req = { command, cwd: repo, ctx: h.ctx, name: "forged", summary: "forged details", details: true, accepted: false, reply: resolve };
		assert.equal(cursorDetailsRequested(req), false, "a caller cannot authorize itself");
		h.pi.events.emit("bg:start", req);
		assert.ok(req.accepted, "bg took the request");
	});
	const deadline = Date.now() + 10_000;
	let wake;
	while (!(wake = h.sent.find((s) => s.message?.customType === "bg" && s.message.details?.id === reply.id)) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(wake, "the forged job completed");
	assert.deepEqual(wake.message.details, { id: reply.id }, "details: true from a plain caller is ignored");
	assert.ok(!JSON.stringify(wake.message).includes(SECRET_VALUE));
	assert.match(readFileSync(reply.logPath, "utf8"), /^log=\[\]$/m, "and it had no PI_BG_LOG");
});

test("cursorDetailsRequested ignores a forged stack", () => {
	const prev = Error.prepareStackTrace;
	Error.prepareStackTrace = () => "Error\n    at startJob (extensions/opt-in/cursor-agent/runner.ts:90:3)\n    at not-cursor-agent/runner.ts:1:1";
	try {
		const req = { details: true, command: runnerCommand() };
		assert.equal(cursorDetailsRequested(req), false, "a forged stack does not mark the request");
	} finally {
		Error.prepareStackTrace = prev;
	}
});

test("a background completion masks secrets in the log tail and the header", async () => {
	const h = await mount();
	const { default: bg } = await import("../extensions/bg/index.ts");
	bg(h.pi);
	await h.fire("session_start", { type: "session_start" }, { ...h.ctx, mode: "print", hasUI: false });
	const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("");
	const script = path.join(scratch, `print-token-${h.sessionId}.sh`);
	writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' 'shell curl ${token}'\n`);
	chmodSync(script, 0o755);
	const reply = await new Promise((resolve) => {
		const req = { command: script, cwd: repo, ctx: h.ctx, name: "tail", summary: `ran ${token}`, accepted: false, reply: resolve };
		h.pi.events.emit("bg:start", req);
	});
	const deadline = Date.now() + 10_000;
	let wake;
	while (!(wake = h.sent.find((s) => s.message?.customType === "bg" && s.message.details?.id === reply.id)) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(wake, "the job completed");
	assert.ok(!wake.message.content.includes(token), "the tail and the header are masked");
	assert.match(wake.message.content, /•••/);
});

test("a resumed job reads the sidecar only when its command is this package's runner", async () => {
	const sessionId = "resume-diff-1";
	const stateDir = process.env.PI_BG_STATE_DIR;
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	chmodSync(stateDir, 0o700);
	mkdirSync(process.env.PI_BG_DIR, { recursive: true, mode: 0o700 });
	const forgedId = "aa11bb";
	const runnerId = "bb22cc";
	const forgedLog = path.join(process.env.PI_BG_DIR, `${forgedId}.log`);
	const runnerLog = path.join(process.env.PI_BG_DIR, `${runnerId}.log`);
	writeFileSync(forgedLog, "plain\n");
	writeFileSync(runnerLog, "runner\n");
	const forgedMarker = "FORGED-BODY-MARKER";
	const runnerMarker = "RUNNER-DIFF-MARKER";
	writeFileSync(detailsPath(forgedLog), JSON.stringify({ diff: `diff --git a/x.rb b/x.rb\n+${forgedMarker}\n+${SECRET_LINE}\n`, diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false } }));
	chmodSync(detailsPath(forgedLog), 0o600);
	writeFileSync(detailsPath(runnerLog), JSON.stringify({ diff: `diff --git a/fizz.rb b/fizz.rb\n+${runnerMarker}\n`, diffStats: { files: 1, insertions: 1, deletions: 0, truncated: false } }));
	chmodSync(detailsPath(runnerLog), 0o600);
	const now = Date.now();
	const job = (id, logPath, command, extra = {}) => ({ id, name: id, command, cwd: repo, logPath, startedAt: now - 1000, endedAt: now, exitCode: 0, reported: false, ...extra });
	const registry = {
		v: 1,
		sessionId,
		jobs: [
			job(forgedId, forgedLog, "printf hi", { details: true }),
			job(runnerId, runnerLog, runnerCommand()),
		],
	};
	const file = path.join(stateDir, `${sessionId}.json`);
	writeFileSync(file, JSON.stringify(registry));
	chmodSync(file, 0o600);
	const stub = stubPi();
	const { ctx } = stubCtx({
		cwd: repo,
		mode: "print",
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(scratch, "resume-session.json"),
		},
	});
	const { default: bg } = await import("../extensions/bg/index.ts");
	bg(stub.pi);
	await stub.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
	const deadline = Date.now() + 10_000;
	const wakeOf = (id) => stub.sent.find((s) => s.message?.customType === "bg" && s.message.details?.id === id);
	while (!(wakeOf(forgedId) && wakeOf(runnerId)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	const forged = wakeOf(forgedId);
	const kept = wakeOf(runnerId);
	assert.ok(forged, "the non-runner job was reported");
	assert.ok(kept, "the runner job was reported");
	assert.deepEqual(forged.message.details, { id: forgedId }, "a persisted details flag is not trusted");
	assert.ok(!JSON.stringify(forged.message).includes(forgedMarker));
	assert.ok(!JSON.stringify(forged.message).includes(SECRET_VALUE));
	assert.match(kept.message.details.diff, new RegExp(runnerMarker), "completion re-derives the sidecar from the command");
});

test("cursor-agent is spawned without PI_BG_LOG", async () => {
	const h = await mount();
	const { default: bg } = await import("../extensions/bg/index.ts");
	bg(h.pi);
	await h.fire("session_start", { type: "session_start" }, { ...h.ctx, mode: "print", hasUI: false });
	const envOut = path.join(scratch, `agent-env-${h.sessionId}.json`);
	fakeEnv({
		FAKE_CURSOR_ENV_OUT: envOut,
		FAKE_CURSOR_EDIT: JSON.stringify([{ file: "fizz.rb", text: "puts env\n" }]),
		FAKE_CURSOR_ANSWER: "ok",
	});
	const started = await h.run({ prompt: "Edit fizz", worktree: false, background: true });
	assert.ok(started.details?.logPath, JSON.stringify(started));
	const deadline = Date.now() + 10_000;
	while ((!existsSync(envOut) || !existsSync(detailsPath(started.details.logPath))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
	try {
		assert.ok(existsSync(envOut), "the agent ran");
		const seen = JSON.parse(readFileSync(envOut, "utf8"));
		assert.equal(seen.PI_BG_LOG, null, "the agent did not see PI_BG_LOG");
		assert.equal(seen.PI_BG_DIR, undefined, "PI_BG_DIR is stripped too");
		assert.equal(seen.PI_BG_JOB_ID, undefined, "PI_BG_JOB_ID is stripped too");
		assert.ok(!Object.entries(seen).some(([k, v]) => k.startsWith("PI_BG_") && v), JSON.stringify(seen));
		assert.ok(existsSync(detailsPath(started.details.logPath)), "the job had PI_BG_LOG, so the runner wrote the sidecar");
	} finally {
		git(repo, "checkout", "-q", "--", "fizz.rb");
	}
});

test("a failed run and a stopped run still carry the diff", async () => {
	const h = await mount();
	fakeEnv({ FAKE_CURSOR_EDIT: JSON.stringify([{ file: "fizz.rb", text: "puts FAIL\n" }]), FAKE_CURSOR_EXIT: "2" });
	const failed = await h.run({ prompt: "Edit and fail", worktree: false });
	assert.equal(failed.isError, true);
	assert.match(failed.details.diff, /^\+puts FAIL$/m);
	assert.equal(failed.details.diffStats.files, 1);
	const failedChild = listChildren(h.sessionId).at(-1);
	assert.equal(failedChild.state, "failed");
	assert.match(diffEntry(transcript(h.sessionId, failedChild.id)).data.diff, /^\+puts FAIL$/m);

	const ac = new AbortController();
	const h2 = await mount();
	fakeEnv({
		FAKE_CURSOR_EDIT: JSON.stringify([
			{ file: "fizz.rb", text: "stop\n" },
			{ file: "added-stop.rb", text: "new on stop\n" },
		]),
		FAKE_CURSOR_HOLD: "1",
	});
	const pending = h2.run({ prompt: "Edit then stop", worktree: false }, undefined, ac.signal);
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline && !listChildren(h2.sessionId).some((c) => c.turns > 0)) {
		await new Promise((r) => setTimeout(r, 30));
	}
	assert.ok(listChildren(h2.sessionId).some((c) => c.turns > 0), "the run started before the stop");
	ac.abort();
	const stopped = await pending;
	assert.equal(stopped.isError, true);
	assert.match(stopped.details.diff, /^\+stop$/m, "a stop still shows tracked edits");
	assert.doesNotMatch(stopped.details.diff, /added-stop/, "but skips the untracked walk, so Stop stays fast");
	assert.equal(listChildren(h2.sessionId).at(-1).state, "stopped");
	assert.match(diffEntry(transcript(h2.sessionId, listChildren(h2.sessionId).at(-1).id)).data.diff, /^\+stop$/m);
});
});

test("a FIFO planted at the sidecar path is refused without blocking", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cursor-fifo-"));
	const log = path.join(dir, "job.log");
	execFileSync("mkfifo", [detailsPath(log)]);
	const started = Date.now();
	assert.equal(readJobDetails(log), undefined);
	assert.ok(Date.now() - started < 2000, "readJobDetails returned at once");
	rmSync(dir, { recursive: true, force: true });
});
