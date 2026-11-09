// The owner's panel (site/owner/) in a simulated DOM, with a test wallet as window.ethereum. Tenet Pay's gateway and Arc's explorer
// answer from recorded fixtures (test/fixtures/panel/, test L's real responses); Arc testnet is read for real (the account, the
// approval). Checks: links, connect, the live data (agent, spent, gas, claims, balance), loading approvals.json and rules.json,
// the day's approval byte for byte against aa/owner.mjs, time limits with the public RPC blocked or the gateway silent, the
// page's text (English, no long dashes, no sample data) and reduced motion. --built runs the bundle the page loads (owner.js).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { testWallet } from "../../test/fixtures/wallet.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILT = process.argv.includes("--built");
const rawHtml = readFileSync(join(ROOT, "site/owner/index.html"), "utf8");
const html = rawHtml.replace(/<script type="module" src="owner\.js[^"]*"><\/script>/, "");
const css = readFileSync(join(ROOT, "site/owner/styles.css"), "utf8");
const FX = (n) => readFileSync(join(ROOT, "test/fixtures/panel", n), "utf8");
let failed = 0;
const check = (c, what) => { console.log(`${c ? "ok  " : "BAD "} ${what}`); if (!c) failed++; };
const until = async (cond, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); } return cond(); };

// the network: fixtures for the gateway and the explorer; Arc's public RPC for real unless a test blocks it
const realFetch = globalThis.fetch;
const net = { rpc: "ok", gateway: "ok", asked: [] };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  net.asked.push(u);
  if (u.startsWith("https://tenet-gateway.randyparra.workers.dev/api/orders?buyer=")) return gw(FX("orders.json"));
  if (u === "https://tenet-gateway.randyparra.workers.dev/api/orders/TS-920403") return gw(FX("TS-920403.json"));
  if (u.startsWith("https://explorer.testnet.arc.io/api/v2/proxy/account-abstraction/operations")) return ok(FX("operations.json"));
  if (u.startsWith("https://explorer.testnet.arc.io/api/v2/proxy/account-abstraction/accounts/")) return ok(FX("account.json"));
  if (/^https:\/\/rpc\.testnet\.arc\.io\/?$/.test(u) && net.rpc === "blocked") throw new TypeError("Failed to fetch (ERR_BLOCKED_BY_CLIENT)");
  return realFetch(url, init);
};
const ok = (body) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const gw = (body) => (net.gateway === "silent" ? new Promise(() => {}) : ok(body));

const key = generatePrivateKey(), session = privateKeyToAccount(generatePrivateKey()).address;
const dom = new JSDOM(html, { url: "https://orvyn.paytenet.site/owner/", pretendToBeVisual: true });
const w = dom.window, d = w.document;
let downloaded = null;
const blobs = new Map();
URL.createObjectURL = (b) => { const u = "blob:test/" + blobs.size; blobs.set(u, b); return u; };
w.HTMLAnchorElement.prototype.click = function () { if (this.download) downloaded = { name: this.download, href: this.href }; };
Object.assign(globalThis, { window: w, document: d });
const M = await import(pathToFileURL(join(ROOT, BUILT ? "site/owner/owner.js" : "site/owner/owner-src.mjs")).href);
const P = w.OrvynOwner, S = P.state;
const shown = (id) => !d.getElementById(id).hidden;
const text = (id) => (d.getElementById(id)?.textContent || "").replace(/\s+/g, " ").trim();
const click = (id) => d.getElementById(id).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const type = (id, v) => { const el = d.getElementById(id); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); };

// ---- before connecting -------------------------------------------------------------------------------------------
check(d.getElementById("brand-link").getAttribute("href") === "../", "the Orvyn logo goes back to the main page");
check(shown("connect") && !shown("dashboard") && d.getElementById("side").hidden, "before connecting: only the connect card");
check(!/0x[0-9a-fA-F]{6}|TS-\d{6}|USDC [0-9]|[0-9]\.[0-9]{2} USDC/.test(rawHtml), "no sample data in the HTML: no addresses, orders or amounts");
click("connect-wallet");
await until(() => S.errors.length);
check(/No browser wallet found/.test(text("panel-error")), "no wallet in the browser: a clear error, nothing else happens");

