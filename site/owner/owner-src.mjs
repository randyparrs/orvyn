// The owner's panel (site/owner/): one owner, one agent. Built into owner.js (node site/owner/build.mjs) with aa/approval.mjs, the
// same approval code as aa/owner.mjs. It holds no key and reads public sources only: Tenet Pay's gateway API, Arc testnet (its
// public RPC, or the wallet's provider on Arc if a blocker cuts it) and Arc's explorer API. The day's approval (approvals.json) and
// the owner's MCP rules (rules.json) are kept in this browser only, when the owner approves here or loads the files.
// Every read waits 15 s at most; a request that needs the person (connect, signatures) waits for them, with a visible note.
import { createPublicClient, custom, defineChain, fallback, http, isAddress } from "viem";
import { approvalFile, dayLimits, limitsInWords, ownerAccountAddress, GAS_USDC, MAX_PER_ORDER_USDC } from "../../aa/approval.mjs";
import { TESTNET } from "../../sdk/index.js";

export const WAIT = { read: 15000, person: 120000 };
const RPC = TESTNET.rpc, GATEWAY = TESTNET.api, ESCROW = TESTNET.escrow, USDC = TESTNET.usdc;
const EXPLORER = "https://explorer.testnet.arc.io", EXPLORER_API = EXPLORER + "/api/v2", SCAN = "https://scan.bradbury.genlayer.com";
const MY_ORDERS = "https://paytenet.site/orders/#/orders/";
const ARC = { chainId: "0x4cef52", chainName: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: [RPC],
  blockExplorerUrls: [EXPLORER] };
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: ARC.nativeCurrency, rpcUrls: { default: { http: [RPC] } } });
const REVIEW_FOR = 600;
const DAY = 86400;
const STATUSES = ["Opened", "Waiting for the store", "With the judge", "Proof asked", "Final verdict", "Settled", "Withdrawn"];
const TYPE_NAME = { late: "Arrived late", not_delivered: "Not delivered", not_as_described: "Not as described" };
const MODE_NAME = { auto: "alone", ask_owner: "asks the owner", never: "never" };
const KEY_PILL = { none: "pill-none", active: "pill-active", expired: "pill-expired", "used up": "pill-used" };
const STORE_APPROVAL = (account) => "orvyn-owner-approval:" + String(account).toLowerCase();
const STORE_RULES = "orvyn-owner-rules";

/** p, or an error that names what did not answer in ms. */
export function inTime(p, what, ms = WAIT.read) {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms); })])
    .finally(() => clearTimeout(t));
}
const PERSON = new Set(["eth_requestAccounts", "wallet_switchEthereumChain", "wallet_addEthereumChain"]);
const SIGN = /^eth_signTypedData/;
/** The wallet with time limits: reads 15 s; requests that wait for the person 2 minutes; signatures without a limit, counted. */
function timedWallet(eth, onSign) {
  return { request(a) {
    if (SIGN.test(a.method)) { onSign("asked"); return eth.request(a).then((r) => { onSign("signed"); return r; }); }
    return inTime(eth.request(a), "Your wallet", PERSON.has(a.method) ? WAIT.person : WAIT.read);
  } };
}
/** Arc: the public RPC first; if it fails or does not answer in time, the wallet's provider on Arc (also time limited). */
const arcClient = (wallet) => createPublicClient({ chain, transport: fallback([http(RPC, { timeout: WAIT.read, retryCount: 0 }), custom(wallet, { retryCount: 0 })], { retryCount: 0 }) });
async function getJson(url, what) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const r = await inTime(fetch(url, { signal: ctl?.signal, cache: "no-store" }), what).catch((e) => { ctl?.abort(); throw e; });
  if (!r.ok) throw new Error(`${what} answered ${r.status}`);
  return r.json();
}

