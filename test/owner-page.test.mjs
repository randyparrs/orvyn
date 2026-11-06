// The owner's approval from a browser wallet is the same as aa/owner.mjs's: same session key, limits and issue time give the same
// approvals.json. A throwaway owner key signs both ways: owner.mjs reads it from a file; the page's path (aa/approval.mjs with an
// EIP-1193 provider, as window.ethereum) asks a wallet that holds it. Reads Arc testnet; sends nothing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { approvalFile, dayLimits, limitsInWords } from "../aa/approval.mjs";
import { testWallet } from "./fixtures/wallet.mjs";

const RPC = "https://rpc.testnet.arc.io";
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };

const dir = mkdtempSync(join(tmpdir(), "orvyn-owner-"));
try {
  const key = generatePrivateKey(), session = privateKeyToAccount(generatePrivateKey()).address;
  const at = Math.floor(Date.now() / 1000) - 60, maxUsdc = 3, orders = 1;
  writeFileSync(join(dir, "owner.env"), `OWNER_KEY=${key}\n`);
  execFileSync(process.execPath, ["aa/owner.mjs", "approve", session, "--max-per-order", String(maxUsdc), "--orders", String(orders), "--at", String(at)],
    { env: { ...process.env, ORVYN_OWNER_KEY_FILE: join(dir, "owner.env"), ORVYN_APPROVALS_OUT: join(dir, "approvals.json") }, stdio: ["ignore", "ignore", "ignore"] });
  const fromTool = JSON.parse(readFileSync(join(dir, "approvals.json"), "utf8"));

  const wallet = testWallet(key);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const fromWallet = await approvalFile(pub, { owner: wallet, sessionAddress: session, now: at, maxUsdc, orders });
  check(JSON.stringify(fromWallet) === JSON.stringify(fromTool), "the browser wallet's approval is byte for byte the one owner.mjs writes (same key, limits and time)");
  check(wallet.asked.filter((m) => m === "eth_signTypedData_v4").length === 2 && !wallet.asked.some((m) => /send|personal_sign|eth_sign$/.test(m)),
    "the wallet is asked for two EIP-712 signatures (pay and claims) and nothing else is signed or sent");
  check(!JSON.stringify(fromWallet).includes(key.slice(2)),
    "the approval does not hold the owner's key");
  check(wallet.asked.every((m) => ["eth_requestAccounts", "eth_accounts", "eth_signTypedData_v4"].includes(m)),
    "the wallet only gives its address and signs: the page reads Arc through Arc's public RPC, not through the wallet");
  const words = limitsInWords(dayLimits(at, maxUsdc, orders), session).join(" ");
  check(words.includes("1 order") && words.includes("each up to 3.00 USDC") && words.includes("at most 3.00 USDC in the day") && words.includes(session)
    && fromTool.max_per_order_usdc === 3 && fromTool.orders === 1, "the limits in words are the ones in the approval: 1 order of up to 3.00 USDC, for that key");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `OWNER PAGE FAIL (${failed})` : "owner approval: wallet = owner.mjs");
process.exit(failed ? 1 : 0);
