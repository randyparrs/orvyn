// The SDK's encoding against the pages' own code (tenet-pay/site/tenet.js) on the same inputs, and terms.js byte for byte.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as E from "../sdk/encode.js";
import { tenetPayDir } from "../config.mjs";

globalThis.document = { querySelector: () => null };
globalThis.window = {};
const T = await import(pathToFileURL(join(tenetPayDir(), "site", "tenet.js")).href);

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };
const REF = "0x0d5eb4ee9db7bb73590f3f2716641bc0cb9ad5a5a1eb4a0a910d2bebcca4026f";
const claims = [{ a: 1, z: "x", account: "café, 65 W \"quoted\"", n: null, l: [1, "b"] }, { v: "claim-v1", amount_cents: 200, event: "not_delivered" }];

check(Object.keys(E.SEL).every((k) => E.SEL[k] === T.SEL[k]), "selectors equal to the pages'");
check(claims.every((c) => E.cj(c) === T.cj(c)), "canonical JSON equal, with accents and quotes");
check(claims.every((c) => E.withBytes(E.SEL.openClaim, REF, E.cj(c)) === T.withBytes(T.SEL.openClaim, REF, T.cj(c))), "openClaim data equal");
check(E.submitData(REF, "text with ñ") === T.withBytes(T.SEL.submit, REF, "text with ñ"), "submit data equal");
check(E.word("0xABC") === T.word("0xABC") && E.uint(5000000n) === T.uint(5000000n), "word and uint equal");
const o = { ref: REF, merchant: "0x7a090c3414e98fe722a819a1d29c93b04a52ed6c", usdc: "0x3600000000000000000000000000000000000000",
  terms: { hold_days: 30, terms_hash: "0xab9996d0149a7f43943d340749a4036b7ef5440547e53fca7c40abec650a98e9" } };
// site/checkout.js: "0x" + SEL.pay + word(r.ref) + word(r.merchant) + word(r.usdc) + uint(amount) + uint(hold_days * 86400) + word(terms_hash)
check(E.payData(o, 1000000n) === "0x" + T.SEL.pay + T.word(o.ref) + T.word(o.merchant) + T.word(o.usdc) + T.uint(1000000n) + T.uint(30 * 86400) + T.word(o.terms.terms_hash),
  "pay data equal to the checkout's expression");
check(E.approveData(o.merchant, 7n) === "0x" + T.SEL.approve + T.word(o.merchant) + T.uint(7n), "approve data equal");
check(E.withdrawData(o.usdc) === "0x" + T.SEL.withdraw + T.word(o.usdc), "withdraw data equal");
const a = readFileSync(new URL("../sdk/terms.js", import.meta.url)), b = readFileSync(join(tenetPayDir(), "worker", "src", "terms.js"));
check(a.equals(b), "sdk/terms.js is the Worker's terms.js byte for byte");
console.log(failed ? `ENCODE FAIL (${failed})` : "encode: pass");
process.exit(failed ? 1 : 0);
