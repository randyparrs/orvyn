// The owner's tool, outside the agent: the owner's wallet approves the agent's session key for one day. The agent only sends the
// key's address; the owner signs the approval (an enable signature, off chain, nothing is sent) and gives back approvals.json,
// which holds the limits and the signature and no private key. The key is installed on the account by the agent's first UserOp.
// In production the owner's key is on another device or a hardware wallet, never on the agent's machine.
// On testnet the owner's wallet is a test key in ORVYN_KEYS_DIR (orvyn-owner.env, config.mjs), never read by the agent or the MCP.
//   node owner.mjs approve <session key address> [--max-per-order 2] [--orders 1]   1 day; by default 2 orders of up to 1.00 USDC; 0.3 USDC of gas
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ownerApprovals } from "./account.mjs";
import { TESTNET } from "../sdk/index.js";
import { keysDir, setting } from "../config.mjs";
import { join } from "node:path";

const RPC = process.env.ORVYN_RPC || "https://rpc.testnet.arc.io";
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const OUT = new URL("./approvals.json", import.meta.url);

/** The owner's limits for one day from now: a new key each day, so unused days never add up. */
const dayLimits = (now, maxUsdc, orders) => ({ escrow: TESTNET.escrow, usdc: TESTNET.usdc, maxPerOrderUnits: BigInt(Math.round(maxUsdc * 1e6)), interval: 60, times: orders, startAt: now, validUntil: now + 86400, gasAllowed: parseEther("0.3") });

const [cmd, sessionAddress] = process.argv.slice(2);
const at = process.argv.indexOf("--max-per-order"), maxUsdc = at > 0 ? Number(process.argv[at + 1]) : 1;
const ot = process.argv.indexOf("--orders"), orders = ot > 0 ? Number(process.argv[ot + 1]) : 2;
if (cmd !== "approve" || !isAddress(sessionAddress || "") || !(maxUsdc > 0 && maxUsdc <= 5) || ![1, 2].includes(orders)) {
  console.error("usage: node owner.mjs approve <session key address> [--max-per-order <USDC, up to 5>] [--orders 1|2]");
  process.exit(2);
}
const OWNER_FILE = setting("ORVYN_OWNER_KEY_FILE") || join(keysDir(), "orvyn-owner.env");
const line = readFileSync(OWNER_FILE, "utf8").split(/\r?\n/).find((l) => l.startsWith("OWNER_KEY="));
if (!line) throw new Error("OWNER_KEY is not in " + OWNER_FILE);
const owner = privateKeyToAccount(line.slice("OWNER_KEY=".length).trim());
const pub = createPublicClient({ chain, transport: http(RPC) });
const now = Math.floor(Date.now() / 1000), limits = dayLimits(now, maxUsdc, orders);
const approvals = await ownerApprovals(pub, { owner, sessionAddress, limits });
const account = JSON.parse(Buffer.from(approvals.pay, "base64").toString()).accountParams.accountAddress;
const out = { account, session_address: sessionAddress, valid_until: new Date(limits.validUntil * 1000).toISOString(), orders: limits.times, max_per_order_usdc: maxUsdc, gas_usdc: 0.3, ...approvals };
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ owner: owner.address, account, session_address: sessionAddress, valid_until: out.valid_until, orders: out.orders, max_per_order_usdc: maxUsdc, gas_usdc: 0.3, written: "approvals.json" }, null, 1));