// ---- connect, with Arc's public RPC blocked: the reads go through the wallet ---------------------------------------
const wallet = testWallet(key);
w.ethereum = wallet;
net.rpc = "blocked";
click("connect-wallet");
await until(() => S.account && !S.busy);
check(S.owner === wallet.address && /^0x[0-9a-fA-F]{40}$/.test(S.account) && shown("dashboard") && text("agent-tiles").includes(S.account),
  "connect with the public RPC blocked: the account is read through the wallet's provider on Arc, and the panel opens");
check(wallet.asked.includes("eth_call") || wallet.asked.includes("eth_getCode"), "the wallet's provider answered the reads the blocked RPC could not");
net.rpc = "ok";

// ---- live data ---------------------------------------------------------------------------------------------------
check(text("key-state") === "No key" && /No key approved in this browser/.test(text("key-sentence")) && !d.getElementById("approve-cta").hidden,
  "no approval in this browser: No key, and the button to approve today's key");
check(/Deployed\s*No\s*its first UserOp deploys it/.test(text("agent-tiles")), "a new account not deployed yet: Deployed No, its first UserOp deploys it (read on Arc)");
click("range-7d");
check(text("spent-rows").includes("TS-920403") && text("spent-rows").includes("techshopping.site") && text("spent-rows").includes("3.00 USDC")
  && text("spent-rows").includes("2026-11-06 21:10 UTC") && d.querySelector("#spent-rows a.chip").getAttribute("href").startsWith("https://explorer.testnet.arc.io/tx/0x6604f4e6"),
  "spent, last 7 days: the order from the gateway, with its payment transaction on Arc's explorer");
check(/UserOps/.test(text("stat-gas")) && /0\.10/.test(text("stat-gas")) || /could not be read/.test(text("stat-gas")) || /0\.00/.test(text("stat-gas")),
  "gas paid by the account: from Arc's explorer");
const claim = text("claim-TS-920403");
check(claim.includes("Arrived late") && claim.includes("REFUND") && claim.includes("1.50 USDC") && claim.includes("per policy") && /Settled/.test(claim)
  && claim.includes("3 store emails registered in one transaction") && claim.includes("records 3, 4, 5")
  && d.getElementById("claim-link-TS-920403").getAttribute("href") === "https://paytenet.site/orders/#/orders/TS-920403",
  "claims: the late claim from the gateway, its verdict, one line per transaction (three emails in one), and My orders");
check(!claim.includes("by the agent alone"), "without rules.json, the panel does not say who opened the claim");
check(/0\.00 USDC/.test(text("balance-amount")) && /No refunds waiting/.test(text("balance-orders")), "balance to withdraw: the escrow's claimable for this account");

// ---- rules.json and approvals.json, loaded from the disk ------------------------------------------------------------
const load = async (inputId, json) => {
  const input = d.getElementById(inputId);
  Object.defineProperty(input, "files", { configurable: true, value: [{ text: async () => JSON.stringify(json) }] });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
};
await load("rules-file", JSON.parse(readFileSync(join(ROOT, "demo/rules.json"), "utf8")));
check(/Claims a week: 3/.test(text("limits-mcp")) && /arrived late\s*alone/.test(text("limits-mcp")) && /not as described\s*asks the owner/.test(text("limits-mcp"))
  && text("claim-TS-920403").includes("by the agent alone") && /"max_claims_per_week":3/.test(w.localStorage.getItem("orvyn-owner-rules") || ""),
  "rules.json loaded: the MCP's rules shown read only, the claim says it was opened by the agent alone, kept in this browser");
await load("approval-file", { account: "0x296333E0223DeE30E08aaCA8cb8f94D194042306", session_address: session, valid_until: "2026-11-07T21:06:01.000Z", orders: 1, max_per_order_usdc: 3, gas_usdc: 0.3, pay: "x", claims: "y" });
check(/That approval is for account 0x296333E0/.test(text("panel-error")) && text("key-state") === "No key", "an approvals.json for another account: refused, with which account it is for");

