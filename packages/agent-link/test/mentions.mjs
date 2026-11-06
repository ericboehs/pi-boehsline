// @-mention parsing and autocomplete ranking. No pi needed:
//   node --experimental-strip-types --test test/mentions.mjs
import assert from "node:assert/strict";
import test from "node:test";

const {
  extractAtQuery,
  isPathishQuery,
  matchPeer,
  filterPeers,
  findAgentMentions,
  mentionHint,
  formatAgentItem,
  isInboundPeerPrompt,
  nameHandle,
} = await import("../mentions.ts");

const foo = { name: "foo", pid: 11, cwd: "/Users/eric/Code/foo", status: "idle" };
const bar = { name: "bar-agent", pid: 22, cwd: "/tmp/bar", status: "thinking" };
const foo2 = { name: "foo", pid: 33, cwd: "/tmp/foo-2", status: "idle" };
const peers = [foo, bar];

test("extractAtQuery finds an @token at the cursor", () => {
  assert.deepEqual(extractAtQuery("@"), { prefix: "@", query: "" });
  assert.deepEqual(extractAtQuery("@foo"), { prefix: "@foo", query: "foo" });
  assert.deepEqual(extractAtQuery("ask @foo"), { prefix: "@foo", query: "foo" });
  assert.deepEqual(extractAtQuery("ask @foo-"), { prefix: "@foo-", query: "foo-" });
  assert.equal(extractAtQuery("ask @foo more"), null);
  assert.equal(extractAtQuery("nope"), null);
  assert.equal(extractAtQuery("/agent-link"), null);
  assert.equal(extractAtQuery('@"quoted'), null);
});

test("isPathishQuery skips file-like tokens", () => {
  assert.equal(isPathishQuery(""), false);
  assert.equal(isPathishQuery("foo"), false);
  assert.equal(isPathishQuery("src/index.ts"), true);
  assert.equal(isPathishQuery("./foo"), true);
  assert.equal(isPathishQuery("~/dotfiles"), true);
  assert.equal(isPathishQuery('"has space'), true);
});

test("matchPeer resolves pid, exact name, then unique prefix", () => {
  assert.equal(matchPeer("foo", peers), foo);
  assert.equal(matchPeer("bar", peers), bar);
  assert.equal(matchPeer("11", peers), foo);
  assert.equal(matchPeer("missing", peers), undefined);
  assert.equal(matchPeer("foo", [foo, foo2]), undefined, "duplicate names stay unresolved");
  assert.equal(matchPeer("FOO", peers), foo, "case-insensitive when unique");
});

test("filterPeers ranks prefix matches first", () => {
  assert.deepEqual(filterPeers(peers, ""), peers);
  assert.deepEqual(filterPeers(peers, "f"), [foo]);
  assert.deepEqual(filterPeers(peers, "bar"), [bar]);
  assert.deepEqual(filterPeers(peers, "tmp"), [bar]);
  assert.deepEqual(filterPeers(peers, "nope"), []);
});

test("findAgentMentions picks live agents and ignores files", () => {
  assert.deepEqual(findAgentMentions("@foo check the tests", peers), [{ raw: "@foo", peer: foo }]);
  assert.deepEqual(findAgentMentions("ask @bar-agent, then read @src/index.ts", peers), [
    { raw: "@bar-agent", peer: bar },
  ]);
  assert.deepEqual(findAgentMentions("see @./foo and @~/x", peers), []);
  assert.deepEqual(findAgentMentions("@foo and @foo again", peers), [{ raw: "@foo", peer: foo }]);
  assert.deepEqual(findAgentMentions("@missing hi", peers), []);
  assert.deepEqual(findAgentMentions("@foo.", peers), [{ raw: "@foo", peer: foo }]);
});

test("mentionHint tells the model to use agent-link, not read", () => {
  const hint = mentionHint([{ raw: "@foo", peer: foo }]);
  assert.match(hint, /@foo addresses live agent-link session "foo"/);
  assert.match(hint, /agent-link tool/);
  assert.match(hint, /Do not treat @foo as a file path/);
  assert.equal(mentionHint([]), "");
});

test("formatAgentItem keeps @name as the completion value", () => {
  assert.deepEqual(formatAgentItem(foo, "/Users/eric"), {
    value: "@foo",
    label: "foo",
    description: "agent · idle · ~/Code/foo",
  });
});

test("isInboundPeerPrompt skips framed peer traffic", () => {
  assert.equal(isInboundPeerPrompt("[cross-agent message — from another agent"), true);
  assert.equal(isInboundPeerPrompt("[reply from another agent session"), true);
  assert.equal(isInboundPeerPrompt("@foo check tests"), false);
});

const tamer = { name: "Chicken Door Tamer", pid: 44, cwd: "/tmp/coop", status: "idle" };
const plumber = { name: "Canvas Leak Plumber", pid: 55, cwd: "/tmp/canvas", status: "idle" };
const spaced = [foo, tamer, plumber];

test("nameHandle lowercases and hyphenates spaced names", () => {
  assert.equal(nameHandle("Chicken Door Tamer"), "chicken-door-tamer");
  assert.equal(nameHandle("  Flaky  CI_Wrangler "), "flaky-ci-wrangler");
  assert.equal(nameHandle("bar-agent"), "bar-agent");
});

test("matchPeer finds spaced names by handle, prefix, or first word", () => {
  assert.equal(matchPeer("Chicken Door Tamer", spaced), tamer, "the exact name still works");
  assert.equal(matchPeer("chicken-door-tamer", spaced), tamer);
  assert.equal(matchPeer("chicken-door", spaced), tamer);
  assert.equal(matchPeer("Chicken", spaced), tamer);
  assert.equal(matchPeer("canvas-leak", spaced), plumber);
  assert.equal(matchPeer("chicken-door", [tamer, { ...tamer, pid: 66 }]), undefined, "duplicates stay unresolved");
});

test("findAgentMentions resolves hyphenated handles of spaced names", () => {
  assert.deepEqual(findAgentMentions("@chicken-door-tamer why every morning?", spaced), [
    { raw: "@chicken-door-tamer", peer: tamer },
  ]);
  assert.deepEqual(findAgentMentions("ping @canvas-leak", spaced), [{ raw: "@canvas-leak", peer: plumber }]);
});

test("filterPeers matches spaced names by their handle", () => {
  assert.deepEqual(filterPeers(spaced, "chicken-d"), [tamer]);
  assert.deepEqual(filterPeers(spaced, "Canvas"), [plumber]);
});

test("formatAgentItem completes spaced names as their handle", () => {
  assert.deepEqual(formatAgentItem(tamer), {
    value: "@chicken-door-tamer",
    label: "Chicken Door Tamer",
    description: "agent · idle · /tmp/coop",
  });
});
