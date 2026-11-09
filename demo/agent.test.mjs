// The day 6 agent, offline: a scripted model in place of OpenRouter, the real MCP server code over the stand-in world (no chain,
// no gateway, a signer that only records), the store answered here. Then the real launch of the MCP server under the permission
// model with a signer that has no key. Nothing goes to the network.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, OWNER_WAIT_MS } from "../mcp/server.js";
import { SEL } from "../sdk/encode.js";
import { bytesOf, world } from "../test/world.mjs";
import { MESSAGES, MODEL, ROOT, SIGN_WAIT_MS, SYSTEM, mcpLaunch, openRouter, ownerAnswers, storeTools, turn } from "./agent.mjs";
import { transcript } from "./transcript.mjs";

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };
const KEY = "sk-or-test-0123456789abcdef";
const rows = [], log = (o) => rows.push({ t: new Date().toISOString(), step: "test", ...o });

// the store, answered here: the catalog with its scenario notes, and an order whose checkout the stand-in world knows
const storeCalls = [];
const storeFetch = async (url, init) => {
  storeCalls.push([String(url), init?.body || null]);
  if (String(url).endsWith("/store.json")) return { ok: true, json: async () => ({ products: [
    { id: "case", name: "Phone case", price: "1.00", currency: "USDC", scenario: "never arrives", description: "Clear phone case." },
    { id: "charger", name: "USB-C charger 65 W", price: "2.00", currency: "USDC", scenario: "not as described", description: "65 W." }] }) };
  if (String(url).endsWith("/api/buy")) return { ok: true, json: async () => ({ order: "TS-476930", checkout_url: "https://paytenet.site/#pay/TS-476930" }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

// a model that follows a script: each call returns the next message; it sees what the agent sends
const scripted = (steps) => { const seen = []; let i = 0; const llm = async (req) => { seen.push(JSON.parse(JSON.stringify(req))); return { message: steps[i++], usage: { cost: 0.001 } }; }; llm.seen = seen; return llm; };
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const say = (content, calls) => ({ role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) });

// the MCP server's real code over the stand-in world, with an owner who answers through ownerAnswers
let answers = [];
const w = world({ ask: (q) => asker(q) });
let asker = async () => null;
const server = buildServer((a) => { asker = a; return w.orvyn; });
const mcp = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: {} } });
mcp.setRequestHandler(ElicitRequestSchema, (r) => ownerAnswers(async () => answers.shift() ?? "n", log)(r.params));
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), mcp.connect(b)]);
const oks = [];
const confirmYes = async (c) => { oks.push(c); return true; };
const messages = [{ role: "system", content: SYSTEM("2026-11-02") }];

// M1: catalog, order, pay
{
  const llm = scripted([
    say("", [call("c1", "store_catalog", {})]),
    say("", [call("c2", "store_buy", { product: "case" })]),
    say("", [call("c3", "pay_link", { link: "https://paytenet.site/#pay/TS-476930" })]),
    say("Paid TS-476930."),
  ]);
  const r = await turn({ message: MESSAGES.M1, messages, llm, mcp, store: storeTools(storeFetch), confirm: confirmYes, log });
  check(r === "Paid TS-476930.", "M1: the agent's answer comes back when it stops calling tools");
  const names = llm.seen[0].tools.map((t) => t.function.name).sort().join();
  check(names === "open_claim,order_status,pay_link,rules,store_buy,store_catalog,submit_evidence,withdraw", "the model gets the 6 Orvyn tools and the 2 store tools");
  const cat = rows.find((x) => x.who === "tool" && x.name === "store_catalog").result;
  check(cat.length === 2 && cat.every((p) => !("scenario" in p)), "the catalog the agent sees has no test-scenario notes");
  check(storeCalls.some(([u, body]) => u.endsWith("/api/buy") && JSON.parse(body).product === "case"), "store_buy posts the product to the store");
  check(oks.length === 1 && oks[0].name === "pay_link" && w.sent.length === 2 && w.sent[0].data.startsWith("0x" + SEL.approve) && w.sent[1].data.startsWith("0x" + SEL.pay),
    "pay_link waits for the OK and then the MCP signs approve and pay");
  check(llm.seen[3].messages.filter((m) => m.role === "tool").length === 3 && llm.seen[3].messages.at(-1).tool_call_id === "c3", "each tool result goes back to the model with its call id");
}

