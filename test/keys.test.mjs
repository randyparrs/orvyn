// The owner's key stays out of the agent. The owner's tool approves a session key it knows only by address; the MCP server runs with
// the session key and that approval, under Node's permission model, and code inside it cannot read the owner's key file. Reads Arc
// testnet to build the approval; nothing is signed on chain and nothing is sent.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ownerApprovals } from "../aa/account.mjs";
import { TESTNET } from "../sdk/index.js";

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const at = (rel) => join(ROOT, rel);

// the owner's side, in its own folder: a test wallet standing in for the owner's
const ownerDir = mkdtempSync(join(tmpdir(), "orvyn-owner-")), agentDir = mkdtempSync(join(tmpdir(), "orvyn-agent-"));
const OWNER_HEX = generatePrivateKey(), SESSION_HEX = generatePrivateKey();
const ownerFile = join(ownerDir, "orvyn-owner.env");
writeFileSync(ownerFile, `OWNER_KEY=${OWNER_HEX}\n`);
const session = privateKeyToAccount(SESSION_HEX);
const pub = createPublicClient({ chain: { id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } } }, transport: http() });
const now = Math.floor(Date.now() / 1000);
const limits = { escrow: TESTNET.escrow, usdc: TESTNET.usdc, maxPerOrderUnits: 1_000_000n, interval: 60, times: 2, startAt: now, validUntil: now + 86400, gasAllowed: parseEther("0.3") };
const approvals = await ownerApprovals(pub, { owner: privateKeyToAccount(OWNER_HEX), sessionAddress: session.address, limits });
const account = JSON.parse(Buffer.from(approvals.pay, "base64").toString()).accountParams.accountAddress;
const plain = (Buffer.from(approvals.pay, "base64").toString() + Buffer.from(approvals.claims, "base64").toString()).toLowerCase();
check(!plain.includes(OWNER_HEX.slice(2).toLowerCase()) && !plain.includes(SESSION_HEX.slice(2).toLowerCase()) && !plain.includes("privatekey"), "the owner's approval holds no private key");

// the agent's side, in another folder: the session key, the approval, the rules and the ledger
writeFileSync(join(agentDir, "orvyn-session.env"), `SESSION_KEY=${SESSION_HEX}\n`);
writeFileSync(join(agentDir, "approvals.json"), JSON.stringify({ account, ...approvals }));
writeFileSync(join(agentDir, "rules.json"), readFileSync(at("mcp/rules.example.json")));

// nothing the agent runs names the owner's key
const agentCode = ["aa/mcp-signer.mjs", "aa/signer.mjs", "mcp/server.js", "sdk/index.js", "sdk/rules.js", "sdk/encode.js"].map((f) => readFileSync(at(f), "utf8")).join("\n");
check(!/OWNER_KEY|orvyn-owner|ownerApprovals/.test(agentCode), "the MCP server, its signer and the SDK do not name the owner's key or the owner's tool");

const env = { ORVYN_RULES: join(agentDir, "rules.json"), ORVYN_SIGNER: at("aa/mcp-signer.mjs"), ORVYN_SESSION_KEY_FILE: join(agentDir, "orvyn-session.env"),
  ORVYN_APPROVALS: join(agentDir, "approvals.json"), ORVYN_LEDGER: join(agentDir, "ledger.json"), ORVYN_PROBE_FILE: ownerFile };
check(!JSON.stringify(env).toLowerCase().includes(OWNER_HEX.slice(2).toLowerCase()), "the server's environment has no owner's key");
const transport = new StdioClientTransport({ command: process.execPath, env: { ...getDefaultEnvironment(), ...env }, stderr: "pipe",
  args: ["--permission", `--allow-fs-read=${ROOT}`, `--allow-fs-read=${agentDir}`, `--allow-fs-write=${agentDir}`, "--import", pathToFileURL(at("test/probe-owner.mjs")).href, at("mcp/server.js")] });
let errText = "";
transport.stderr.on("data", (d) => { errText += d; });
const client = new Client({ name: "keys-test", version: "1" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  check(tools.length === 6, "the server starts under the permission model with the session key and the approval only (6 tools)");
  const r = JSON.parse((await client.callTool({ name: "rules", arguments: {} })).content[0].text);
  check(r.wallet === account, `its wallet is the owner's account, opened with the session key (${account})`);
} catch (e) {
  check(false, "the server under the permission model: " + (e.message || e) + " | " + errText.slice(0, 600));
} finally {
  await client.close().catch(() => {});
}
const probe = (/PROBE owner key file: (.*)/.exec(errText) || [])[1] || "no probe output";
check(/^ERR_ACCESS_DENIED; allowed: false/.test(probe), `code inside the server cannot read the owner's key file (${probe})`);
console.log(failed ? `KEYS FAIL (${failed})` : "keys: pass");
process.exit(failed ? 1 : 0);