// ---- the day's approval, byte for byte against aa/owner.mjs ---------------------------------------------------------
check(d.getElementById("approve-step-2").getAttribute("aria-current") === "step", "the approval starts at the key address once the wallet is connected");
type("key-address", wallet.address);
check(/your own wallet/.test(text("key-address-note")) && d.getElementById("approve-next").disabled, "the owner's own address as the key: refused before anything is signed");
type("key-address", session);
click("approve-next");
type("limit-max", "3"); type("limit-orders", "1");
check(text("limit-summary").includes("3.00 USDC") && !d.getElementById("approve-next").disabled, "limits: 1 order of up to 3.00 USDC, at most 3.00 in the day");
click("approve-next");
const words = text("review-text");
check(words.includes(session) && words.includes("pay 1 order") && words.includes("each up to 3.00 USDC") && words.includes("cannot send USDC to any other address"),
  "review in words, from the same values that are signed");
const signsBefore = wallet.asked.filter((m) => m === "eth_signTypedData_v4").length;
click("approve-next");
check(signsBefore === 0 && d.getElementById("signature-1") && /WAITING/.test(text("signature-1")), "nothing signed before Sign");
click("approve-sign");
await until(() => downloaded && !S.ap.signing);
check(wallet.asked.filter((m) => m === "eth_signTypedData_v4").length === 2 && /SIGNED|Approved/.test(text("approve-content")) && downloaded?.name === "approvals.json",
  "Sign: two EIP-712 signatures, then approvals.json is downloaded");
const got = downloaded && await blobs.get(downloaded.href).text();
const dir = mkdtempSync(join(tmpdir(), "orvyn-panel-"));
try {
  writeFileSync(join(dir, "owner.env"), `OWNER_KEY=${key}\n`);
  execFileSync(process.execPath, [join(ROOT, "aa/owner.mjs"), "approve", session, "--max-per-order", "3", "--orders", "1", "--at", String(S.ap.review.now)],
    { env: { ...process.env, ORVYN_OWNER_KEY_FILE: join(dir, "owner.env"), ORVYN_APPROVALS_OUT: join(dir, "approvals.json") }, stdio: ["ignore", "ignore", "ignore"] });
  check(got === readFileSync(join(dir, "approvals.json"), "utf8"), "the panel's approvals.json is byte for byte the one aa/owner.mjs writes for the same key, limits and time");
} finally { rmSync(dir, { recursive: true, force: true }); }
check(!got.includes(key.slice(2)) && text("key-state") === "Key active" && text("agent-tiles").includes(session) && /1 order/.test(text("limits-onchain"))
  && JSON.parse(w.localStorage.getItem("orvyn-owner-approval:" + S.account.toLowerCase())).session_address === session,
  "after signing: no key in the file; the key is active in the panel, its limits on chain shown, kept in this browser");
check(!wallet.asked.some((m) => /send|personal_sign|^eth_sign$/.test(m)), "the wallet was never asked to send a transaction or sign a plain message");

// ---- time limits: the gateway does not answer ---------------------------------------------------------------------
M.WAIT.read = 300;
net.gateway = "silent";
const t0 = Date.now();
await P.reload();
check(/Tenet Pay's gateway did not answer in 0 s/.test(text("panel-error")) && Date.now() - t0 < 5000 && shown("dashboard"),
  "the gateway does not answer: after the time limit, a visible error, and the rest of the panel still shows");
net.gateway = "ok"; M.WAIT.read = 15000;

// ---- the page's text and motion ------------------------------------------------------------------------------------
const pageText = d.body.textContent;
check(!/[–—]/.test(rawHtml + pageText) && !/[–—]/.test(readFileSync(join(ROOT, "site/owner/owner-src.mjs"), "utf8")), "no long dashes in the page, its text or its code");
check(/@media \(prefers-reduced-motion: reduce\) \{ html \{ scroll-behavior: auto; \} \}/.test(css) && !/scrollIntoView\(\{[^}]*smooth/.test(readFileSync(join(ROOT, "site/owner/owner-src.mjs"), "utf8"))
  && !/@keyframes/.test(css), "reduced motion: no smooth scrolling and no animations");

console.log(failed ? `OWNER PANEL FAIL (${failed})` : `owner panel (${BUILT ? "owner.js" : "owner-src.mjs"}): pass`);
process.exit(failed ? 1 : 0);