// M4-like: not as described; the proof comes from the owner through the MCP's question, not from the agent
{
  answers = ["s", "label", "Output 20 W"];
  const before = w.sent.length;
  const llm = scripted([
    say("", [call("d1", "open_claim", { order: "TS-171823", event: "not_as_described", account: "A 20 W charger arrived instead of the 65 W one described.", promised: "65 W", received: "20 W", delivered_date: "2026-11-02" })]),
    say("Claim opened."),
  ]);
  await turn({ message: MESSAGES.M4, messages, llm, mcp, store: storeTools(storeFetch), confirm: confirmYes, log });
  const asked = rows.find((x) => x.who === "mcp-asks-owner");
  check(!!asked && asked.answer.proof === "Output 20 W" && asked.answer.proof_kind === "label", "the MCP asks the owner, and the owner's answer is logged");
  check(w.sent.length === before + 1 && bytesOf(w.sent.at(-1).data).includes("Output 20 W"), "the claim is signed with the owner's proof in it");
  check(!JSON.stringify(llm.seen[0].tools.find((t) => t.function.name === "open_claim").function.parameters).includes("proof\""), "open_claim offers the model no proof field");
}

// the owner declines to sign: nothing is sent and the agent is told
{
  const before = w.sent.length;
  const llm = scripted([say("", [call("e1", "withdraw", {})]), say("The owner declined.")]);
  await turn({ message: MESSAGES.M5, messages, llm, mcp, store: storeTools(storeFetch), confirm: async () => false, log });
  const res = rows.filter((x) => x.who === "tool" && x.name === "withdraw").at(-1).result;
  check(w.sent.length === before && res.declined === true && rows.some((x) => x.who === "owner_ok" && x.sign === "withdraw" && x.ok === false), "declined: no signature, the agent is told, the no is logged");
}

// broken arguments, an unknown tool, and a model that never stops
{
  const llm = scripted([say("", [call("f1", "order_status", "{not json"), call("f2", "transfer_all", {})]), ...Array(5).fill(say("", [call("g", "rules", {})]))]);
  const r = await turn({ message: "x", messages: [], llm, mcp, store: {}, confirm: confirmYes, log, maxSteps: 3 });
  const res = rows.filter((x) => x.who === "tool").slice(-4);
  check(res[0].result.error === "the arguments are not JSON" && /no such tool/.test(res[1].result.error), "bad arguments and unknown tools are answered, not run");
  check(r === null && rows.at(-1).who === "stop", "a model that never stops is cut after maxSteps model calls");
}

// OpenRouter: the request it gets and the answer it gives back
{
  let req;
  const llm = openRouter(KEY, async (u, init) => { req = { u, init }; return { ok: true, json: async () => ({ choices: [{ message: { content: null, tool_calls: [call("h", "rules", {})], reasoning: "x" } }], usage: { cost: 0.0004 } }) }; });
  const r = await llm({ messages: [{ role: "user", content: "hi" }], tools: [] });
  const body = JSON.parse(req.init.body);
  check(req.u === "https://openrouter.ai/api/v1/chat/completions" && req.init.headers.authorization === "Bearer " + KEY && body.model === MODEL && MODEL === "anthropic/claude-haiku-5.5" && body.usage.include === true,
    "OpenRouter: Haiku 5.5, the key only in the header, cost asked for");
  check(r.message.content === "" && r.message.tool_calls.length === 1 && !("reasoning" in r.message) && r.usage.cost === 0.0004, "OpenRouter's answer is kept as role, content and tool calls");
  const bad = openRouter(KEY, async () => ({ ok: false, status: 402, json: async () => ({ error: { message: "Insufficient credits" } }) }));
  check(await bad({ messages: [], tools: [] }).then(() => false, (e) => /Insufficient credits/.test(e.message)), "an OpenRouter error stops the turn with its message");
}

