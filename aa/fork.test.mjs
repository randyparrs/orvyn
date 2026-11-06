// Day 5's rehearsal: the session key on a local fork of Arc testnet, with ZeroDev's and the EntryPoint's real contracts as deployed
// there and test keys made here. Nothing is sent to the network: anvil keeps every change. UserOps go straight to the EntryPoint,
// as a bundler sends them; test USDC stands in at Arc's address, because the fork has no Arc precompiles.
import { join } from "node:path";
import { tenetPayDir } from "../config.mjs";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeErrorResult, defineChain, encodeFunctionData, http, parseEther, sha256, toBytes, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint, ownerApprovals, sessionAccounts } from "./account.mjs";

// as in use: the owner approves a key it knows only by address, and the account is opened with the key and the approvals alone
const accounts = async (pub, { owner, sessionKey, limits }) => sessionAccounts(pub, { sessionKey, approvals: await ownerApprovals(pub, { owner, sessionAddress: sessionKey.address, limits }) });

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };
const T = (rel) => join(tenetPayDir(), "tenet", rel); // Tenet's escrow, built in tenet-pay's tenet/ (forge build)
const HOME = process.env.USERPROFILE || process.env.HOME;
const A = `${HOME}/.foundry/bin/anvil${process.platform === "win32" ? ".exe" : ""}`;
const USDC = "0x3600000000000000000000000000000000000000";
const port = 18746, url = `http://127.0.0.1:${port}`;
const anvil = spawn(existsSync(A) ? A : "anvil", ["--fork-url", "https://rpc.testnet.arc.io", "--port", String(port), "--silent", "--no-rate-limit"], { stdio: "ignore" });
const chain = defineChain({ id: 5042002, name: "arc-fork", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const pub = createPublicClient({ chain, transport: http(url, { timeout: 60000 }) });
const EP_ERRORS = [{ type: "error", name: "FailedOp", inputs: [{ name: "opIndex", type: "uint256" }, { name: "reason", type: "string" }] }, { type: "error", name: "FailedOpWithRevert", inputs: [{ name: "opIndex", type: "uint256" }, { name: "reason", type: "string" }, { name: "inner", type: "bytes" }] }];
const EP_ABI = [{ type: "function", name: "handleOps", stateMutability: "nonpayable", inputs: [{ name: "ops", type: "tuple[]", components: [
  { name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" }, { name: "callData", type: "bytes" }, { name: "accountGasLimits", type: "bytes32" },
  { name: "preVerificationGas", type: "uint256" }, { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" }] }, { name: "beneficiary", type: "address" }], outputs: [] },
{ type: "event", name: "UserOperationEvent", inputs: [{ name: "userOpHash", type: "bytes32", indexed: true }, { name: "sender", type: "address", indexed: true }, { name: "paymaster", type: "address", indexed: true }, { name: "nonce", type: "uint256" }, { name: "success", type: "bool" }, { name: "actualGasCost", type: "uint256" }, { name: "actualGasUsed", type: "uint256" }] }];

try {
  for (let i = 0; i < 150; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
  const rpc = (method, params) => pub.request({ method, params });
  const key = () => privateKeyToAccount(generatePrivateKey());
  const OWNER_HEX = generatePrivateKey(), OWNER = privateKeyToAccount(OWNER_HEX), SESSION = key(), BUNDLER = key(), RELAYER = key(), STORE = key(), ATTACKER = key();
  for (const a of [OWNER, BUNDLER, RELAYER]) await rpc("anvil_setBalance", [a.address, "0x56BC75E2D63100000"]);
  const wallet = (a) => createWalletClient({ account: a, chain, transport: http(url, { timeout: 60000 }) });
  const wait = async (h) => { const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 60000 }); if (r.status !== "success") throw new Error("reverted " + h); return r; };
  const stable = JSON.parse(readFileSync(T("evm/out/RefundEscrow.t.sol/Stable.json"), "utf8"));
  const art = JSON.parse(readFileSync(T("evm/out-demo/RefundEscrow.sol/RefundEscrow.json"), "utf8"));
  let r = await wait(await wallet(OWNER).deployContract({ abi: stable.abi, bytecode: stable.bytecode.object, args: ["USDC"] }));
  await rpc("anvil_setCode", [USDC, await pub.getCode({ address: r.contractAddress })]);
  r = await wait(await wallet(OWNER).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [OWNER.address, RELAYER.address, OWNER.address, [USDC], [5_000_000n], 120n] }));
  const escrow = r.contractAddress;
  const TERMS = sha256(toBytes("terms"));
  await wait(await wallet(RELAYER).writeContract({ address: escrow, abi: art.abi, functionName: "setMerchantTerms", args: [STORE.address, 2592000n, TERMS] }));
  const now = Number((await pub.getBlock()).timestamp);
  const limits = { escrow, usdc: USDC, maxPerOrderUnits: 1_000_000n, interval: 86400, times: 7, startAt: now, validUntil: now + 7 * 86400, gasAllowed: parseEther("0.5") };
  const { asPay: tight } = await accounts(pub, { owner: OWNER, sessionKey: key(), limits: { ...limits, gasAllowed: parseEther("0.13") } });
  const { asPay, asClaims } = await accounts(pub, { owner: OWNER, sessionKey: SESSION, limits });
  check(asPay.address === asClaims.address, `one account for both permissions (${asPay.address})`);
  const SA = asPay.address;
  await wait(await wallet(OWNER).writeContract({ address: USDC, abi: stable.abi, functionName: "mint", args: [SA, 10_000_000n] }));
  await rpc("anvil_setBalance", [SA, "0x8AC7230489E80000"]); // 10 of gas money, in the fork only

  const balance = (a) => pub.readContract({ address: USDC, abi: stable.abi, functionName: "balanceOf", args: [a] });
  const fees = { maxFeePerGas: 40_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
  /** Signs a UserOp with that permission and sends it the way a bundler does. "denied" = the validation refused it; "reverted" = it ran and failed. */
  // Gas as a bundler would estimate it: large only when the UserOp deploys the account or installs a permission.
  const installed = new Set();
  async function userOp(account, calls) {
    const big = !installed.has(account);
    const factory = await account.isDeployed() ? {} : await account.getFactoryArgs();
    const op = { sender: account.address, nonce: await account.getNonce(), callData: await account.encodeCalls(calls), callGasLimit: 1_200_000n, verificationGasLimit: big ? 3_000_000n : 400_000n, preVerificationGas: 100_000n, ...fees, ...factory };
    op.signature = await account.signUserOperation(op);
    const initCode = op.factory ? op.factory + op.factoryData.slice(2) : "0x";
    const pack = (a, b) => ("0x" + a.toString(16).padStart(32, "0") + b.toString(16).padStart(32, "0"));
    const packed = { sender: op.sender, nonce: op.nonce, initCode, callData: op.callData, accountGasLimits: pack(op.verificationGasLimit, op.callGasLimit), preVerificationGas: op.preVerificationGas,
      gasFees: pack(op.maxPriorityFeePerGas, op.maxFeePerGas), paymasterAndData: "0x", signature: op.signature };
    try {
      // as a bundler does: simulate first; the EntryPoint's FailedOp says why a UserOp is refused
      const data = encodeFunctionData({ abi: EP_ABI, functionName: "handleOps", args: [[packed], BUNDLER.address] });
      try { await pub.call({ account: BUNDLER.address, to: entryPoint.address, data, gas: 14_000_000n }); } catch (e) {
        const raw = e.walk?.((c) => typeof c.data === "string")?.data || e.data || "";
        let why = String(raw).slice(0, 10);
        try { const d = decodeErrorResult({ abi: EP_ERRORS, data: raw }); why = d.args[1] + (d.args[2] ? " " + String(d.args[2]).slice(0, 74) : ""); } catch { /* another error: its selector stays */ }
        return { result: "denied", why: why || String(e.shortMessage || e.message).split("\n")[0].slice(0, 90) };
      }
      const hash = await wallet(BUNDLER).sendTransaction({ to: entryPoint.address, data, gas: 14_000_000n });
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60000 });
      if (rc.status !== "success") return { result: "denied", why: "reverted" };
      const ev = rc.logs.find((l) => l.address.toLowerCase() === entryPoint.address.toLowerCase() && l.topics[0] === "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f");
      const success = ev && BigInt("0x" + ev.data.slice(2 + 64, 2 + 128)) === 1n;
      const cost = ev ? BigInt("0x" + ev.data.slice(2 + 128, 2 + 192)) : 0n;
      if (success) installed.add(account);
      const rev = rc.logs.find((l) => l.topics[0] === "0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201");
      const inner = rev ? "0x" + rev.data.slice(2 + 64 * 4, 2 + 64 * 4 + 8) : "";
      return { result: success ? "ok" : "reverted", cost, why: inner };
    } catch (e) {
      return { result: "denied", why: String(e.shortMessage || e.message).split("\n")[0].slice(0, 90) };
    }
  }
  const approve = (to, value) => ({ to: USDC, value: 0n, data: encodeFunctionData({ abi: stable.abi, functionName: "approve", args: [to, value] }) });
  const transfer = (to, value) => ({ to: USDC, value: 0n, data: encodeFunctionData({ abi: stable.abi, functionName: "transfer", args: [to, value] }) });
  const pay = (ref, value, token = USDC) => ({ to: escrow, value: 0n, data: encodeFunctionData({ abi: art.abi, functionName: "pay", args: [ref, STORE.address, token, value, 2592000n, TERMS] }) });
  const ref = (n) => sha256(toBytes("TS-" + n));

  // inside the limits: the agent pays one order
  let x = await userOp(asPay, [approve(escrow, 1_000_000n), pay(ref(1), 1_000_000n)]);
  check(x.result === "ok", `inside the limits: approve and pay of 1.00 USDC in one UserOp (${x.result}${x.why ? ": " + x.why : ""}, gas cost ${x.cost ? Number(x.cost) / 1e18 : "?"})`);
  check(await balance(escrow) === 1_000_000n, "the escrow holds the 1.00 USDC");

  // each of these has to fail; the UserOp hits a limit on chain
  const out = async (what, account, calls, want) => {
    const before = await balance(SA);
    const z = await userOp(account, calls);
    check(z.result !== "ok" && await balance(SA) === before && await balance(ATTACKER.address) === 0n, `${what}: ${z.result}${z.why ? " (" + z.why + ")" : ""}, no money moved`);
  };
  await rpc("evm_increaseTime", [86401]); await rpc("evm_mine", []);
  await out("another destination: USDC transfer to an address of the attacker's", asPay, [transfer(ATTACKER.address, 1n)]);
  await out("approve to another spender", asPay, [approve(ATTACKER.address, 1_000_000n)]);
  await out("approve above the limit per order", asPay, [approve(escrow, 1_000_001n)]);
  await out("pay above the limit per order", asPay, [approve(escrow, 1_000_000n), pay(ref(2), 1_500_000n)]);
  await out("native USDC sent as value", asPay, [{ to: ATTACKER.address, value: 1n, data: "0x" }]);

  // what the agent gets from the owner: an approval with no key in it, which it cannot widen. A new key, approved for 1.00 per order,
  // with the approval edited to 5.00 before its first use: the owner's enable signature no longer matches and the UserOp is refused.
  {
    const k2 = key(), ap = await ownerApprovals(pub, { owner: OWNER, sessionAddress: k2.address, limits });
    const raw = (a) => Buffer.from(a, "base64").toString();
    check(!JSON.parse(raw(ap.pay)).privateKey && !JSON.parse(raw(ap.claims)).privateKey && !(raw(ap.pay) + raw(ap.claims)).toLowerCase().includes(OWNER_HEX.slice(2).toLowerCase()),
      "the owner's approval holds no private key, neither the session key's nor the owner's");
    // the limit is in the approval twice, as an argument and as the encoded rule the policy installs: both are edited
    const ONE = "f4240".padStart(64, "0"), FIVE = "4c4b40".padStart(64, "0");
    const wide = raw(ap.pay).split('"value":"1000000"').join('"value":"5000000"').split(ONE).join(FIVE);
    check(wide.split(FIVE).length === 3 && wide.split('"value":"5000000"').length === 3, "the approval edited: limit per order 1.00 to 5.00, in the arguments and in the encoded rules");
    const { asPay: widened } = await sessionAccounts(pub, { sessionKey: k2, approvals: { pay: Buffer.from(wide).toString("base64"), claims: ap.claims } });
    await out("a session key with its approval widened by the agent: approve and pay of 5.00", widened, [approve(escrow, 5_000_000n), pay(ref(9), 5_000_000n)]);
  }
  await out("claims permission cannot pay", asClaims, [pay(ref(3), 1_000_000n)]);
  await out("claims permission cannot transfer", asClaims, [transfer(ATTACKER.address, 1n)]);
  const withdrawOther = { to: escrow, value: 0n, data: encodeFunctionData({ abi: art.abi, functionName: "withdraw", args: [ATTACKER.address] }) };
  await out("withdraw of another token", asClaims, [withdrawOther]);

  // the daily limit: one UserOp per interval of the pay permission
  x = await userOp(asPay, [approve(escrow, 1_000_000n), pay(ref(4), 1_000_000n)]);
  check(x.result === "ok", `a new day: the second order of the week goes through (${x.result}${x.why ? ": " + x.why : ""})`);
  await out("past the daily limit: another order the same day", asPay, [approve(escrow, 1_000_000n), pay(ref(5), 1_000_000n)]);

  // the claims permission works: the contract takes a claim from the account
  const o = await pub.readContract({ address: escrow, abi: art.abi, functionName: "getOrder", args: [ref(4)] });
  const claim = JSON.stringify({ v: "claim-v1", order_ref: ref(4), order_number: "TS-4", buyer: SA.toLowerCase(), merchant: STORE.address.toLowerCase(), amount_cents: 100, paid_at: Number(o.paidAt), claimed_at: Number((await pub.getBlock()).timestamp) - 30, terms_hash: TERMS, event: "not_delivered", account: "x", promised_date: "2026-10-30" });
  const open = { to: escrow, value: 0n, data: encodeFunctionData({ abi: art.abi, functionName: "openClaim", args: [ref(4), toHex(toBytes(claim))] }) };
  x = await userOp(asClaims, [open]);
  check(x.result === "ok", `claims permission: openClaim accepted from the account as buyer (${x.result}${x.why ? ": " + x.why : ""})`);
  // a late claim's store emails: three submits in one UserOp, as submit_evidence sends them from a smart account
  const sub = (id) => ({ to: escrow, value: 0n, data: encodeFunctionData({ abi: art.abi, functionName: "submit",
    args: [ref(4), toHex(toBytes(JSON.stringify({ content: { body_b64: "", record_id: id }, kind: "evidence", party: "buyer" })))] }) });
  x = await userOp(asClaims, [sub("0"), sub("1"), sub("2")]);
  check(x.result === "ok", `claims permission: three submits in one UserOp (${x.result}${x.why ? ": " + x.why : ""})`);

  // how the daily limit behaves after idle days: measured, because the rate limit counts windows from the issue date
  await rpc("evm_increaseTime", [3 * 86400]); await rpc("evm_mine", []);
  const idle1 = await userOp(asPay, [approve(escrow, 1_000_000n), pay(ref(7), 1_000_000n)]);
  const idle2 = await userOp(asPay, [approve(escrow, 1_000_000n), pay(ref(8), 1_000_000n)]);
  const idle3 = await userOp(asPay, [approve(escrow, 1_000_000n), pay(ref(9), 1_000_000n)]);
  const idle4 = await userOp(asPay, [approve(escrow, 1_000_000n), pay(ref(10), 1_000_000n)]);
  console.log(`info after 3 idle days, four orders at once: ${[idle1, idle2, idle3, idle4].map((o) => o.result).join(", ")}`);

  // the strict daily limit: a key that lives one day, with a fixed number of orders; nothing carries over
  const dayStart = Number((await pub.getBlock()).timestamp);
  const { asPay: daily } = await accounts(pub, { owner: OWNER, sessionKey: key(), limits: { ...limits, interval: 60, times: 2, startAt: dayStart, validUntil: dayStart + 86400 } });
  const go = (n) => userOp(daily, [approve(escrow, 1_000_000n), pay(ref(n), 1_000_000n)]);
  const d1 = await go(11);
  await rpc("evm_increaseTime", [61]); await rpc("evm_mine", []);
  const d2 = await go(12);
  await rpc("evm_increaseTime", [61]); await rpc("evm_mine", []);
  const d3 = await go(13);
  check(d1.result === "ok" && d2.result === "ok" && d3.result === "denied", `one-day key with 2 orders: 2 go through, the third is refused (${d3.why})`);
  await rpc("evm_increaseTime", [86400]); await rpc("evm_mine", []);
  const d4 = await go(14);
  check(d4.result === "denied", `next day the key has expired, nothing carried over (${d4.why})`);

  // the session's gas budget: a key with less gas than one more UserOp asks for is refused
  await rpc("evm_increaseTime", [86401]); await rpc("evm_mine", []);
  await out("the session's gas budget spent (another session key, 0.13 of gas)", tight, [approve(escrow, 1_000_000n), pay(ref(6), 1_000_000n)]);

  // and the end date
  await rpc("evm_increaseTime", [8 * 86400]); await rpc("evm_mine", []);
  await out("past the session's end date", asClaims, [{ to: escrow, value: 0n, data: encodeFunctionData({ abi: art.abi, functionName: "withdraw", args: [USDC] }) }]);
} catch (e) {
  console.log("BAD ", e.shortMessage || e.message, String(e.stack || "").split("\n").slice(1, 4).join(" | ").slice(0, 300));
  failed++;
} finally {
  anvil.kill();
}
console.log(failed ? `FORK FAIL (${failed})` : "fork: pass");
process.exit(failed ? 1 : 0);
