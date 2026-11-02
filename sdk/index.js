// Orvyn SDK: an agent's side of Tenet Pay, over the gateway's public API and the escrow on Arc. It sends the same transactions
// as the checkout and My orders. It never holds a key: every transaction goes to the signer the owner gives it, which is
// { address, sendTransaction({ to, data }) -> hash }, with an optional sendBatch([{ to, data }]) -> hash for a smart account, so
// that approve and pay are one operation. It can be the owner's wallet, a session key or a provider's signer.
//
// Addresses come from the configuration, never from what the API or a payment link says: an answer that names another escrow
// or token stops the payment. The proof of a "not as described" claim comes only from askOwner, never from the agent.
import { approveData, claimData, payData, submitData, withdrawData, SEL, word, cj } from "./encode.js";
import { checkClaim, checkPay, claimsThisWeek, spentToday } from "./rules.js";
import { termsHash } from "./terms.js";

const ACCOUNT_MAX = 500, FIELD_MAX = 200;
const PROOF_KINDS = ["label", "model_number", "serial_number"];
const ORDER = /^[A-Za-z0-9-]{1,40}$/;

export class Refused extends Error {
  constructor(message) { super(message); this.refused = true; }
}
const no = (why) => { throw new Refused(why); };

export const TESTNET = { api: "https://tenet-gateway.randyparra.workers.dev", rpc: "https://rpc.testnet.arc.io", chainId: 5042002,
  escrow: "0x17FBCDF5c1780DfE29dcE5aFf2E3D3921d393798", usdc: "0x3600000000000000000000000000000000000000",
  windows: { response: "5 minutes", proof: "5 minutes" } };

/** The order number in a payment link (…/#pay/<order>, …/pay/#pay/<order>) or a bare order number; the link's host is not used. */
export function orderOf(link) {
  const s = String(link || "").trim();
  const m = /#pay\/([A-Za-z0-9-]{1,40})$/.exec(s);
  const n = m ? m[1] : s;
  if (!ORDER.test(n)) no("that is not a Tenet Pay payment link or order number");
  return n;
}