// the log and the transcript: everything is there, and no key
{
  const text = rows.map((r) => JSON.stringify(r)).join("\n");
  check(!text.includes(KEY), "the log has no OpenRouter key");
  const md = transcript(text);
  check(md.includes(MESSAGES.M1) && md.includes("`pay_link`") && md.includes("Orvyn asks the owner") && md.includes("Owner's OK to sign `withdraw`** (") && /OpenRouter cost: 0\.\d{4} USD/.test(md),
    "the transcript has the owner's words, the tool calls, the MCP's question, each OK and the cost");
}

// the time a tool that signs may take: the owner has 10 minutes, the agent waits a minute more for the MCP's answer
{
  const opts = {};
  const fake = { listTools: async () => ({ tools: [{ name: "open_claim", inputSchema: { type: "object" }, annotations: { destructiveHint: true } }, { name: "rules", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }),
    callTool: async (p, _schema, o) => { opts[p.name] = o; return { content: [{ type: "text", text: "{}" }] }; } };
  const llm = scripted([say("", [call("w1", "open_claim", { order: "TS-1" }), call("w2", "rules", {})]), say("done")]);
  await turn({ message: "x", messages: [], llm, mcp: fake, store: {}, confirm: confirmYes, log });
  check(OWNER_WAIT_MS === 600_000 && SIGN_WAIT_MS > OWNER_WAIT_MS && opts.open_claim?.timeout === SIGN_WAIT_MS && opts.rules === undefined,
    "a tool that signs may wait 11 minutes for the MCP, which gives the owner 10; read-only tools keep the default");
}

// the owner does not answer in time: no claim, nothing signed, the agent is told it waits for the owner; a late answer changes nothing
{
  const w2 = world({ ask: (q) => ask2(q) });
  let ask2 = async () => null;
  const srv = buildServer((a2) => { ask2 = a2; return w2.orvyn; }, { ownerWaitMs: 300 });
  const c2 = new Client({ name: "t3", version: "1" }, { capabilities: { elicitation: {} } });
  let late = 0;
  c2.setRequestHandler(ElicitRequestSchema, () => new Promise((res) => setTimeout(() => { late++; res({ action: "accept", content: { approve: true, proof_kind: "label", proof: "Output 20 W" } }); }, 800)));
  const [x1, x2] = InMemoryTransport.createLinkedPair();
  await Promise.all([srv.connect(x1), c2.connect(x2)]);
  const llm = scripted([
    say("", [call("n1", "open_claim", { order: "TS-171823", event: "not_as_described", account: "A 20 W charger arrived.", promised: "65 W", received: "20 W", delivered_date: "2026-11-02" })]),
    say("I asked you for the proof but got no answer, so the claim is not open yet. It is waiting for you."),
  ]);
  const r = await turn({ message: MESSAGES.M4, messages: [], llm, mcp: c2, store: {}, confirm: confirmYes, log });
  const res = rows.filter((x) => x.who === "tool" && x.name === "open_claim").at(-1).result;
  check(res.refused === true && /did not answer within .* so nothing was signed; this waits for the owner/.test(res.error) && w2.sent.length === 0,
    "no answer from the owner in time: the claim is refused, nothing is signed, and the agent is told it waits for the owner");
  check(llm.seen[1].messages.at(-1).content.includes("waits for the owner") && typeof r === "string", "the agent gets that answer and can tell the owner");
  await new Promise((res2) => setTimeout(res2, 1200));
  check(late === 1 && w2.sent.length === 0, "the owner's late answer arrives after the wait and nothing is signed");
  await c2.close();
}

// if the MCP itself never answers a tool that signs, the turn stops there; the caller closes the MCP
{
  const fake = { listTools: async () => ({ tools: [{ name: "withdraw", inputSchema: { type: "object" }, annotations: { destructiveHint: true } }] }),
    callTool: async () => { throw new Error("MCP error -32001: Request timed out"); } };
  const llm = scripted([say("", [call("t1", "withdraw", {})]), say("should not be asked")]);
  const stopped = await turn({ message: "x", messages: [], llm, mcp: fake, store: {}, confirm: confirmYes, log }).then(() => null, (e) => e.message);
  check(/nothing can be signed later/.test(stopped || "") && llm.seen.length === 1 && rows.at(-1).who === "stop", "a tool that signs with no answer from the MCP stops the turn; the model is not asked again");
}

// the real launch: MCP server under the permission model, a signer with no key; the owner's key file stays unreadable
{
  process.env.OPENROUTER_API_KEY = KEY;
  const dir = mkdtempSync(join(tmpdir(), "orvyn-d6-")), keyFile = join(dir, "orvyn-session.env"), ownerFile = join(dir, "orvyn-owner.env");
  writeFileSync(keyFile, "SESSION_KEY=0x" + "11".repeat(32) + "\n");
  writeFileSync(ownerFile, "OWNER_KEY=0x" + "22".repeat(32) + "\n");
  // the ledger file already holds another account's 3 claims and 1 of this wallet's: the server counts only its own wallet
  const dataDir = mkdtempSync(join(tmpdir(), "orvyn-d6-data-")), at = Math.floor(Date.now() / 1000) - 3600;
  writeFileSync(join(dataDir, "ledger.json"), JSON.stringify({ version: 2, wallets: {
    "0xe15cb50505878ecf42772d38eb022c00509ef02b": { spends: [], claims: [1, 2, 3].map((i) => ({ at, order: "TS-" + i, event: "not_delivered" })) },
    "0x00000000000000000000000000000000000d6d6d": { spends: [], claims: [{ at, order: "TS-4", event: "late" }] } } }));
  const launch = mcpLaunch({ sessionKeyFile: keyFile, signer: join(ROOT, "demo", "test-signer.mjs"), dataDir, extraArgs: ["--import", pathToFileURL(join(ROOT, "test", "probe-owner.mjs")).href] });
  check(!JSON.stringify(launch.env).includes(KEY) && !("OPENROUTER_API_KEY" in launch.env), "the MCP server's environment has no OpenRouter key");
  check(launch.args.includes("--permission") && !launch.args.some((x) => x.includes("orvyn-owner")), "launched with --permission and no path to the owner's key");
  launch.env.ORVYN_PROBE_FILE = ownerFile;
  const t = new StdioClientTransport(launch);
  let err = "";
  t.stderr.on("data", (d) => { err += d; });
  const c = new Client({ name: "t2", version: "1" });
  try {
    await c.connect(t);
    const r = JSON.parse((await c.callTool({ name: "rules", arguments: {} })).content[0].text);
    check(r.wallet === "0x00000000000000000000000000000000000d6d6d" && r.max_per_order_usdc === 3 && r.max_per_day_usdc === 3 && r.claims.not_as_described === "ask_owner" && r.claims.late === "auto",
      "the server starts as launched, with demo/rules.json: 3.00 per order, 3.00 a day, late claims alone, ask the owner for not as described");
    check(r.claims_this_week === 1 && r.max_claims_per_week === 3, "the server's weekly count is its wallet's own (1), not the other account's 3 in the same file");
  } catch (e) {
    check(false, "launch: " + e.message + " | " + err.slice(0, 400));
  } finally {
    await c.close().catch(() => {});
  }
  check(/PROBE owner key file: ERR_ACCESS_DENIED; allowed: false/.test(err), "code inside the launched server cannot read an owner's key file next to the session key");
}

await mcp.close();
console.log(failed ? `D6 AGENT FAIL (${failed})` : "d6 agent: pass");
process.exit(failed ? 1 : 0);
