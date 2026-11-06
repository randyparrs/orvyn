// The owner's page (site/owner/) in a simulated DOM, with a test wallet as window.ethereum: connect, the limits in words before
// signing, two signatures, and the approvals.json it downloads, compared byte for byte with what aa/owner.mjs writes for the same
// key, limits and time. Runs the page's source (owner-src.mjs), or with --built the bundle the page loads (owner.js). Reads Arc testnet.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { testWallet } from "../../test/fixtures/wallet.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const html = readFileSync(join(ROOT, "site/owner/index.html"), "utf8").replace(/<script type="module" src="owner\.js[^"]*"><\/script>/, "");
let failed = 0;
const check = (c, what) => { console.log(`${c ? "ok  " : "BAD "} ${what}`); if (!c) failed++; };
const until = async (cond, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); } return cond(); };

const key = generatePrivateKey(), session = privateKeyToAccount(generatePrivateKey()).address;
const dom = new JSDOM(html, { url: "https://orvyn.paytenet.site/owner/", pretendToBeVisual: true });
const w = dom.window, d = w.document;
const wallet = testWallet(key);
w.ethereum = wallet;
let downloaded = null;
w.HTMLAnchorElement.prototype.click = function () { downloaded = { name: this.download, href: this.href }; };
const blobs = new Map();
URL.createObjectURL = (b) => { const u = "blob:test/" + blobs.size; blobs.set(u, b); return u; };
Object.assign(globalThis, { window: w, document: d });
// --built: the same checks on owner.js, the bundle the page loads
const BUILT = process.argv.includes("--built");
await import(pathToFileURL(join(ROOT, BUILT ? "site/owner/owner.js" : "site/owner/owner-src.mjs")).href);
const S = w.OrvynOwner.state;
const shown = (id) => !d.getElementById(id).hidden;
const text = (id) => d.getElementById(id).textContent.replace(/\s+/g, " ").trim();
const click = (id) => d.getElementById(id).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const type = (id, v) => { const el = d.getElementById(id); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };

check(shown("step-wallet") && !shown("step-key") && !shown("step-review") && !shown("step-done"), "before connecting: only step 1");
click("btn-connect");
await until(() => S.account);
check(text("owner-address") === wallet.address && /^0x[0-9a-fA-F]{40}$/.test(text("agent-account")) && shown("step-key"),
  "connect: the wallet's address and the agent's account it opens; step 2 opens");
check(wallet.asked.every((m) => ["eth_requestAccounts", "eth_accounts", "eth_chainId"].includes(m)), "connecting asks the wallet for its address and network only, nothing signed");

type("f-session", wallet.address); click("btn-review");
check(!shown("step-review") && /your own wallet/.test(text("error")), "the owner's own address as the session key: refused before anything is signed");
type("f-session", "0x1234"); click("btn-review");
check(!shown("step-review") && /session key/.test(text("error")), "an address that is not one: refused");
type("f-session", session); type("f-max", "3"); d.getElementById("f-orders").value = "1"; click("btn-review");
const words = text("limits-words");
check(shown("step-review") && words.includes(session) && words.includes("pay 1 order") && words.includes("each up to 3.00 USDC")
  && words.includes("at most 3.00 USDC in the day") && words.includes("cannot send USDC to any other address") && text("review-account") === text("agent-account"),
  "review: the limits in words, for that key and the agent's account, before any signature");
const signsBefore = wallet.asked.filter((m) => m === "eth_signTypedData_v4").length;
type("f-max", "4");
check(!shown("step-review"), "changing a limit after the review takes the review away: it has to be made again");
type("f-max", "3"); click("btn-review");
check(signsBefore === 0, "nothing signed until Sign");
click("btn-sign");
await until(() => downloaded);
const got = downloaded && await blobs.get(downloaded.href).text();
check(downloaded?.name === "approvals.json" && shown("step-done") && wallet.asked.filter((m) => m === "eth_signTypedData_v4").length === 2,
  "Sign: two EIP-712 signatures, then approvals.json is downloaded and step 4 says what was approved");

const dir = mkdtempSync(join(tmpdir(), "orvyn-owner-page-"));
try {
  writeFileSync(join(dir, "owner.env"), `OWNER_KEY=${key}\n`);
  execFileSync(process.execPath, [join(ROOT, "aa/owner.mjs"), "approve", session, "--max-per-order", "3", "--orders", "1", "--at", String(S.review.now)],
    { env: { ...process.env, ORVYN_OWNER_KEY_FILE: join(dir, "owner.env"), ORVYN_APPROVALS_OUT: join(dir, "approvals.json") }, stdio: ["ignore", "ignore", "ignore"] });
  const tool = readFileSync(join(dir, "approvals.json"), "utf8");
  check(got === tool, "the page's approvals.json is byte for byte the one aa/owner.mjs writes for the same key, limits and time");
  check(!got.includes(key.slice(2)) && JSON.parse(got).account === text("agent-account"), "it holds no key, and its account is the one shown");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
check(!wallet.asked.some((m) => /send|personal_sign|^eth_sign$/.test(m)), "the wallet was never asked to send a transaction or sign a plain message");
console.log(failed ? `OWNER PAGE FAIL (${failed})` : `owner page (${BUILT ? "owner.js" : "owner-src.mjs"}): approvals.json = owner.mjs`);
process.exit(failed ? 1 : 0);
