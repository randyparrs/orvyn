// The owner's tool, outside the agent: the owner's wallet approves the agent's session key for one day. The agent only sends the
// key's address; the owner signs the approval (an enable signature, off chain, nothing is sent) and gives back approvals.json,
// which holds the limits and the signature and no private key. The key is installed on the account by the agent's first UserOp.
// In production the owner signs from their own wallet with the owner's page (site/owner/), which builds the same approval
// (aa/approval.mjs); the owner's key is never on the agent's machine.
// On testnet this tool signs with a test key in ORVYN_KEYS_DIR (orvyn-owner.env, config.mjs), never read by the agent or the MCP.
//   node owner.mjs approve <session key address> [--max-per-order 2] [--orders 1]   1 day; by default 2 orders of up to 1.00 USDC; 0.3 USDC of gas
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, defineChain, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { approvalFile, dayLimits, GAS_USDC, limitsInWords } from "./approval.mjs";
import { keysDir, setting } from "../config.mjs";

const RPC = process.env.ORVYN_RPC || "https://rpc.testnet.arc.io";
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// ORVYN_APPROVALS_OUT: another file for the approval, only for the test that compares this tool with the owner's page
const OUT = process.env.ORVYN_APPROVALS_OUT ? pathToFileURL(process.env.ORVYN_APPROVALS_OUT) : new URL("./approvals.json", import.meta.url);

const [cmd, sessionAddress] = process.argv.slice(2);
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const maxUsdc = arg("--max-per-order") ? Number(arg("--max-per-order")) : 1;
const orders = arg("--orders") ? Number(arg("--orders")) : 2;
// --at <unix seconds>: the issue time, only for the test that compares this tool with the owner's page
const now = arg("--at") ? Number(arg("--at")) : Math.floor(Date.now() / 1000);
if (cmd !== "approve" || !isAddress(sessionAddress || "") || !(maxUsdc > 0 && maxUsdc <= 5) || ![1, 2].includes(orders) || !Number.isInteger(now)) {
  console.error("usage: node owner.mjs approve <session key address> [--max-per-order <USDC, up to 5>] [--orders 1|2]");
  process.exit(2);
}
const OWNER_FILE = setting("ORVYN_OWNER_KEY_FILE") || join(keysDir(), "orvyn-owner.env");
const line = readFileSync(OWNER_FILE, "utf8").split(/\r?\n/).find((l) => l.startsWith("OWNER_KEY="));
if (!line) throw new Error("OWNER_KEY is not in " + OWNER_FILE);
const owner = privateKeyToAccount(line.slice("OWNER_KEY=".length).trim());
const pub = createPublicClient({ chain, transport: http(RPC) });
for (const l of limitsInWords(dayLimits(now, maxUsdc, orders), sessionAddress)) console.error(l);
const out = await approvalFile(pub, { owner, sessionAddress, now, maxUsdc, orders });
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ owner: owner.address, account: out.account, session_address: sessionAddress, valid_until: out.valid_until, orders: out.orders, max_per_order_usdc: maxUsdc, gas_usdc: GAS_USDC, written: OUT.pathname.split("/").pop() }, null, 1));