// ---- formatting ---------------------------------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (s) => esc(s).replace(/`([^`]+)`/g, '<code class="code">$1</code>').replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
const pad = (n) => (n < 10 ? "0" : "") + n;
const utc = (s) => (s ? new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");
const hm = (s) => (s ? new Date(s * 1000).toISOString().slice(11, 16) : "");
const usd = (units, d = 2) => (Number(units) / 1e6).toFixed(d);
const short = (h) => (h ? String(h).slice(0, 10) + "..." + String(h).slice(-4) : "");
const shortAddr = (a) => (a ? String(a).slice(0, 8) + "..." + String(a).slice(-4) : "");
const txLink = (tx, net = "arc") => (tx ? `<a class="chip" href="${esc((net === "arc" ? EXPLORER + "/tx/" : SCAN + "/tx/") + tx)}" target="_blank" rel="noopener noreferrer">${esc(short(tx))}</a>` : "");
const now = () => Math.floor(Date.now() / 1000);
const $ = (sel) => document.querySelector(sel);
const store = {
  get(k) { try { const v = window.localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* the panel works without it */ } },
};

// ---- state --------------------------------------------------------------------------------------------------------
const S = {
  owner: "", account: "", eth: null, pub: null, approval: null, rules: null, data: null, errors: [], wait: "", busy: false,
  range: "today", claimOpen: {},
  ap: { step: 0, keyAddr: "", maxUsdc: 1, orders: 2, review: null, sigs: 0, done: null, signing: false },
};

/** An approvals.json the owner loads or signed here: checked, and only for the account the wallet opens. */
export function checkApproval(a, account) {
  const ok = a && isAddress(a.account || "") && isAddress(a.session_address || "") && !Number.isNaN(Date.parse(a.valid_until))
    && Number.isInteger(a.orders) && a.max_per_order_usdc > 0 && typeof a.pay === "string" && typeof a.claims === "string";
  if (!ok) throw new Error("That file is not an Orvyn approval (approvals.json).");
  if (account && a.account.toLowerCase() !== account.toLowerCase()) throw new Error(`That approval is for account ${a.account}, not the account your wallet opens (${account}).`);
  return a;
}
/** A rules.json for Orvyn's MCP, read only. */
export function checkRules(r) {
  const ok = r && typeof r.max_claims_per_week === "number" && r.claims && ["late", "not_delivered", "not_as_described"].every((k) => r.claims[k] in MODE_NAME);
  if (!ok) throw new Error("That file is not Orvyn's rules file (rules.json).");
  return r;
}
/** The key's window and state from its approval and the orders the account paid in it. */
export function keyState(approval, paidAts, t = now()) {
  if (!approval) return { state: "none", used: 0, max: 0 };
  const until = Math.floor(Date.parse(approval.valid_until) / 1000), from = until - DAY;
  const used = paidAts.filter((p) => p >= from && p < until).length;
  const state = t >= until ? "expired" : used >= approval.orders ? "used up" : "active";
  return { state, used, max: approval.orders, from, until };
}
/** Which settled refunds still wait in the escrow: the newest ones that add up to the account's claimable balance (as My orders). */
export function waitingRefunds(orders, claimable) {
  const refunds = orders.filter((o) => o.settled && o.settled.refund > 0).sort((a, b) => b.settled.at - a.settled.at);
  const waiting = new Set();
  let left = BigInt(claimable);
  for (const o of refunds) { if (left <= 0n) break; waiting.add(o.order); left -= BigInt(o.settled.refund); }
  return waiting;
}
/** A claim's place in STATUSES, from the gateway's order view. */
export function claimStatus(v, waiting) {
  const final = (v.steps || []).find((s) => s.final);
  if (v.settled) return v.settled.refund > 0 && !waiting.has(v.order) ? 6 : 5;
  if (final) return 4;
  if (v.proof_requested_at) return 3;
  if ((v.steps || []).length) return 2;
  return v.claim && v.claim.judge === "subjective" ? 1 : 0;
}
/** The steps of a claim, from the gateway's events: one line per transaction. */
export function claimSteps(v) {
  const out = [], seen = new Map();
  for (const e of v.events || []) {
    if (!/Claim opened|Registered|Store answered|No-response|final:|Proof requested|Verdict proposed on Arc|Settled on Arc/.test(e.what)) continue;
    if (e.tx && seen.has(e.tx)) { seen.get(e.tx).count++; continue; }
    const row = { t: hm(e.at), at: e.at, what: e.what, tx: e.tx || "", net: e.net || "arc", count: 1 };
    if (e.tx) seen.set(e.tx, row);
    out.push(row);
  }
  const records = (v.mails || []).filter((m) => m.record != null).map((m) => m.record);
  return out.map((r) => {
    let title = r.what, note = "";
    if (/Registered: evidence/.test(r.what)) {
      title = r.count > 1 ? `${r.count} store emails registered in one transaction` : "Store email registered";
      if (records.length) note = `verified on Lacre as record${records.length > 1 ? "s" : ""} ${records.join(", ")}`;
    } else if (/final:/.test(r.what)) title = "Judge on GenLayer: " + r.what.replace(/^Step \d+ final: /, "") + ", final";
    else if (/Settled on Arc/.test(r.what)) title = "Settled on Arc";
    return { ...r, title, note };
  });
}

// ---- reading ------------------------------------------------------------------------------------------------------
async function load() {
  const errors = [], data = { orders: [], withdrawals: [], ops: [], creation: null, balance: null, code: null, claimable: 0n };
  const tries = [
    (async () => { data.code = (await S.pub.getCode({ address: S.account })) || "0x"; })().catch((e) => errors.push("Arc testnet (the account): " + e.message)),
    (async () => { data.balance = await S.pub.getBalance({ address: S.account }); })().catch((e) => errors.push("Arc testnet (the balance): " + e.message)),
    (async () => {
      const r = await S.pub.call({ to: ESCROW, data: "0xd4570c1c" + S.account.slice(2).toLowerCase().padStart(64, "0") + USDC.slice(2).toLowerCase().padStart(64, "0") });
      data.claimable = BigInt(r.data || "0x0");
    })().catch((e) => errors.push("Arc testnet (the escrow): " + e.message)),
    (async () => {
      const l = await getJson(`${GATEWAY}/api/orders?buyer=${S.account}`, "Tenet Pay's gateway");
      data.withdrawals = l.withdrawals || [];
      data.orders = await Promise.all((l.orders || []).map((o) => getJson(`${GATEWAY}/api/orders/${encodeURIComponent(o.order)}`, "Tenet Pay's gateway")));
    })().catch((e) => errors.push(e.message)),
    (async () => {
      const ops = await getJson(`${EXPLORER_API}/proxy/account-abstraction/operations?sender=${S.account}`, "Arc's explorer");
      data.ops = (ops.items || []).map((o) => ({ at: Math.floor(Date.parse(o.timestamp) / 1000), fee: BigInt(o.fee || "0"), tx: o.transaction_hash }));
      const acc = await getJson(`${EXPLORER_API}/proxy/account-abstraction/accounts/${S.account}`, "Arc's explorer").catch(() => null);
      data.creation = acc && acc.creation_timestamp ? Math.floor(Date.parse(acc.creation_timestamp) / 1000) : null;
    })().catch((e) => { data.ops = null; errors.push(e.message); }),
  ];
  await Promise.all(tries);
  S.data = data;
  S.errors = errors;
}

// ---- rendering ----------------------------------------------------------------------------------------------------
function tile(label, body, source) {
  return `<div class="tile"><span class="label">${esc(label)}</span>${body}<span class="mono-src push">${esc(source)}</span></div>`;
}
function paidAts() { return (S.data?.orders || []).filter((o) => o.paid && o.paid_at).map((o) => o.paid_at); }

function renderWallet() {
  const area = $("#wallet-area"), on = !!S.account;
  area.innerHTML = on
    ? `<div id="wallet-chip" class="wallet-chip" title="${esc(S.owner)}"><span class="wallet-net"><span class="dot"></span>Arc Testnet</span><span class="wallet-sep"></span><span class="wallet-addr">${esc(shortAddr(S.owner))}</span></div>`
    : `<button id="connect-wallet-header" class="btn btn-primary btn-pill" type="button" data-action="connect"${S.busy ? " disabled" : ""}>Connect wallet</button>`;
  $("#connect").hidden = on;
  $("#dashboard").hidden = !on;
  $("#side").hidden = !on;
  $("#nav-mobile").classList.toggle("is-on", on);
  $("#connect-wallet").disabled = S.busy;
  const err = $("#panel-error");
  err.hidden = !S.errors.length;
  err.textContent = S.errors.length ? "Not everything could be read: " + S.errors.join("; ") + "." : "";
  const wait = $("#panel-wait");
  wait.hidden = !S.wait;
  wait.textContent = S.wait;
}

function renderAgent() {
  const d = S.data || {}, k = keyState(S.approval, paidAts()), a = S.approval;
  const pill = $("#key-state");
  pill.className = "pill " + KEY_PILL[k.state];
  pill.textContent = { none: "No key", active: "Key active", expired: "Key expired", "used up": "Key used up" }[k.state];
  $("#key-sentence").textContent = k.state === "none" ? "No key approved in this browser. Approve today's key, or load approvals.json."
    : k.state === "active" ? `Key active until ${utc(k.until)}.`
    : k.state === "expired" ? `Key expired at ${utc(k.until)}.`
    : `Key used up: all orders of the day paid, ${k.used} of ${k.max}.`;
  $("#approve-cta").hidden = !(k.state === "none" || k.state === "expired");
  const deployed = d.code && d.code !== "0x";
  const pct = k.max ? Math.round((100 * k.used) / k.max) : 0;
  $("#agent-tiles").innerHTML =
    tile("Agent's account", `<span class="value-mono">${esc(S.account)}</span>`, "computed from the owner's wallet (Kernel account, index 0)") +
    tile("Deployed", d.code == null ? '<span class="value-lg">?</span><span class="text-sm">could not be read</span>'
      : `<span class="value-lg">${deployed ? "Yes" : "No"}</span><span class="text-sm">${deployed ? (d.creation ? "by its first UserOp, " + esc(utc(d.creation)) : "by its first UserOp") : "its first UserOp deploys it"}</span>`,
      "Arc: account code" + (d.creation ? " · explorer" : "")) +
    tile("Balance", d.balance == null ? '<span class="value-lg">?</span><span class="text-sm">could not be read</span>'
      : `<span class="value-row"><span class="value-lg">${(Number(d.balance) / 1e18).toFixed(2)} USDC</span><span class="value-exact">${(Number(d.balance) / 1e18).toFixed(4)}</span></span>`, "Arc: balance") +
    tile("Active session key", `<span class="value-mono">${esc(a ? a.session_address : "None")}</span>`, "the day's approval, in this browser") +
    tile("Valid until", `<span class="value-mono">${esc(a ? utc(k.until) : "No key")}</span><span class="text-sm">${esc(!a ? "Approve today's key." : k.state === "expired" ? "Expired. Approve today's key." : "24 hours from " + utc(k.from))}</span>`, "the approval") +
    tile("Orders used", `<span class="value-lg">${esc(a ? `${k.used} of ${k.max}` : "No key")}</span><span class="bar"><span style="width:${pct}%"></span></span>`, "gateway: orders paid by the account since the key's start");
}

function renderLimits() {
  const a = S.approval, r = S.rules;
  const rows = [
    ["orders", a ? `Up to **${a.orders} ${a.orders === 1 ? "order" : "orders"}** in the day, each up to **${a.max_per_order_usdc.toFixed(2)} USDC**: at most **${(a.orders * a.max_per_order_usdc).toFixed(2)} USDC** in the day.`
      : "Approve today's key, or load approvals.json, to see its orders and amounts."],
    ["spender", `Only into Tenet Pay's escrow \`${ESCROW}\`: no transfers, no other spender, no native value.`],
    ["escrow", "Claims, evidence and withdrawals only on that escrow."],
    ["gas", a ? `**${a.gas_usdc.toFixed(2)} USDC** for payments and **${a.gas_usdc.toFixed(2)} USDC** for claims.` : `Up to **${GAS_USDC.toFixed(2)} USDC** for payments and the same for claims, on each key.`],
    ["key", "The key ends **24 hours** after it is approved; a new key each day, so unused days never add up."],
  ].map(([l, t]) => `<div class="limit-row"><span class="limit-label">${esc(l)}</span><span class="limit-text">${fmt(t)}</span></div>`).join("");
  const mcp = r
    ? `<div class="limit-row"><span class="limit-label">claims</span><span class="limit-text">Claims a week: <b>${esc(r.max_claims_per_week)}</b>.</span></div>` +
      `<div class="limit-row"><span class="limit-label">types</span><div class="rule-list">${["late", "not_delivered", "not_as_described"].map((t) =>
        `<div class="rule"><span>${esc(TYPE_NAME[t].toLowerCase())}</span><b>${esc(MODE_NAME[r.claims[t]])}</b></div>`).join("")}<span class="text-sm">For "not as described", the owner gives the proof.</span></div></div>`
    : `<div class="limit-row"><span class="limit-label">rules</span><span class="limit-text">Load rules.json to see the rules the MCP applies. It is read in this browser only.</span></div>`;
  $("#limits-grid").innerHTML =
    `<div id="limits-onchain" class="card"><div class="limit-head"><span class="limit-title"><span class="glyph glyph-square"></span>On chain</span><span class="limit-sub">The session key's policies; the agent cannot pass them even if its software fails.</span></div><div class="limit-rows">${rows}</div></div>` +
    `<div id="limits-mcp" class="card"><div class="limit-head"><span class="limit-kind"><span class="limit-title"><span class="glyph glyph-circle"></span>In Orvyn's MCP</span><span class="tag">read only</span></span><span class="limit-sub">Rules in code, from the owner's rules file; checked before anything is signed.</span></div><div class="limit-rows">${mcp}</div></div>`;
}

function stat(id, label, value, unit, extra, source) {
  return `<div id="${id}" class="card stat"><span class="label">${esc(label)}</span><span class="stat-value"><b>${esc(value)}</b><span>${esc(unit)}</span></span>${extra || ""}<span class="mono-src push">${esc(source)}</span></div>`;
}
function renderSpent() {
  const d = S.data || { orders: [], ops: [] }, t = now(), k = keyState(S.approval, paidAts(), t);
  const inKey = k.state === "active" || k.state === "used up";
  const todayFrom = inKey ? k.from : t - DAY;
  const paid = d.orders.filter((o) => o.paid && o.paid_at).sort((a, b) => b.paid_at - a.paid_at);
  const today = paid.filter((o) => o.paid_at >= todayFrom), week = paid.filter((o) => o.paid_at >= t - 7 * DAY);
  const sum = (l) => l.reduce((n, o) => n + o.amount_cents, 0) / 100;
  const cap = S.approval ? S.approval.orders * S.approval.max_per_order_usdc : 0;
  const pct = cap ? Math.min(100, Math.round((100 * sum(today)) / cap)) : 0;
  const ops = d.ops ? d.ops.filter((o) => o.at >= t - 7 * DAY) : null;
  const gas = ops ? ops.reduce((n, o) => n + o.fee, 0n) : null;
  const first = ops && d.creation ? ops.find((o) => o.at === d.creation) : null;
  $("#spent-stats").innerHTML =
    stat("stat-today", "Today", sum(today).toFixed(2), cap ? `of ${cap.toFixed(2)} USDC` : "USDC", cap ? `<span class="bar"><span style="width:${pct}%"></span></span>` : "", "gateway") +
    stat("stat-week", "Last 7 days", sum(week).toFixed(2), "USDC", "", "gateway") +
    stat("stat-gas", "Gas paid by the account", gas == null ? "?" : (Number(gas) / 1e18).toFixed(2), gas == null ? "could not be read" : `USDC · ${ops.length} UserOp${ops.length === 1 ? "" : "s"}`,
      first ? `<span class="text-sm">The first one also deployed the account, ${(Number(first.fee) / 1e18).toFixed(3)}.</span>` : "", "Arc explorer");
  ["today", "7d"].forEach((r) => $("#range-" + r).setAttribute("aria-selected", String(S.range === r)));
  const list = S.range === "today" ? today : week;
  $("#spent-rows").innerHTML = list.length ? list.map((o) => {
    const pay = (o.events || []).find((e) => /Paid into the escrow/.test(e.what));
    return `<div id="order-${esc(o.order)}" class="table-row spent-cols spent-row"><span class="cell-order"><span class="m-label">Order</span>${esc(o.order)}</span>` +
      `<span class="cell-text"><span class="m-label">Store</span>${esc(o.domain)}</span><span class="cell-amount"><span class="m-label">Amount</span>${(o.amount_cents / 100).toFixed(2)} USDC</span>` +
      `<span class="cell-mono"><span class="m-label">Paid</span>${esc(utc(o.paid_at))}</span><span><span class="m-label">Transaction</span>${txLink(pay && pay.tx)}</span></div>`;
  }).join("") : '<div class="empty-row">No orders in this period.</div>';
  $("#range-caption").textContent = (S.range === "today" ? "Today · " : "Last 7 days · ") + list.length + (list.length === 1 ? " order" : " orders");
  $("#range-total").textContent = S.range === "today" && cap ? `${sum(today).toFixed(2)} of ${cap.toFixed(2)} USDC` : `${sum(list).toFixed(2)} USDC`;
}

const AP_STEPS = [
  { label: "Connect", title: "The owner's wallet", text: "The owner's wallet is used to show which agent account it opens and to sign the day's approval. It is never asked to send a transaction." },
  { label: "Key address", title: "The agent's key address", text: "The address of the agent's session key. The panel holds no key: only the address is entered here." },
  { label: "Limits", title: "Limits for the day", text: "" },
  { label: "Review in words", title: "Review in words", text: "" },
  { label: "Sign", title: "Sign the approval", text: "Two EIP-712 \"Enable\" signatures in the owner's wallet. No gas, nothing sent." },
  { label: "Download", title: "Download approvals.json", text: "Both signatures are in. Download the approval as `approvals.json`. It holds no private key." },
];
const limitSummary = () => (limitsOk() ? [["at most in the day", (S.ap.maxUsdc * S.ap.orders).toFixed(2) + " USDC"], ["gas, payments", GAS_USDC.toFixed(2) + " USDC"],
  ["gas, claims", GAS_USDC.toFixed(2) + " USDC"], ["valid", "24 h"]].map(([l, v]) => `<div class="kv small"><span class="k">${esc(l)}</span><span class="v">${esc(v)}</span></div>`).join("")
  : `<span class="field-note">each order up to more than 0 and at most ${MAX_PER_ORDER_USDC} USDC</span>`);
const keyOk = () => isAddress(S.ap.keyAddr.trim()) && S.ap.keyAddr.trim().toLowerCase() !== S.owner.toLowerCase();
const limitsOk = () => S.ap.maxUsdc > 0 && S.ap.maxUsdc <= MAX_PER_ORDER_USDC && [1, 2].includes(S.ap.orders);
function renderApprove() {
  const ap = S.ap, cur = ap.done ? 6 : ap.step;
  $("#approve-steps").innerHTML = AP_STEPS.map((st, i) => {
    const cls = i === cur ? "is-current" : i < cur ? "is-past" : "", reach = i <= cur && !ap.done && !ap.signing && i < 4;
    return `<li><button id="approve-step-${i + 1}" class="step-btn ${cls}" type="button" data-action="goto" data-step="${i}"${reach ? "" : " disabled"}${i === cur ? ' aria-current="step"' : ""}><span class="step-num">${i < cur ? "✓" : pad(i + 1)}</span>${esc(st.label)}</button></li>`;
  }).join("");
  const count = ap.done ? "Done" : `Step ${ap.step + 1} of ${AP_STEPS.length}`;
  $("#approve-progress").innerHTML = `<div class="progress-bars">${AP_STEPS.map((_, i) => `<span class="${i <= cur ? "on" : ""}"></span>`).join("")}</div><span class="progress-count">${count}</span>`;
  let html = "", actions = "";
  if (ap.done) {
    const f = ap.done, until = Math.floor(Date.parse(f.valid_until) / 1000);
    html = `<div class="step-head"><span class="pill pill-approved" style="align-self:flex-start">Approved</span><h3 style="margin-top:6px">What was approved</h3></div>` +
      `<div class="kv-grid"><div class="kv"><span class="label">Key</span><span>${esc(f.session_address)}</span></div>` +
      `<div class="kv"><span class="label">For 24 hours</span><span>from ${esc(utc(until - DAY))}<br>to ${esc(utc(until))}</span></div>` +
      `<div class="kv"><span class="label">Limits</span><span>${fmt(`${f.orders} ${f.orders === 1 ? "order" : "orders"}, each up to **${f.max_per_order_usdc.toFixed(2)} USDC**\ngas **${f.gas_usdc}** + **${f.gas_usdc} USDC**`)}</span></div></div>` +
      `<div class="file-block"><span class="file-title">Where to put the file</span><p class="step-text">${fmt("Put `approvals.json` on the agent's machine, where Orvyn's MCP server reads it (`ORVYN_APPROVALS`). It holds your limits and your signatures, and no key.")}</p></div>`;
    actions = `<button id="approve-download" class="btn btn-secondary" type="button" data-action="download">Download again</button><button id="approve-restart" class="btn btn-secondary" type="button" data-action="restart">Start again</button>`;
  } else {
    const st = AP_STEPS[ap.step];
    html = `<div class="step-head"><span class="step-count">${count}</span><h3>${esc(st.title)}</h3></div>` + (st.text ? `<p class="step-text">${fmt(st.text)}</p>` : "");
    if (ap.step === 0) {
      html += `<div class="kv-grid"><div class="kv"><span class="label">Owner's wallet</span><span>${esc(S.owner)}</span></div><div class="kv"><span class="label">Agent's account</span><span>${esc(S.account)}</span></div><div class="kv"><span class="label">Network</span><span style="display:inline-flex;align-items:center;gap:8px"><span class="dot"></span>Arc Testnet</span></div></div>`;
    } else if (ap.step === 1) {
      const ok = keyOk();
      html += `<label class="field" for="key-address"><span class="label">Key address</span><input id="key-address" class="input" type="text" spellcheck="false" autocomplete="off" value="${esc(ap.keyAddr)}"></label>` +
        `<span id="key-address-note" class="field-note${ok ? " ok" : ""}">${ok ? "address format ok" : isAddress(ap.keyAddr.trim()) ? "that is your own wallet: enter the agent's key" : "enter a 0x address, 40 hex characters"}</span>`;
    } else if (ap.step === 2) {
      html += `<div class="kv-grid"><label class="field" for="limit-max"><span class="label">Each order up to, USDC (up to ${MAX_PER_ORDER_USDC})</span><input id="limit-max" class="input" type="number" min="0.01" max="${MAX_PER_ORDER_USDC}" step="0.01" value="${esc(ap.maxUsdc)}"></label>` +
        `<label class="field" for="limit-orders"><span class="label">Orders in the day</span><select id="limit-orders" class="input"><option value="1"${ap.orders === 1 ? " selected" : ""}>1</option><option value="2"${ap.orders === 2 ? " selected" : ""}>2</option></select></label></div>` +
        `<div id="limit-summary" class="kv-grid dense">${limitSummary()}</div>` +
        `<span class="escrow-line">only into Tenet Pay's escrow ${esc(ESCROW)}</span>`;
    } else if (ap.step === 3) {
      html += `<div id="review-text" class="codeblock"><div class="codeblock-head"><span>review</span></div><div class="codeblock-body">${ap.review.words.map((l) => `<span>${esc(l)}</span>`).join("")}</div></div>`;
    } else if (ap.step === 4) {
      html += `<div class="kv-grid">${[1, 2].map((n) => { const on = ap.sigs >= n; return `<div id="signature-${n}" class="sig${on ? " signed" : ""}"><span>Enable ${n} of 2</span><span class="sig-state">${on ? "SIGNED" : ap.signing && ap.sigs === n - 1 ? "IN YOUR WALLET" : "WAITING"}</span></div>`; }).join("")}</div>`;
    }
    if (ap.step > 0 && !ap.signing) actions += `<button id="approve-back" class="btn btn-secondary" type="button" data-action="back">Back</button>`;
    if (ap.step === 4) actions += `<button id="approve-sign" class="btn btn-primary" type="button" data-action="sign"${ap.signing ? " disabled" : ""}>${ap.signing ? "Waiting for your wallet" : "Sign the approval (2 signatures)"}</button>`;
    else if (ap.step < 4) {
      const blocked = (ap.step === 1 && !keyOk()) || (ap.step === 2 && !limitsOk());
      actions += `<button id="approve-next" class="btn btn-primary" type="button" data-action="next"${blocked ? ' disabled style="opacity:.4;cursor:default"' : ""}>Next<span aria-hidden="true">→</span></button>`;
    }
  }
  $("#approve-content").innerHTML = html;
  $("#approve-actions").innerHTML = actions;
}

function renderClaims() {
  const d = S.data || { orders: [] }, waiting = waitingRefunds(d.orders, d.claimable || 0n);
  const claims = d.orders.filter((o) => o.claim).sort((a, b) => b.claim.at - a.claim.at);
  if (!claims.length) { $("#claims-list").innerHTML = '<div class="card"><div class="empty-row">No claims on this account.</div></div>'; return; }
  $("#claims-list").innerHTML = claims.map((v) => {
    const cs = claimStatus(v, waiting), id = esc(v.order), open = S.claimOpen[v.order] !== false;
    const final = (v.steps || []).map((s) => s.final).filter(Boolean).pop();
    const statusText = cs === 6 ? "Settled, withdrawn" : STATUSES[cs];
    const by = S.rules ? (S.rules.claims[v.claim.event] === "auto" ? "by the agent alone" : S.rules.claims[v.claim.event] === "ask_owner" ? "with the owner's OK" : "") : "";
    const verdict = final
      ? `<span class="verdict"><span class="verdict-pill">${esc(final.outcome)}</span><span class="verdict-amount">${esc((final.refund_cents / 100).toFixed(2))} USDC</span></span><span class="mono-src">${esc(final.reason)}${v.settled ? `; ${usd(v.settled.released)} to the store` : ""}</span>`
      : '<span class="cell-mono" style="color:#8a93a3">no verdict yet</span>';
    const chip = `<span class="status-chip"><span class="dot"></span>${esc(statusText)}</span>`;
    const needsStore = v.claim.judge === "subjective";
    const track = STATUSES.map((label, i) => {
      const skip = (i === 3 && cs > 3 && !v.proof_requested_at) || (i === 1 && !needsStore && cs > 1);
      const cls = skip ? "" : i < cs ? "done" : i === cs ? "current" : "";
      return `<li class="${cls}"><span class="track-mark"></span><span class="track-label">${esc(label)}</span><span class="track-note">${skip ? "not asked" : i === cs ? "now" : ""}</span></li>`;
    }).join("");
    const steps = claimSteps(v).map((s) => `<li><span class="tl-time">${esc(s.t)}</span><span class="tl-rail"></span><span class="tl-body"><span class="tl-title">${esc(s.title)}</span>${s.note ? `<span class="tl-note">${esc(s.note)}</span>` : ""}${txLink(s.tx, s.net === "bradbury" ? "genlayer" : "arc")}</span></li>`).join("")
      + (cs === 6 ? (d.withdrawals || []).filter((w) => v.settled && w.at >= v.settled.at).slice(0, 1).map((w) => `<li><span class="tl-time">${esc(hm(w.at))}</span><span class="tl-rail"></span><span class="tl-body"><span class="tl-title">Withdrawn to the agent's account</span>${txLink(w.tx)}</span></li>`).join("") : "");
    const link = MY_ORDERS + encodeURIComponent(v.order);
    return `<div id="claim-${id}" class="card claims-table">` +
      `<div class="table-head claim-cols"><span>Order</span><span>Type</span><span>Opened</span><span>Status</span><span>Result</span><span>Link</span></div>` +
      `<div class="table-row claim-cols claim-row"><span class="cell-order" style="line-height:1.5">${id}</span><span class="cell-text" style="line-height:1.5">${esc(TYPE_NAME[v.claim.event] || v.claim.event)}</span>` +
      `<span class="stack"><span class="cell-mono" style="line-height:1.5">${esc(utc(v.claim.at))}</span>${by ? `<span class="text-sm" style="color:#5a6578">${esc(by)}</span>` : ""}</span>` +
      `<span>${chip}</span><span class="stack-6">${verdict}</span><a id="claim-link-${id}" class="link" href="${esc(link)}">My orders ↗</a></div>` +
      `<div class="claim-card"><div class="claim-card-top"><span class="cell-order">${id}</span>${chip}</div><span class="cell-text">${esc(TYPE_NAME[v.claim.event] || v.claim.event)} · <span class="cell-mono" style="color:#5a6578">${esc(utc(v.claim.at))}${by ? ", " + esc(by) : ""}</span></span><span class="stack-6">${verdict}</span><a id="claim-link-m-${id}" class="link" href="${esc(link)}">My orders ↗</a></div>` +
      (cs === 3 ? '<div id="proof-waiting" class="notice">The judge asked for proof. The agent\'s client asks the owner for it.</div>' : "") +
      `<button id="claim-toggle-${id}" class="toggle" type="button" data-action="toggle-claim" data-order="${id}" aria-expanded="${open}"><span>${open ? "Hide the steps of this claim" : "Show the steps of this claim"}</span><span class="toggle-icon">${open ? "↑" : "↓"}</span></button>` +
      (open ? `<div class="detail"><div class="tile"><span class="mono-src">status</span><ol class="track">${track}</ol></div><div class="tile"><span class="mono-src">steps · UTC</span><ol class="timeline">${steps}</ol></div></div>` : "") +
      `</div>`;
  }).join("");
}

function renderBalance() {
  const d = S.data || { orders: [], claimable: 0n }, waiting = waitingRefunds(d.orders, d.claimable || 0n);
  const from = d.orders.filter((o) => waiting.has(o.order));
  $("#balance-grid").innerHTML =
    `<div id="balance-amount" class="card"><span class="label">Waiting in the escrow</span><span class="value-xl">${usd(d.claimable || 0n)} USDC</span><span class="mono-src push">Arc: escrow claimable</span></div>` +
    `<div id="balance-orders" class="card"><span class="label">From orders</span>${from.length ? from.map((o) => `<span class="cell-mono">${esc(o.order)} · ${usd(o.settled.refund)} USDC</span>`).join("") : '<span class="muted-text">No refunds waiting.</span>'}` +
    `<span class="body-text push">The withdrawal is the agent's, through the MCP (its claims permission).</span></div>`;
}

export function render() {
  renderWallet();
  if (!S.account) return;
  renderAgent(); renderLimits(); renderSpent(); renderApprove(); renderClaims(); renderBalance();
}

// ---- actions ------------------------------------------------------------------------------------------------------
async function connect() {
  const eth = window.ethereum;
  if (!eth) { S.errors = ["No browser wallet found. Open this page in a browser with a wallet such as MetaMask or Rabby."]; render(); return; }
  S.busy = true; S.errors = []; S.wait = "Waiting for your wallet: allow this page to see your address."; render();
  try {
    S.eth = timedWallet(eth, onSign);
    const [address] = await S.eth.request({ method: "eth_requestAccounts" });
    if (!address) throw new Error("Your wallet gave no address.");
    const id = await S.eth.request({ method: "eth_chainId" });
    if (String(id).toLowerCase() !== ARC.chainId) {
      S.wait = "Waiting for your wallet: switch to Arc Testnet."; render();
      try { await S.eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.chainId }] }); }
      catch (e) { if (e && e.code === 4902) await S.eth.request({ method: "wallet_addEthereumChain", params: [ARC] }); else throw e; }
    }
    S.pub = arcClient(S.eth);
    S.wait = "Reading Arc testnet and Tenet Pay.";
    render();
    S.owner = address;
    S.account = await ownerAccountAddress(S.pub, S.eth).catch((e) => {
      throw new Error(`Arc testnet could not be read (${e.shortMessage || e.message}). A blocker in the browser may be blocking rpc.testnet.arc.io; allow that address, or check that your wallet is on Arc Testnet.`);
    });
    const saved = store.get(STORE_APPROVAL(S.account));
    try { S.approval = saved ? checkApproval(saved, S.account) : null; } catch { S.approval = null; }
    const rules = store.get(STORE_RULES);
    try { S.rules = rules ? checkRules(rules) : null; } catch { S.rules = null; }
    await load();
    S.ap.step = 1;
  } catch (e) {
    S.errors = [String(e.shortMessage || e.message || e).slice(0, 400)];
  } finally {
    S.busy = false; S.wait = ""; render();
  }
}
function onSign(what) {
  if (what === "signed") S.ap.sigs = Math.min(2, S.ap.sigs + 1);
  render();
}
function review() {
  const ap = S.ap, t = now();
  ap.review = { now: t, keyAddr: ap.keyAddr.trim(), maxUsdc: ap.maxUsdc, orders: ap.orders, words: limitsInWords(dayLimits(t, ap.maxUsdc, ap.orders), ap.keyAddr.trim()) };
}
function download(file) {
  const blob = new Blob([JSON.stringify(file, null, 1) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "approvals.json";
  document.body.appendChild(a); a.click(); a.remove();
}
async function sign() {
  const ap = S.ap, r = ap.review;
  if (!r || r.keyAddr !== ap.keyAddr.trim() || r.maxUsdc !== ap.maxUsdc || r.orders !== ap.orders || now() - r.now > REVIEW_FOR) {
    review(); ap.step = 3; S.errors = ["The review was old or the limits changed: check them again, then sign."]; render(); return;
  }
  ap.signing = true; ap.sigs = 0; S.errors = []; S.wait = "Waiting for your wallet: two signatures, Enable 1 of 2 and 2 of 2."; render();
  try {
    const file = await approvalFile(S.pub, { owner: S.eth, sessionAddress: r.keyAddr, now: r.now, maxUsdc: r.maxUsdc, orders: r.orders });
    checkApproval(file, S.account);
    ap.done = file; S.approval = file; store.set(STORE_APPROVAL(S.account), file);
    download(file);
  } catch (e) {
    S.errors = [String(e.shortMessage || e.message || e).slice(0, 400)];
  } finally {
    ap.signing = false; S.wait = ""; render();
  }
}
function readFile(input, then) {
  const f = input.files && input.files[0];
  if (!f) return;
  f.text().then((txt) => { try { then(JSON.parse(txt)); S.errors = []; } catch (e) { S.errors = [e.message]; } input.value = ""; render(); });
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t || t.disabled) return;
  const ap = S.ap;
  switch (t.getAttribute("data-action")) {
    case "connect": connect(); break;
    case "range": S.range = t.getAttribute("data-range"); renderSpent(); break;
    case "goto": ap.step = +t.getAttribute("data-step"); renderApprove(); break;
    case "next": if (ap.step === 2) review(); ap.step = Math.min(4, ap.step + 1); renderApprove(); break;
    case "back": ap.step = Math.max(0, ap.step - 1); renderApprove(); break;
    case "sign": sign(); break;
    case "download": if (ap.done) download(ap.done); break;
    case "restart": Object.assign(ap, { step: 1, sigs: 0, done: null, review: null }); renderApprove(); break;
    case "toggle-claim": { const o = t.getAttribute("data-order"); S.claimOpen[o] = S.claimOpen[o] === false; renderClaims(); break; }
    case "load-approval": $("#approval-file").click(); break;
    case "load-rules": $("#rules-file").click(); break;
  }
});
document.addEventListener("input", (e) => {
  const ap = S.ap, id = e.target.id;
  if (id === "key-address") {
    ap.keyAddr = e.target.value;
    const ok = keyOk(), note = $("#key-address-note"), next = $("#approve-next");
    note.textContent = ok ? "address format ok" : isAddress(ap.keyAddr.trim()) ? "that is your own wallet: enter the agent's key" : "enter a 0x address, 40 hex characters";
    note.classList.toggle("ok", ok);
    if (next) { next.disabled = !ok; next.style.opacity = ok ? "" : ".4"; next.style.cursor = ok ? "" : "default"; }
  } else if (id === "limit-max") {
    // the field keeps what is typed; only the summary and the Next button follow
    ap.maxUsdc = Number(e.target.value); ap.review = null;
    $("#limit-summary").innerHTML = limitSummary();
    const next = $("#approve-next"), ok = limitsOk();
    if (next) { next.disabled = !ok; next.style.opacity = ok ? "" : ".4"; next.style.cursor = ok ? "" : "default"; }
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "limit-orders") { S.ap.orders = Number(e.target.value); S.ap.review = null; renderApprove(); }
  if (e.target.id === "approval-file") readFile(e.target, (j) => { S.approval = checkApproval(j, S.account); store.set(STORE_APPROVAL(S.account), S.approval); });
  if (e.target.id === "rules-file") readFile(e.target, (j) => { S.rules = checkRules(j); store.set(STORE_RULES, S.rules); });
});

window.OrvynOwner = { state: S, render, reload: async () => { await load(); render(); } };
render();
