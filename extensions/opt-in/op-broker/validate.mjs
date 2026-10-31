// op-broker's one set of rules for what a request may name, shared by the shim (shim.mjs), the
// session (index.ts, broker.ts) and the daemon (daemon.mjs), so each checks the same thing.
// Plain JS (with validate.d.mts for TypeScript) so the shim and daemon start without type stripping.

import { homedir } from "node:os";
import { join } from "node:path";

export const brokerDir = (env = process.env) => env.PI_OP_BROKER_DIR || join(homedir(), ".local", "state", "pi-op-broker");

// Item, vault and field names, so the card shows exactly what's read: no control, format
// (zero-width, bidi), line-separator, surrogate, private-use or unassigned characters; no runs of
// whitespace (two names that look alike); none of the card's own separators (broker.ts's
// cardTitle: "·" between item and field, "›" between section and field); and no leading "-", so
// nothing reads as a flag.
const BAD = "\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}\\p{Co}\\p{Cn}·›";
const NO_RUNS = "(?![^]*\\s\\s)";
export const NAME = new RegExp(`^${NO_RUNS}(?!-)[^${BAD}]{1,200}$`, "u");
export const ACCOUNT = /^(?!-)[\w.@-]{1,100}$/;
// One op:// path segment: the same characters refused, and no "?" (the only query taken is ?attribute=otp).
export const SEG = `[^/?${BAD}]+`;
export const REF = new RegExp(`^${NO_RUNS}op://${SEG}/${SEG}(/${SEG}){1,2}(\\?attribute=(otp|totp))?$`, "u");
// The same shape with its parts captured (broker.ts's parseRef): vault, item, section?, field, query?.
export const REF_PARTS = new RegExp(`^${NO_RUNS}op://(${SEG})/(${SEG})/(?:(${SEG})/)?(${SEG})(\\?attribute=(?:otp|totp))?$`, "u");

const str = (v) => typeof v === "string";

/** A field list: 1 to 10 names, none with a comma (they're joined with one). */
export const validFields = (fields) => Array.isArray(fields) && fields.length >= 1 && fields.length <= 10 && fields.every((f) => str(f) && NAME.test(f) && !f.includes(","));

/** Is this {kind, ref?, item?, vault?, fields?, account?} a read op-broker runs, every part valid? */
export function validRequest(req) {
	if (!req || typeof req !== "object") return false;
	if (req.account !== undefined && !(str(req.account) && ACCOUNT.test(req.account))) return false;
	if (req.vault !== undefined && !(str(req.vault) && NAME.test(req.vault))) return false;
	switch (req.kind) {
		case "whoami": return req.ref === undefined && req.item === undefined && req.fields === undefined;
		case "read": return str(req.ref) && REF.test(req.ref) && req.item === undefined && req.fields === undefined;
		case "otp": return str(req.item) && NAME.test(req.item) && req.ref === undefined && req.fields === undefined;
		case "fields": return str(req.item) && NAME.test(req.item) && req.ref === undefined && validFields(req.fields);
		default: return false;
	}
}
