// The transaction encoding of Tenet Pay's pages (tenet-pay/site/tenet.js), without a browser. test/encode.test.mjs checks
// these against that file on the same inputs, so the SDK sends what My orders and the checkout send.
export const SEL = { approve: "095ea7b3", allowance: "dd62ed3e", pay: "919aeb18", openClaim: "f0dd1fe5", submit: "3d5376fa", withdraw: "51cff8d9",
  claimable: "d4570c1c", merchantTermsHash: "e16eba66" };

export const word = (h) => String(h).replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const uint = (n) => BigInt(n).toString(16).padStart(64, "0");
export function utf8Hex(text) { return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

/** A call that takes (bytes32 orderRef, bytes text): openClaim and submit. */
export function withBytes(sel, ref, text) {
  const h = utf8Hex(text), len = h.length / 2;
  return "0x" + sel + word(ref) + uint(64) + uint(len) + h.padEnd(Math.ceil(len / 32) * 64, "0");
}

/** Canonical JSON (sorted keys, no spaces, ASCII), as the escrow and the judges read a claim or a submission. */
export function cj(o) {
  if (o === null || typeof o !== "object") {
    return typeof o === "string" ? JSON.stringify(o).replace(/[\u0080-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")) : JSON.stringify(o);
  }
  if (Array.isArray(o)) return "[" + o.map(cj).join(",") + "]";
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + cj(o[k])).join(",") + "}";
}

export const approveData = (spender, units) => "0x" + SEL.approve + word(spender) + uint(units);
export const payData = (o, units) => "0x" + SEL.pay + word(o.ref) + word(o.merchant) + word(o.usdc) + uint(units)
  + uint(o.terms.hold_days * 86400) + word(o.terms.terms_hash);
export const claimData = (ref, claim) => withBytes(SEL.openClaim, ref, cj(claim));
export const submitData = (ref, text) => withBytes(SEL.submit, ref, text);
export const withdrawData = (usdc) => "0x" + SEL.withdraw + word(usdc);
