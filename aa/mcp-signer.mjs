// The signer the MCP server loads (ORVYN_SIGNER=aa/mcp-signer.mjs): the session key and the owner's approvals, nothing else.
//   ORVYN_SESSION_KEY_FILE  a file with SESSION_KEY=0x... (the agent's key, made by `node run.mjs new-key`)
//   ORVYN_APPROVALS         approvals.json from the owner's tool (owner.mjs); it has no private key
//   ORVYN_RPC               optional, Arc testnet by default
// Run the server under Node's permission model so it cannot read anything else, the owner's key included:
//   node --permission --allow-fs-read=<orvyn folder> --allow-fs-read=<session key file> --allow-fs-read=<approvals>
//        --allow-fs-write=<ledger> mcp/server.js     (one --allow-fs-read per path: Node 24 takes no comma lists)
import { readFileSync } from "node:fs";
import { createPublicClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sessionSigner } from "./signer.mjs";

const need = (k) => process.env[k] || (() => { throw new Error(`${k} is not set`); })();
const RPC = process.env.ORVYN_RPC || "https://rpc.testnet.arc.io";
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const line = readFileSync(need("ORVYN_SESSION_KEY_FILE"), "utf8").split(/\r?\n/).find((l) => l.startsWith("SESSION_KEY="));
if (!line) throw new Error("SESSION_KEY is not in ORVYN_SESSION_KEY_FILE");
const approvals = JSON.parse(readFileSync(need("ORVYN_APPROVALS"), "utf8"));

export default await sessionSigner({ pub: createPublicClient({ chain, transport: http(RPC) }), sessionKey: privateKeyToAccount(line.slice("SESSION_KEY=".length).trim()), approvals });
