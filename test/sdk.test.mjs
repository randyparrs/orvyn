// The SDK against a stand-in gateway and Arc: the owner's rules, what is refused and exactly what goes to the signer.
import { readdirSync, readFileSync } from "node:fs";
import { createOrvyn, orderOf, Refused } from "../sdk/index.js";
import { parseRules } from "../sdk/rules.js";
import { SEL, payData, approveData } from "../sdk/encode.js";
import { BUYER, RULES, bytesOf, world } from "./world.mjs";

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };
const refused = async (fn, re) => { try { await fn(); return false; } catch (e) { return e instanceof Refused && re.test(e.message); } };

// ---- paying ----------------------------------------------------------------------------------------------------
{
  const w = world();
  const r = await w.orvyn.payLink("https://paytenet.site/#pay/TS-476930");
  check(w.sent.length === 2 && w.sent[0].to === w.net.usdc && w.sent[0].data === approveData(w.net.escrow, 1000000n)
    && w.sent[1].to === w.net.escrow && w.sent[1].data === payData({ ...w.checkout, usdc: w.net.usdc }, 1000000n), "pay: approve of the exact amount, then pay to the escrow");
  check(r.paid && r.protected_by.hold_days === 30 && w.ledger.spends.length === 1 && w.ledger.spends[0].units === 1000000, "pay: the result names the protection and the ledger counts it");
}
{
  const w = world({ allowance: 5000000n });
  await w.orvyn.payLink("TS-476930");
  check(w.sent.length === 1 && w.sent[0].data.startsWith("0x" + SEL.pay), "pay: no approve when the allowance covers it");
}
{
  const w = world({ rules: { ...RULES, max_per_order_usdc: 0.5, max_per_day_usdc: 10 } });
  check(await refused(() => w.orvyn.payLink("TS-476930"), /limit per order/) && !w.sent.length, "rule: over the limit per order, nothing signed");
}
{
  const w = world({ ledger: { spends: [{ at: 1793399000, units: 9500000 }], claims: [] } });
  check(await refused(() => w.orvyn.payLink("TS-476930"), /daily limit/) && !w.sent.length, "rule: over the daily limit, nothing signed");
}
{
  const w = world({ ledger: { spends: [{ at: 1793400000 - 90000, units: 9500000 }], claims: [] } });
  await w.orvyn.payLink("TS-476930");
  check(w.sent.length === 2, "rule: yesterday's spending does not count today");
}
{
  const w = world({ onChainTerms: "0x" + "11".repeat(32) });
  check(await refused(() => w.orvyn.payLink("TS-476930"), /do not match the escrow/) && !w.sent.length, "pay: terms that do not match the escrow are refused: the order would not be protected");
}
{
  const w = world({ patchCheckout: (c) => ({ ...c, escrow: "0x" + "22".repeat(20) }) });
  check(await refused(() => w.orvyn.payLink("TS-476930"), /another network, escrow or token/) && !w.sent.length, "pay: an answer naming another escrow is refused");
}
{
  const w = world({ patchCheckout: (c) => ({ ...c, terms: { ...c.terms, structure: { ...c.terms.structure, day_type: "business" } } }) });
  check(await refused(() => w.orvyn.payLink("TS-476930"), /do not match/) && !w.sent.length, "pay: terms changed in the answer do not hash to the escrow's");
}
{
  const w = world({ patchCheckout: (c) => ({ ...c, paid: true }) });
  check(await refused(() => w.orvyn.payLink("TS-476930"), /already paid/) && !w.sent.length, "pay: an order already paid is refused");
}
{
  const w = world();
  await w.orvyn.payLink("https://evil.example/#pay/TS-476930");
  check(w.calls.every((u) => u.startsWith(w.net.api) || u === w.net.rpc), "a link's host is not used: only the configured gateway and RPC are called");
  check(orderOf(" TS-1 ") === "TS-1" && orderOf("https://paytenet.site/pay/#pay/TS-9") === "TS-9" && await refused(() => orderOf("../../x"), /not a Tenet Pay/), "order numbers from links");
}

