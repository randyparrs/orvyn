// The agent's side on Arc testnet, one step at a time. It holds the session key and the owner's approvals.json (owner.mjs), never
// the owner's key. Test wallets only; their keys stay in ORVYN_KEYS_DIR (config.mjs) and are never printed.
//   node run.mjs new-key              a new session key (orvyn-session.env); the one before is kept as orvyn-session-<date>.env,
//                                     never printed; prints the new key's address for the owner's tool; nothing on chain
//   node run.mjs fund [--usdc 3]      a test wallet (ORVYN_FUNDER_KEY_FILE) sends USDC to the account (1.50 by default, at most 5)
//   node run.mjs pay TS-123456        pays that order through the Orvyn SDK and the session key (the order is kept in order.json)
//   node run.mjs outside              signs calls outside the limits and simulates them against the real network; nothing is sent
//   node run.mjs claim [TS-123456]    "It never arrived" on that order
//   node run.mjs status               the order, its permission and the balances, read only
//   node run.mjs withdraw             the refund back to the account
//   add --dry to fund, pay, claim and withdraw: stops before signing
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeErrorResult, defineChain, encodeFunctionData, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sessionSigner, BUNDLER } from "./signer.mjs";
import { createOrvyn, TESTNET } from "../sdk/index.js";
import { parseRules } from "../sdk/rules.js";
import { approveData, payData } from "../sdk/encode.js";
import { keysDir, setting } from "../config.mjs";
import { join } from "node:path";

const cmd = process.argv[2], dry = process.argv.includes("--dry");
const KEYS = setting("ORVYN_SESSION_KEY_FILE") || join(keysDir(), "orvyn-session.env");
const APPROVALS = new URL("./approvals.json", import.meta.url), ORDER_FILE = new URL("./order.json", import.meta.url);
const RPC = "https://rpc.testnet.arc.io", USDC = TESTNET.usdc, ESCROW = TESTNET.escrow;
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const fromFile = (file, name) => { const l = readFileSync(file, "utf8").split(/\r?\n/).find((x) => x.startsWith(name + "=")); if (!l) throw new Error(name + " is not in " + file); const k = l.slice(name.length + 1).trim(); return privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k); };
const funder = () => fromFile(setting("ORVYN_FUNDER_KEY_FILE") || (() => { throw new Error("ORVYN_FUNDER_KEY_FILE is not set"); })(), setting("ORVYN_FUNDER_KEY_NAME", "FUNDER_KEY"));
const usdc = (v) => (Number(v) / 1e18).toFixed(4) + " USDC";
const approvals = () => { if (!existsSync(APPROVALS)) throw new Error("no approvals.json: the owner runs owner.mjs approve <session key address>"); return JSON.parse(readFileSync(APPROVALS, "utf8")); };
const signer = async () => sessionSigner({ pub, sessionKey: fromFile(KEYS, "SESSION_KEY"), approvals: approvals() });
const order = () => {
  const n = process.argv.find((a) => /^TS-\d{6}$/.test(a));
  if (n) { writeFileSync(ORDER_FILE, JSON.stringify({ order: n }, null, 1) + "\n"); return n; }
  if (!existsSync(ORDER_FILE)) throw new Error("no order: give its number, for example node run.mjs pay TS-123456");
  return JSON.parse(readFileSync(ORDER_FILE, "utf8")).order;
};
const orvyn = async () => createOrvyn({ signer: await signer(), rules: parseRules({ max_per_order_usdc: 1, max_per_day_usdc: 2, max_claims_per_week: 1, claims: { late: "never", not_delivered: "auto", not_as_described: "never" } }), waitMs: 180_000 });
const CLAIM_TEXT = "The phone case never arrived. The estimated delivery date was today and nothing came.";
const show = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1));

