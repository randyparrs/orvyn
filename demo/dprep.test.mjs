// Test D's preparation, offline: its own files and messages, the closing proof through the agent and the MCP's question, the
// owner's rule change, the owner's tool taking --orders, and new-key keeping the key before it. Nothing goes to the network.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../mcp/server.js";
import { SEL } from "../sdk/encode.js";
import { bytesOf, world } from "../test/world.mjs";
import { MESSAGES, ROOT, files, ownerAnswers, turn } from "./agent.mjs";
import { transcript } from "./transcript.mjs";

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };
const rows = [], log = (o) => rows.push({ t: new Date().toISOString(), step: "D3", ...o });

// files and messages
{
  const d = files("D1"), m = files("M1");
  check(d.log.endsWith("dD-log.jsonl") && d.state.endsWith("dD-state.json") && d.transcript.endsWith("dD-transcript.md") && m.log.endsWith("d6-log.jsonl") && m.state.endsWith("state.json"),
    "test D keeps its own log, state and transcript; day 6's stay as they are");
  check(MESSAGES.D1b === "The daily limit has reset now. Go ahead: buy the 65 W USB-C charger at TechShopping and pay for it with Orvyn." && files("D1b").log.endsWith("dD-log.jsonl"),
    "D1b, fixed after D1 ran early, goes to test D's log");
  check(["D1", "D2", "D3", "D4"].every((k) => MESSAGES[k]) && /disputed/.test(MESSAGES.D3) && MESSAGES.M1 && MESSAGES.M5, "messages D1 to D4 are fixed next to day 6's");
  check(transcript(JSON.stringify({ t: "2026-11-03T15:00:00Z", who: "owner", text: "x" }), d.title).startsWith("# Test D:"), "the transcript of test D has its own title");
}

// D3: the closing round; the agent sends what the order waits for and the proof comes from the owner through the MCP
{
  const w = world({ ask: (q) => asker(q), patchOrder: (o) => ({ ...o, next: { action: "closing", until: 1793400300 } }) });
  let asker = async () => null;
  const server = buildServer((a) => { asker = a; return w.orvyn; });
  const mcp = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: {} } });
  const answers = ["s", "label", "Model TS-C20, Output 20 W"];
  mcp.setRequestHandler(ElicitRequestSchema, (r) => ownerAnswers(async () => answers.shift(), log)(r.params));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  let i = 0;
  const steps = [
    { role: "assistant", content: "", tool_calls: [{ id: "s1", type: "function", function: { name: "order_status", arguments: '{"order":"TS-171823"}' } }] },
    { role: "assistant", content: "", tool_calls: [{ id: "s2", type: "function", function: { name: "submit_evidence", arguments: '{"order":"TS-171823"}' } }] },
    { role: "assistant", content: "Sent your closing proof." },
  ];
  const oks = [];
  await turn({ message: MESSAGES.D3, messages: [], llm: async () => ({ message: steps[i++], usage: null }), mcp, store: {}, confirm: async (c) => { oks.push(c.name); return true; }, log });
  const asked = rows.find((r) => r.who === "mcp-asks-owner");
  check(oks.join() === "submit_evidence" && !!asked && /needs proof from you/.test(asked.message), "submit_evidence waits for the OK, then the MCP asks the owner for the closing proof");
  const sent = w.sent.at(-1);
  check(w.sent.length === 1 && sent.data.startsWith("0x" + SEL.submit) && /"kind":"closing_proof"/.test(bytesOf(sent.data)) && bytesOf(sent.data).includes("Model TS-C20, Output 20 W"),
    "the escrow gets a closing_proof with the owner's words");
  await mcp.close();
}

// the owner's rules for test D: 3 claims a week (raised from 2 for it); the daily limit stays at 3.00
{
  const r = JSON.parse(readFileSync(join(ROOT, "demo", "rules.json"), "utf8"));
  check(r.max_claims_per_week === 3 && r.max_per_day_usdc === 3 && r.max_per_order_usdc === 3 && r.claims.not_as_described === "ask_owner", "rules: 3 claims a week, 3.00 a day, 3.00 per order");
}

// the owner's tool refuses a wrong --orders before reading any key or the network
{
  const run = (args) => spawnSync(process.execPath, ["owner.mjs", "approve", "0x2A17229184A773CbEb8729034b6016251D858D30", ...args], { cwd: join(ROOT, "aa"), encoding: "utf8" });
  const r3 = run(["--max-per-order", "2", "--orders", "3"]), r0 = run(["--orders", "0"]);
  check(r3.status === 2 && r0.status === 2 && /--orders 1\|2/.test(r3.stderr), "owner.mjs takes --orders 1 or 2 and nothing else");
  const src = readFileSync(join(ROOT, "aa", "owner.mjs"), "utf8"), shared = readFileSync(join(ROOT, "aa", "approval.mjs"), "utf8");
  check(/times: orders/.test(shared) && /approvalFile\(pub, \{ owner, sessionAddress, now, maxUsdc, orders \}\)/.test(src),
    "the number of orders goes into the key's rate limit (aa/approval.mjs, shared by owner.mjs and the owner's page)");
}

// new-key keeps the key before it, unprinted, and prints only the new address
{
  const dir = mkdtempSync(join(tmpdir(), "orvyn-newkey-")), f = join(dir, "orvyn-session.env");
  const env = { ...process.env, ORVYN_SESSION_KEY_FILE: f };
  const one = execFileSync(process.execPath, ["run.mjs", "new-key"], { cwd: join(ROOT, "aa"), env, encoding: "utf8" });
  const k1 = readFileSync(f, "utf8");
  const two = execFileSync(process.execPath, ["run.mjs", "new-key"], { cwd: join(ROOT, "aa"), env, encoding: "utf8" });
  const kept = readdirSync(dir).filter((x) => /^orvyn-session-\d{8}T\d{6}\.env$/.test(x));
  const hex = (s) => s.split("=")[1].trim().slice(2);
  check(kept.length === 1 && readFileSync(join(dir, kept[0]), "utf8") === k1 && readFileSync(f, "utf8") !== k1 && existsSync(f), "new-key keeps the key before it under a dated name and writes a new one");
  check(!one.includes(hex(k1)) && !two.includes(hex(k1)) && !two.includes(hex(readFileSync(f, "utf8"))) && /session_key_address/.test(two), "new-key prints the new address and no key");
}

// test L: its own log, state and transcript; the owner's messages fixed before the run
check(["L1", "L2", "L3"].every((k) => MESSAGES[k]) && /earbuds/.test(MESSAGES.L1) && /estimated delivery date/.test(MESSAGES.L2) && /withdraw/.test(MESSAGES.L3)
  && files("L1").log.endsWith("dL-log.jsonl") && files("L2").state.endsWith("dL-state.json") && files("D1").log.endsWith("dD-log.jsonl") && files("M1").log.endsWith("d6-log.jsonl"),
  "test L: messages L1 to L3 fixed, with their own log, state and transcript; D and the day 6 run keep theirs");

console.log(failed ? `DPREP FAIL (${failed})` : "d prep: pass");
process.exit(failed ? 1 : 0);