{
  const w = world();
  const batches = [];
  const e = createOrvyn({ net: w.net, rules: parseRules(RULES), fetchImpl: w.fetchImpl, now: () => 1793400000, pollMs: 1,
    signer: { address: BUYER, sendTransaction: async () => { throw new Error("not one by one"); }, sendBatch: async (c) => { batches.push(c); return "0x" + "1".repeat(64); } } });
  const r = await e.payLink("TS-476930");
  check(batches.length === 1 && batches[0].length === 2 && batches[0][0].data.startsWith("0x" + SEL.approve) && batches[0][1].data.startsWith("0x" + SEL.pay) && r.transactions.length === 1,
    "pay: a smart account's signer gets approve and pay as one operation");
}

// ---- claims ----------------------------------------------------------------------------------------------------
{
  const w = world();
  const r = await w.orvyn.openClaim("TS-171823", "not_delivered", { account: "It never came." });
  const c = JSON.parse(bytesOf(w.sent[0].data));
  check(w.sent[0].to === w.net.escrow && w.sent[0].data.startsWith("0x" + SEL.openClaim) && c.event === "not_delivered" && c.account === "It never came."
    && c.promised_date === new Date(c.paid_at * 1000).toISOString().slice(0, 10) && c.buyer === BUYER && r.tx, "claim: not_delivered, as My orders builds it");
  check(w.ledger.claims.length === 1, "claim: the ledger counts it");
}
{
  const w = world();
  check(await refused(() => w.orvyn.openClaim("TS-171823", "late", {}), /verified on Lacre/) && !w.sent.length, "claim: late with no verified delivery email is refused");
}
{
  const w = world({ patchOrder: (o) => ({ ...o, mails: [{ state: "attested", dates: { delivered: true } }] }) });
  const lateNext = (await w.orvyn.openClaim("TS-171823", "late", { account: "ignored" })).next;
  const c = JSON.parse(bytesOf(w.sent[0].data));
  check(c.event === "late" && !("account" in c), "claim: late carries only the base, as My orders");
  check(/submit_evidence now/.test(lateNext) && !/window/.test(lateNext), "claim: after a late claim the agent is told to register the store's emails now, not to wait for the store");
}
{
  const w = world({ ask: async () => null });
  check(await refused(() => w.orvyn.openClaim("TS-171823", "not_as_described", { account: "x", promised: "a", received: "b" }), /did not approve/) && !w.sent.length,
    "claim: not_as_described without the owner's yes, nothing signed");
}
{
  const q = [];
  const w = world({ ask: async (a) => { q.push(a); return { approved: true, proof: { kind: "label", text: "Output 20 W" } }; } });
  await w.orvyn.openClaim("TS-171823", "not_as_described", { account: "20 W, not 65 W.", promised: "65 W", received: "20 W", proof: "agent invented", proof_kind: "serial_number", delivered_date: "2026-10-30" });
  const c = JSON.parse(bytesOf(w.sent[0].data));
  check(q[0].needs_proof && c.proof === "Output 20 W" && c.proof_kind === "label" && !JSON.stringify(c).includes("agent invented"), "claim: the proof is the owner's; a proof from the agent is ignored");
}
{
  const w = world({ ask: async () => ({ approved: true, proof: null }) });
  await w.orvyn.openClaim("TS-171823", "not_as_described", { account: "x", promised: "a", received: "b", proof: "agent invented", proof_kind: "label" });
  const c = JSON.parse(bytesOf(w.sent[0].data));
  check(c.proof === "" && c.proof_kind === "", "claim: the owner approves without proof: it goes without, the agent's is not used");
}
{
  const w = world({ rules: { ...RULES, claims: { ...RULES.claims, not_delivered: "never" } } });
  check(await refused(() => w.orvyn.openClaim("TS-171823", "not_delivered", { account: "x" }), /do not allow/) && !w.sent.length, "rule: a claim type the owner forbids");
}
{
  const t = 1793400000;
  const w = world({ ledger: { spends: [], claims: [{ at: t - 10 }, { at: t - 20 }] } });
  check(await refused(() => w.orvyn.openClaim("TS-171823", "not_delivered", { account: "x" }), /claims a week/) && !w.sent.length, "rule: the limit of claims a week");
}
{
  const w = world({ address: "0x" + "33".repeat(20) });
  check(await refused(() => w.orvyn.openClaim("TS-171823", "not_delivered", { account: "x" }), /not paid by this wallet/) && !w.sent.length, "claim: another wallet's order is refused");
}
{
  const w = world();
  check(await refused(() => w.orvyn.openClaim("TS-171823", "not_delivered", { account: "x".repeat(501) }), /over 500/) && await refused(() => w.orvyn.openClaim("TS-171823", "not_delivered", {}), /say what happened/)
    && await refused(() => w.orvyn.openClaim("TS-171823", "cancelled", { account: "x" }), /no rule/), "claim: the text's limits and the store's rules");
}

