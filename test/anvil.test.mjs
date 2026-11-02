// The SDK's bytes against the real escrow, on a local anvil with test keys made here: pay, a claim the contract accepts, the
// relayer's verdict, withdrawal. Nothing leaves this machine. The gateway's API is a stand-in built from the chain's own state.
import { join } from "node:path";
import { tenetPayDir } from "../config.mjs";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, sha256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createOrvyn } from "../sdk/index.js";
import { parseRules } from "../sdk/rules.js";
import { termsHash } from "../sdk/terms.js";
import { RULES } from "./world.mjs";

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };
const T = (rel) => join(tenetPayDir(), "tenet", rel); // Tenet's escrow, built in tenet-pay's tenet/ (forge build)
const HOME = process.env.USERPROFILE || process.env.HOME;
const A = `${HOME}/.foundry/bin/anvil${process.platform === "win32" ? ".exe" : ""}`;
const ANVIL = process.env.ANVIL || (existsSync(A) ? A : "anvil");
const USDC = "0x3600000000000000000000000000000000000000";
const port = 18745, url = `http://127.0.0.1:${port}`;
const anvil = spawn(ANVIL, ["--port", String(port), "--chain-id", "5042002", "--silent"], { stdio: "ignore" });
const chain = defineChain({ id: 5042002, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const pub = createPublicClient({ chain, transport: http(url) });
try {
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const rpc = (method, params) => pub.request({ method, params });
  const key = () => privateKeyToAccount(generatePrivateKey());
  const OWNER = key(), RELAYER = key(), GUARDIAN = key(), STORE = key(), AGENT = key();
  for (const a of [OWNER, RELAYER, GUARDIAN, STORE, AGENT]) await rpc("anvil_setBalance", [a.address, "0x56BC75E2D63100000"]);
  const wallet = (a) => createWalletClient({ account: a, chain, transport: http(url) });
  const wait = async (h) => { const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error("reverted " + h); return r; };
  const stable = JSON.parse(readFileSync(T("evm/out/RefundEscrow.t.sol/Stable.json"), "utf8"));
  const art = JSON.parse(readFileSync(T("evm/out-demo/RefundEscrow.sol/RefundEscrow.json"), "utf8"));
  let r = await wait(await wallet(OWNER).deployContract({ abi: stable.abi, bytecode: stable.bytecode.object, args: ["USDC"] }));
  await rpc("anvil_setCode", [USDC, await pub.getCode({ address: r.contractAddress })]);
  await wait(await wallet(OWNER).writeContract({ address: USDC, abi: stable.abi, functionName: "mint", args: [AGENT.address, 50_000_000n] }));
  r = await wait(await wallet(OWNER).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [OWNER.address, RELAYER.address, GUARDIAN.address, [USDC], [5_000_000n], 120n] }));
  const escrow = r.contractAddress;
  const esc = (functionName, args) => pub.readContract({ address: escrow, abi: art.abi, functionName, args });
  const rel = (functionName, args) => wallet(RELAYER).writeContract({ address: escrow, abi: art.abi, functionName, args }).then(wait);

  // the store's terms, registered as the gateway registers them
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/checkout.json", import.meta.url), "utf8"));
  const windows = fixture.terms.windows, hold = fixture.terms.hold_days;
  const hash = await termsHash(fixture.terms.structure, hold, windows);
  await rel("setMerchantTerms", [STORE.address, BigInt(hold * 86400), hash]);

  const ORDER = "TS-100001", ref = sha256(toBytes(ORDER));
  const lower = (x) => x.toLowerCase();
  let paidAt = 0, claimText = null;
  const api = async (u) => {
    if (u.includes("/api/checkout/")) return { order: ORDER, ref, merchant: lower(STORE.address), domain: "store.test", amount_cents: 100, description: "Clear phone case.", paid: false, chain_id: 5042002, escrow, usdc: USDC, terms: fixture.terms };
    const o = await esc("getOrder", [ref]).catch(() => null);
    const paid = o && Number(o.paidAt) > 0;
    if (paid) paidAt = Number(o.paidAt);
    const t = Number((await pub.getBlock()).timestamp);
    return { order: ORDER, ref, buyer: lower(AGENT.address), domain: "store.test", description: "Clear phone case.", amount_cents: 100, paid, claim: claimText ? { event: "not_delivered", at: t } : null,
      next: claimText ? { action: "wait" } : { action: "claim", claimed_at: Math.max(t - 60, paidAt), events: ["late", "not_as_described", "not_delivered"], evidence: [],
        base: { v: "claim-v1", order_ref: ref, order_number: ORDER, buyer: lower(AGENT.address), merchant: lower(STORE.address), amount_cents: 100, paid_at: paidAt, claimed_at: Math.max(t - 60, paidAt), terms_hash: hash } } };
  };
  const fetchImpl = async (u, init) => (String(u).startsWith("https://api.test") ? { ok: true, status: 200, json: () => api(String(u)) } : fetch(u, init));
  // the owner's signer: in this test a key made above; in real use it is the owner's wallet, never Orvyn
  const signer = { address: AGENT.address, sendTransaction: ({ to, data }) => wallet(AGENT).sendTransaction({ to, data }) };
  const orvyn = createOrvyn({ net: { api: "https://api.test", rpc: url, chainId: 5042002, escrow, usdc: USDC, windows }, signer, rules: parseRules(RULES), fetchImpl, pollMs: 50 });

  const before = await pub.readContract({ address: USDC, abi: stable.abi, functionName: "balanceOf", args: [AGENT.address] });
  const paid = await orvyn.payLink("TS-100001");
  const o1 = await esc("getOrder", [ref]);
  check(paid.paid && lower(o1.buyer) === lower(AGENT.address) && o1.amount === 1_000_000n && o1.termsHash === hash, "pay: the escrow holds the order, the agent as buyer and the store's terms");
  check(await pub.readContract({ address: USDC, abi: stable.abi, functionName: "balanceOf", args: [escrow] }) === 1_000_000n, "pay: 1.00 USDC in the escrow");
  const claimed = await orvyn.openClaim(ORDER, "not_delivered", { account: "The case never arrived." });
  const rc = await pub.getTransactionReceipt({ hash: claimed.tx });
  const o2 = await esc("getOrder", [ref]);
  check(rc.status === "success" && o2.claimedAt > 0n, "claim: the contract accepts the SDK's claim (buyer, merchant, order, terms, amount, paid_at, claimed_at)");
  claimText = "opened";
  const again = await orvyn.openClaim(ORDER, "not_delivered", { account: "Again." }).then(() => false, (e) => /already has a claim/.test(e.message));
  check(again, "claim: an order takes one claim");

  // the relayer takes a verdict to the escrow, as the Worker does: refund of 1.00 USDC
  await rel("proposeVerdict", [ref, 1, 100, o2.claimHash, o2.chain, "0x" + "ab".repeat(32)]);
  await rpc("evm_increaseTime", [121]);
  await rpc("evm_mine", []);
  await rel("executeVerdict", [ref]);
  const w = await orvyn.withdraw();
  const after = await pub.readContract({ address: USDC, abi: stable.abi, functionName: "balanceOf", args: [AGENT.address] });
  check(w.withdrawn_usdc === 1 && after === before && await esc("claimable", [AGENT.address, USDC]) === 0n, "withdraw: the refund back in the agent's wallet, nothing left in the escrow");
} catch (e) {
  console.log("BAD ", e.shortMessage || e.message);
  failed++;
} finally {
  anvil.kill();
}
console.log(failed ? `ANVIL FAIL (${failed})` : "anvil: pass");
process.exit(failed ? 1 : 0);