if (cmd === "new-key") {
  if (existsSync(KEYS)) {
    const old = KEYS.replace(/\.env$/, `-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}.env`);
    if (existsSync(old)) throw new Error("already kept: " + old);
    renameSync(KEYS, old);
    console.log("the session key before is kept, unprinted, in " + old);
  }
  const k = generatePrivateKey();
  writeFileSync(KEYS, `SESSION_KEY=${k}\n`);
  show({ session_key_address: privateKeyToAccount(k).address, next: "the owner runs: node owner.mjs approve " + privateKeyToAccount(k).address });
} else if (cmd === "fund") {
  const at = process.argv.indexOf("--usdc"), amount = at > 0 ? process.argv[at + 1] : "1.5";
  if (!(Number(amount) > 0 && Number(amount) <= 5)) throw new Error("--usdc takes an amount up to 5");
  const s = await signer(), v = funder(), value = parseEther(amount);
  console.log(`from ${v.address} (${usdc(await pub.getBalance({ address: v.address }))}) to the account ${s.address} (${usdc(await pub.getBalance({ address: s.address }))}): ${usdc(value)}`);
  if (dry) { console.log("dry run: nothing signed"); process.exit(0); }
  const hash = await createWalletClient({ account: v, chain, transport: http(RPC) }).sendTransaction({ to: s.address, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(r.status, hash, "account now", usdc(await pub.getBalance({ address: s.address })));
} else if (cmd === "pay") {
  const n = order(), s = await signer();
  console.log(`order ${n}, account ${s.address}, balance ${usdc(await pub.getBalance({ address: s.address }))}, deployed ${await s.asPay.isDeployed()}`);
  if (dry) {
    const o = await (await fetch(`${TESTNET.api}/api/checkout/${n}`)).json();
    show({ order: o.order, amount_cents: o.amount_cents, paid: o.paid, store: o.domain });
    const want = BigInt(o.amount_cents) * 10000n;
    const est = await s.client(s.asPay).estimateUserOperationGas({ calls: [{ to: USDC, value: 0n, data: approveData(ESCROW, want) }, { to: ESCROW, value: 0n, data: payData({ ...o, usdc: USDC }, want) }] });
    const gas = est.callGasLimit + est.verificationGasLimit + est.preVerificationGas, price = await pub.getGasPrice();
    console.log(`the bundler's estimate: ${gas} gas at most, about ${usdc(gas * price * 3n / 2n)} at most at today's price (unused gas stays in the account)`);
    console.log("dry run: nothing signed");
    process.exit(0);
  }
  show(await (await orvyn()).payLink(n));
} else if (cmd === "claim") {
  const n = order();
  if (dry) {
    // the SDK builds the claim for a signer that keeps it; the bundler estimates that exact call; nothing is signed on chain
    const s = await signer();
    let call = null;
    const stop = createOrvyn({ signer: { address: s.address, sendTransaction: async (t) => { call = t; throw new Error("kept"); } }, rules: parseRules({ max_per_order_usdc: 1, max_per_day_usdc: 2, max_claims_per_week: 1, claims: { late: "never", not_delivered: "auto", not_as_described: "never" } }) });
    await stop.openClaim(n, "not_delivered", { account: CLAIM_TEXT }).catch(() => {});
    if (!call) throw new Error("the SDK built no claim");
    const est = await s.client(s.asClaims).estimateUserOperationGas({ calls: [{ ...call, value: 0n }] });
    const gas = est.callGasLimit + est.verificationGasLimit + est.preVerificationGas, price = await pub.getGasPrice();
    console.log(`claim to ${call.to}, ${(call.data.length - 2) / 2} bytes; the bundler's estimate: ${gas} gas at most, ${usdc(gas * price)} at most at ${Number(price) / 1e9} gwei`);
    console.log("account balance", usdc(await pub.getBalance({ address: s.address })));
    console.log("dry run: nothing signed");
    process.exit(0);
  }
  show(await (await orvyn()).openClaim(n, "not_delivered", { account: CLAIM_TEXT }));
} else if (cmd === "status") {
  const e = await orvyn(), s = await signer();
  const st = await e.orderStatus(order());
  const left = BigInt(await pub.call({ to: ESCROW, data: "0xd4570c1c" + s.address.slice(2).toLowerCase().padStart(64, "0") + USDC.slice(2).toLowerCase().padStart(64, "0") }).then((r) => r.data || "0x0"));
  show({ account: s.address, balance: usdc(await pub.getBalance({ address: s.address })), claimable_usdc: Number(left) / 1e6, order: { paid: st.paid, mine: st.buyer_is_this_wallet, claim: st.claim, next: st.next, final: st.steps.map((x) => x.final), settled: st.settled }, events: st.events.slice(-6).map((x) => x.what) });
} else if (cmd === "withdraw") {
  if (dry) { console.log("dry run: nothing signed"); process.exit(0); }
  show(await (await orvyn()).withdraw());
} else if (cmd === "outside") {
  const s = await signer();
  const ep = { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" };
  const erc = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] }, { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "t", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] }];
  const payAbi = [{ type: "function", name: "pay", stateMutability: "nonpayable", inputs: [{ name: "a", type: "bytes32" }, { name: "b", type: "address" }, { name: "c", type: "address" }, { name: "d", type: "uint128" }, { name: "e", type: "uint64" }, { name: "f", type: "bytes32" }], outputs: [] }];
  const OTHER = "0x000000000000000000000000000000000000dEaD", STORE = "0x7a090c3414e98fe722a819a1d29c93b04a52ed6c", TERMS = "0xab9996d0149a7f43943d340749a4036b7ef5440547e53fca7c40abec650a98e9";
  const cases = [
    ["another destination: transfer of USDC", s.asPay, { to: USDC, data: encodeFunctionData({ abi: erc, functionName: "transfer", args: [OTHER, 1n] }), value: 0n }],
    ["approve to another spender", s.asPay, { to: USDC, data: encodeFunctionData({ abi: erc, functionName: "approve", args: [OTHER, 1_000_000n] }), value: 0n }],
    ["another amount: approve above 1.00", s.asPay, { to: USDC, data: encodeFunctionData({ abi: erc, functionName: "approve", args: [ESCROW, 1_000_001n] }), value: 0n }],
    ["another amount: pay of 1.50", s.asPay, { to: ESCROW, data: encodeFunctionData({ abi: payAbi, functionName: "pay", args: ["0x" + "12".repeat(32), STORE, USDC, 1_500_000n, 2592000n, TERMS] }), value: 0n }],
    ["USDC sent as value", s.asPay, { to: OTHER, data: "0x", value: 1n }],
    ["past the limit: a pay inside the 60 seconds after another (if the last one was just now)", s.asPay, { to: ESCROW, data: encodeFunctionData({ abi: payAbi, functionName: "pay", args: ["0x" + "13".repeat(32), STORE, USDC, 1_000_000n, 2592000n, TERMS] }), value: 0n }],
  ];
  const ERR = { "0x007e472e": "call not allowed by the policy", "0x59d52e40": "CallViolatesParamRule", "0x3e4983f6": "PolicyFailed" };
  for (const [what, account, call] of cases) {
    try {
      const est = await s.client(account).estimateUserOperationGas({ calls: [call] });
      console.log(`NOT REFUSED  ${what}: estimate ${est.callGasLimit}`);
    } catch (e) {
      const t = String(e.details || e.shortMessage || e.message);
      const code = (/AA\d\d[^"\n]{0,40}/.exec(t) || [""])[0], sel = (/0x[0-9a-f]{8}/.exec(t) || [""])[0];
      console.log(`refused      ${what}: ${code || t.slice(0, 120)} ${ERR[sel] || sel}`);
    }
  }
  void ep; void decodeErrorResult;
} else {
  console.error("usage: node run.mjs new-key|fund|pay|outside|claim|status|withdraw [--dry]");
  process.exit(2);
}
void BUNDLER;
process.exit(0);