export function createOrvyn({ net = TESTNET, signer, rules, ledger, saveLedger = async () => {}, askOwner = async () => null, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000),
  waitMs = 90_000, pollMs = 1500 }) {
  if (!signer?.address || typeof signer.sendTransaction !== "function") throw new Error("a signer with address and sendTransaction is required");
  if (!rules) throw new Error("the owner's rules are required");
  const me = signer.address.toLowerCase();
  const led = ledger || { spends: [], claims: [] };

  async function get(path) {
    let r;
    try { r = await fetchImpl(net.api + path, { cache: "no-store" }); } catch { throw new Error("the gateway did not answer"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw Object.assign(new Error(j.error || `the gateway did not answer (${r.status})`), { status: r.status });
    return j;
  }
  async function rpc(method, params) {
    const r = await fetchImpl(net.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error || j.result === undefined) throw new Error(j.error?.message || "Arc did not answer");
    return j.result;
  }
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  async function mined(hash) {
    const end = Date.now() + waitMs;
    for (;;) {
      const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (r) {
        if (r.status !== "0x1") throw new Error(`transaction ${hash} reverted`);
        return hash;
      }
      if (Date.now() > end) throw new Error(`transaction ${hash} was not mined in time`);
      await new Promise((res) => setTimeout(res, pollMs));
    }
  }
  const send = async (to, data) => mined(await signer.sendTransaction({ to, data }));
  const units = (cents) => BigInt(cents) * 10000n;
  const short = (o) => ({ order: o.order, store: o.domain, description: o.description, amount_usdc: Number(o.amount_cents) / 100 });

  async function order(n) {
    const v = await get("/api/orders/" + encodeURIComponent(orderOf(n)));
    return v;
  }
  function mine(v) {
    if (!v.buyer || v.buyer.toLowerCase() !== me) no(`order ${v.order} was not paid by this wallet`);
  }

  return {
    address: me,

    /** The order as the agent needs it: its state, what comes next and the owner's room for it. */
    async orderStatus(n) {
      const v = await order(n);
      const emails = (v.mails || []).map((m) => ({ subject: m.subject, state: m.state, has_promised_date: !!m.dates?.promised, has_delivery_date: !!m.dates?.delivered }));
      const steps = (v.steps || []).map((s) => ({ step: s.n, attempts: (s.attempts || []).length, decided: s.decided || null, final: s.final || null }));
      return { ...short(v), paid: !!v.paid, buyer_is_this_wallet: (v.buyer || "").toLowerCase() === me, claim: v.claim ? { type: v.claim.event, opened_at: v.claim.at } : null,
        emails, steps, settled: v.settled ? { refund_usdc: v.settled.refund / 1e6, released_usdc: v.settled.released / 1e6, tx: v.settled.tx } : null,
        next: v.next ? { action: v.next.action, events: v.next.events, until: v.next.until, text: v.next.text } : null,
        events: (v.events || []).map((e) => ({ at: e.at, what: e.what, tx: e.tx || null, net: e.net || null })) };
    },

    /** Pays a payment link: checks the store's terms against the escrow and the owner's rules, then approve (if needed) and pay. */
    async payLink(link) {
      const n = orderOf(link);
      const o = await get("/api/checkout/" + encodeURIComponent(n));
      if (o.paid) no(`order ${o.order} is already paid`);
      if (Number(o.chain_id) !== net.chainId || o.escrow.toLowerCase() !== net.escrow.toLowerCase() || o.usdc.toLowerCase() !== net.usdc.toLowerCase()) no("the order names another network, escrow or token: not paid");
      if (o.merchant.toLowerCase() === me) no("this wallet is the store of that order");
      const want = units(o.amount_cents);
      const why = checkPay(rules, led, Number(want), now());
      if (why) no(why);
      // The protection the buyer gets: the terms the page shows hash to what the escrow holds for this store.
      const local = await termsHash(o.terms.structure, o.terms.hold_days, o.terms.windows || net.windows);
      const onChain = "0x" + String(await call(net.escrow, "0x" + SEL.merchantTermsHash + word(o.merchant))).replace(/^0x/, "").padStart(64, "0").slice(-64).toLowerCase();
      if (local !== o.terms.terms_hash || onChain !== local) no(`the store's terms do not match the escrow (${local}, ${onChain}): not paid, the order would not be protected`);
      const allowed = BigInt(await call(net.usdc, "0x" + SEL.allowance + word(me) + word(net.escrow)).catch(() => "0x0"));
      const txs = [];
      const payCall = { to: net.escrow, data: payData({ ...o, usdc: net.usdc }, want) }, approveCall = { to: net.usdc, data: approveData(net.escrow, want) };
      if (allowed < want && signer.sendBatch) txs.push({ step: "approve and pay", tx: await mined(await signer.sendBatch([approveCall, payCall])) });
      else {
        if (allowed < want) txs.push({ step: "approve", tx: await send(approveCall.to, approveCall.data) });
        txs.push({ step: "pay", tx: await send(payCall.to, payCall.data) });
      }
      led.spends.push({ at: now(), units: Number(want), order: o.order });
      await saveLedger(led);
      return { ...short(o), paid: true, transactions: txs, protected_by: { terms_hash: local, hold_days: o.terms.hold_days } };
    },

    /** Opens a claim. details.account is the agent's own text. For not_as_described the proof comes from askOwner, not from the agent. */
    async openClaim(n, event, details = {}) {
      const v = await order(n);
      mine(v);
      if (v.claim) no(`order ${v.order} already has a claim: an order takes one`);
      if (v.next?.action !== "claim") no(`order ${v.order} cannot be claimed now (${v.next?.action || "no action"})`);
      if (!v.next.events.includes(event)) no(`the store's terms have no rule for ${event}`);
      // A late claim is the store's own emails, as in My orders: it needs the delivery email verified on Lacre and carries no text.
      if (event === "late" && !(v.mails || []).some((m) => m.state === "attested" && m.dates?.delivered)) no("a late claim needs the store's delivery email verified on Lacre, and there is none yet");
      const account = String(details.account || "").trim();
      if (!account && event !== "late") no("say what happened in account");
      if (account.length > ACCOUNT_MAX) no(`account is over ${ACCOUNT_MAX} characters`);
      const t = now();
      let approved = false, proof = null;
      const mode = rules.claims[event];
      if (mode === "ask_owner" || event === "not_as_described") {
        const a = await askOwner({ kind: "claim", order: v.order, event, account, needs_proof: event === "not_as_described", proof_kinds: PROOF_KINDS });
        if (!a?.approved) no(`the owner did not approve the claim on ${v.order}`);
        approved = true;
        proof = a.proof || null;
      }
      const why = checkClaim(rules, led, event, t, approved);
      if (why) no(why);
      const c = { ...v.next.base, event };
      if (event === "not_delivered") Object.assign(c, { account, promised_date: new Date(v.next.base.paid_at * 1000).toISOString().slice(0, 10) });
      if (event === "not_as_described") {
        const promised = String(details.promised || "").trim(), received = String(details.received || "").trim();
        if (!promised || !received) no("not_as_described needs promised (quoted from the description) and received");
        if (promised.length > FIELD_MAX || received.length > FIELD_MAX) no(`promised and received are ${FIELD_MAX} characters at most`);
        if (proof && (!PROOF_KINDS.includes(proof.kind) || !String(proof.text || "").trim())) no("the owner's proof needs a kind and its text");
        Object.assign(c, { description: v.description, account, promised, received, proof_kind: proof ? proof.kind : "", proof: proof ? String(proof.text).trim() : "",
          delivered_date: details.delivered_date || new Date(v.next.claimed_at * 1000).toISOString().slice(0, 10) });
      }
      const tx = await send(net.escrow, claimData(v.ref, c));
      led.claims.push({ at: t, order: v.order, event });
      await saveLedger(led);
      return { order: v.order, claim: event, tx, next: "the store has its window to answer; follow the order with order_status" };
    },

    /** What the escrow is waiting from the buyer: the store emails the Worker lists, or the owner's proof. */
    async submitEvidence(n) {
      const v = await order(n);
      mine(v);
      const action = v.next?.action;
      if (action === "submit") {
        const txs = [];
        for (const s of v.next.submissions) txs.push(await send(net.escrow, submitData(v.ref, s)));
        return { order: v.order, registered_emails: txs.length, transactions: txs };
      }
      if (action === "proof" || action === "closing") {
        const a = await askOwner({ kind: "proof", order: v.order, closing: action === "closing", proof_kinds: PROOF_KINDS });
        if (!a?.approved || !a.proof) no(`the owner gave no proof for ${v.order}`);
        if (!PROOF_KINDS.includes(a.proof.kind) || !String(a.proof.text || "").trim()) no("the owner's proof needs a kind and its text");
        const text = cj({ party: "buyer", kind: action === "closing" ? "closing_proof" : "proof", content: { proof_kind: a.proof.kind, proof: String(a.proof.text).trim() } });
        return { order: v.order, proof_sent: true, tx: await send(net.escrow, submitData(v.ref, text)) };
      }
      no(`nothing to send for ${v.order} now (${action || "no action"})`);
    },

    /** The wallet's balance in the escrow to its own address. */
    async withdraw() {
      const left = BigInt(await call(net.escrow, "0x" + SEL.claimable + word(me) + word(net.usdc)));
      if (left === 0n) no("nothing to withdraw");
      return { withdrawn_usdc: Number(left) / 1e6, tx: await send(net.escrow, withdrawData(net.usdc)) };
    },

    /** The owner's rules and what is left of them. */
    rulesStatus() {
      const t = now();
      return { wallet: signer.address, max_per_order_usdc: rules.max_per_order_units / 1e6, max_per_day_usdc: rules.max_per_day_units / 1e6, spent_today_usdc: spentToday(led, t) / 1e6,
        left_today_usdc: Math.max(0, rules.max_per_day_units - spentToday(led, t)) / 1e6, max_claims_per_week: rules.max_claims_per_week, claims_this_week: claimsThisWeek(led, t), claims: rules.claims };
    },
  };
}