// ---- evidence, withdrawal, status ------------------------------------------------------------------------------
{
  const w = world({ patchOrder: (o) => ({ ...o, next: { action: "submit", submissions: ["{\"a\":1}", "{\"b\":2}"] } }) });
  const r = await w.orvyn.submitEvidence("TS-171823");
  check(r.registered_emails === 2 && w.sent.every((t) => t.data.startsWith("0x" + SEL.submit)) && bytesOf(w.sent[1].data) === "{\"b\":2}", "evidence: the submissions Tenet lists, one signature each");
}
{
  // a smart account (sendBatch): the same submissions in one UserOp
  const batches = [];
  const w = world({ patchOrder: (o) => ({ ...o, next: { action: "submit", submissions: ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"] } }) });
  const e = createOrvyn({ net: w.net, rules: parseRules(RULES), fetchImpl: w.fetchImpl, now: () => 1793400000, pollMs: 1,
    signer: { address: BUYER, sendTransaction: async () => { throw new Error("not one by one"); }, sendBatch: async (c) => { batches.push(c); return "0x" + "1".repeat(64); } } });
  const r = await e.submitEvidence("TS-171823");
  check(r.registered_emails === 3 && r.transactions.length === 1 && batches.length === 1 && batches[0].length === 3
    && batches[0].every((c) => c.data.startsWith("0x" + SEL.submit)) && bytesOf(batches[0][2].data) === "{\"c\":3}",
    "evidence with a smart account: the 3 store emails in one UserOp, in the order Tenet lists them");
}
{
  const w = world({ patchOrder: (o) => ({ ...o, next: { action: "proof" } }), ask: async () => ({ approved: true, proof: { kind: "model_number", text: "TS-C20" } }) });
  await w.orvyn.submitEvidence("TS-171823");
  const s = JSON.parse(bytesOf(w.sent[0].data));
  check(s.party === "buyer" && s.kind === "proof" && s.content.proof === "TS-C20", "evidence: asked proof comes from the owner");
}
{
  const w = world({ patchOrder: (o) => ({ ...o, next: { action: "closing" } }), ask: async () => null });
  check(await refused(() => w.orvyn.submitEvidence("TS-171823"), /gave no proof/) && !w.sent.length, "evidence: no proof from the owner, nothing signed");
}
{
  const w = world({ claimable: 1000000n }), z = world();
  const r = await w.orvyn.withdraw();
  check(r.withdrawn_usdc === 1 && w.sent[0].to === w.net.escrow && await refused(() => z.orvyn.withdraw(), /nothing to withdraw/), "withdraw: the balance, or refused when there is none");
}
{
  const w = world();
  const s = await w.orvyn.orderStatus("TS-171823");
  const r = w.orvyn.rulesStatus();
  check(s.order === "TS-171823" && s.buyer_is_this_wallet && s.next.action === "claim" && r.left_today_usdc === 10 && r.claims.not_as_described === "ask_owner", "status: the order and what is left of the rules");
}

// ---- the owner's rules file, and no keys ------------------------------------------------------------------------
const badRule = (r) => { try { parseRules(r); return false; } catch { return true; } };
check(badRule({}) && badRule({ ...RULES, max_per_day_usdc: 0 }) && badRule({ ...RULES, max_per_order_usdc: 20 }) && badRule({ ...RULES, claims: { ...RULES.claims, late: "yes" } })
  && badRule({ ...RULES, claims: { ...RULES.claims, not_as_described: "auto" } }) && badRule({ ...RULES, max_claims_per_week: -1 }), "rules: a wrong file stops the server; not_as_described cannot be auto");
const SRC = ["sdk", "mcp"].flatMap((d) => readdirSync(new URL(`../${d}/`, import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(new URL(`../${d}/${f}`, import.meta.url), "utf8")]));
check(SRC.length >= 5 && SRC.every(([, t]) => !/private_?key|mnemonic|seed ?phrase|keystore/i.test(t.replace(/never (reads|holds)[^\n]*/g, ""))), "no key handling anywhere in the SDK or the server");
console.log(failed ? `SDK FAIL (${failed})` : "sdk: pass");
process.exit(failed ? 1 : 0);
