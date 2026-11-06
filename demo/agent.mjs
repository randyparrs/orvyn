// The demo agent: a model through OpenRouter buys at TechShopping, a test store, through Orvyn's MCP server. The owner's messages
// are fixed below; the model decides which tools to call. Every tool that signs waits for the owner's y/n in this terminal, and
// the MCP's question to the owner (elicitation) is answered here too. All that is said and done goes to a log (files()).
//   node demo/agent.mjs M1 ... M5     the day 6 run: sends that owner's message and lets the agent act until it answers
//   node demo/agent.mjs D1 ... D4     test D: the store disputes a claim with a fact, and the closing round
//   node demo/agent.mjs L1 ... L3     test L: an order that arrives late, claimed with the store's own emails verified on Lacre
// OPENROUTER_API_KEY comes from the environment; it is never printed, stored or passed to the MCP server. The MCP server runs under
// Node's permission model with the session key and the owner's approval only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { transcript } from "./transcript.mjs";
import { keysDir, setting } from "../config.mjs";

export const MODEL = "anthropic/claude-haiku-5.5";
export const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const HERE = join(ROOT, "demo"), STORE = "https://techshopping.site";
/** Each run keeps its own log, state and transcript: the day 6 demo (M1 to M5) and test D (D1 to D4). */
export const files = (id) => id.startsWith("L")
  // test L runs on a new account (the owner's browser wallet), so its MCP ledger (spends and claims) starts empty
  ? { log: join(HERE, "dL-log.jsonl"), state: join(HERE, "dL-state.json"), transcript: join(HERE, "dL-transcript.md"), title: "Test L: an order that arrives late",
      dataDir: join(HERE, "mcp-data-L") }
  : id.startsWith("D")
  ? { log: join(HERE, "dD-log.jsonl"), state: join(HERE, "dD-state.json"), transcript: join(HERE, "dD-transcript.md"), title: "Test D: the store disputes with a fact, and the closing round" }
  : { log: join(HERE, "d6-log.jsonl"), state: join(HERE, "state.json"), transcript: join(HERE, "d6-transcript.md"), title: "Day 6: an agent buys at TechShopping with Orvyn" };

/** The owner's messages, fixed before each run. */
export const MESSAGES = {
  M1: "Buy the clear phone case at TechShopping (techshopping.site) and pay for it with Orvyn.",
  M2: "The delivery date for the phone case has passed and it never arrived. Please handle it.",
  M3: "Now buy the 65 W USB-C charger at TechShopping and pay for it.",
  M4: "The charger arrived today, but it is not what was described: it is a 20 W charger, not 65 W. Please handle it.",
  M5: "Check both orders. If their refunds are settled, withdraw them.",
  // test D, fixed on 2026-11-02
  D1: "Buy the 65 W USB-C charger at TechShopping and pay for it with Orvyn.",
  // D1 ran before the daily limit had room; the agent asked instead of paying (kept in the log), and the owner answers:
  D1b: "The daily limit has reset now. Go ahead: buy the 65 W USB-C charger at TechShopping and pay for it with Orvyn.",
  D2: "The charger arrived today, but its label says Output 20 W, not 65 W. Please handle it.",
  D3: "The store disputed the charger claim. Check the order and send what Orvyn needs from us.",
  D4: "Check the charger order and tell me how it ended. If there is a refund, withdraw it.",
  // test L, fixed on 2026-11-06
  L1: "Buy the wireless earbuds at TechShopping and pay for them with Orvyn.",
  L2: "The earbuds arrived today, a day after the estimated delivery date in the store's emails. Please handle it.",
  L3: "Check the earbuds order and tell me how it ended. If there is a refund, withdraw it.",
};

export const SYSTEM = (date) => [
  "You are a shopping agent acting for your owner. You buy at online stores and pay through Orvyn's tools, which hold the payment in",
  "escrow and protect the purchase. Use store_catalog and store_buy to place an order, then pay_link with its checkout link.",
  "If something goes wrong with an order, open a claim with open_claim: pick the event that fits and write an honest, plain account",
  "of what the owner told you. Never write proof yourself; Orvyn asks the owner for it. Each tool that moves money or signs waits for",
  `the owner's approval; if the owner declines, do not retry. Today is ${date}. Keep your replies short.`,
].join(" ");

/** TechShopping's public catalog and checkout, as tools for the model. Not part of Orvyn: any store would have its own. */
export const storeTools = (fetchImpl = fetch) => ({
  store_catalog: {
    description: "TechShopping's catalog: product ids, names, prices and descriptions.",
    parameters: { type: "object", properties: {} },
    run: async () => {
      const s = await (await fetchImpl(STORE + "/store.json")).json();
      // only what a shopper sees; the store's notes on its test scenarios stay out
      return (s.products || []).map((p) => ({ id: p.id, name: p.name, price: p.price, currency: p.currency, description: p.description }));
    },
  },
  store_buy: {
    description: "Places an order at TechShopping for one product and returns the order number and its checkout link. Nothing is paid.",
    parameters: { type: "object", properties: { product: { type: "string", description: "The product id from store_catalog" } }, required: ["product"] },
    run: async ({ product }) => {
      const r = await fetchImpl(STORE + "/api/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) return { error: j.error || "http " + r.status };
      return { order: j.order, checkout_url: j.checkout_url };
    },
  },
});

/** The model through OpenRouter's chat completions with tools. */
export const openRouter = (key, fetchImpl = fetch) => async ({ messages, tools }) => {
  const r = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0, usage: { include: true } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !j.choices?.[0]) throw new Error("OpenRouter: " + (j.error?.message || "http " + r.status));
  const m = j.choices[0].message;
  return { message: { role: "assistant", content: m.content ?? "", ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) }, usage: j.usage || null };
};

/** How long a tool that signs may take: the MCP waits up to 10 minutes for the owner, and this waits a minute more for its answer. */
export const SIGN_WAIT_MS = 660_000;

/** One owner's message: the model answers and calls tools until it stops. confirm({ name, args }) -> boolean is asked before each tool that signs.
 * If a tool that signs gets no answer from the MCP in signWaitMs, the turn stops and the caller closes the MCP, so nothing can be signed later. */
export async function turn({ message, messages, llm, mcp, store, confirm, log, maxSteps = 12, signWaitMs = SIGN_WAIT_MS }) {
  const { tools: mcpTools } = await mcp.listTools();
  const signs = new Set(mcpTools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)), known = new Set(mcpTools.map((t) => t.name));
  const fn = (name, description, parameters) => ({ type: "function", function: { name, description, parameters } });
  const tools = [...mcpTools.map((t) => fn(t.name, t.description, t.inputSchema)), ...Object.entries(store).map(([n, t]) => fn(n, t.description, t.parameters))];
  const callMcp = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args }, undefined, signs.has(name) ? { timeout: signWaitMs } : undefined);
    const text = r.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return text; }
  };
  messages.push({ role: "user", content: message });
  log({ who: "owner", text: message });
  for (let i = 0; i < maxSteps; i++) {
    const { message: m, usage } = await llm({ messages, tools });
    messages.push(m);
    log({ who: "agent", text: m.content, tool_calls: (m.tool_calls || []).map((c) => ({ name: c.function.name, arguments: c.function.arguments })), usage });
    if (!m.tool_calls?.length) return m.content;
    for (const c of m.tool_calls) {
      const name = c.function.name;
      let args = null, result;
      try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* answered below */ }
      if (!args) result = { error: "the arguments are not JSON" };
      else if (store[name]) result = await store[name].run(args).catch((e) => ({ error: e.message }));
      else if (signs.has(name)) {
        const ok = await confirm({ name, args });
        log({ who: "owner_ok", sign: name, ok });
        if (!ok) result = { declined: true, error: "The owner declined to sign this. Do not retry." };
        else {
          try { result = await callMcp(name, args); } catch (e) {
            log({ who: "stop", text: `${name} got no answer from the MCP: ${e.message}` });
            throw new Error(`${name} got no answer from the MCP (${e.message}); the MCP is closed so nothing can be signed later`);
          }
        }
      } else if (known.has(name)) result = await callMcp(name, args);
      else result = { error: "no such tool: " + name };
      log({ who: "tool", name, args, result });
      messages.push({ role: "tool", tool_call_id: c.id, content: typeof result === "string" ? result : JSON.stringify(result) });
    }
  }
  log({ who: "stop", text: `more than ${maxSteps} model calls in one turn` });
  return null;
}

/** How the MCP server is started: the session key and the approval only, under the permission model, nothing else readable. */
export function mcpLaunch({ sessionKeyFile, signer = join(ROOT, "aa", "mcp-signer.mjs"), dataDir = join(HERE, "mcp-data"), extraArgs = [] }) {
  return {
    command: process.execPath, stderr: "pipe",
    args: ["--permission", `--allow-fs-read=${ROOT}`, `--allow-fs-read=${sessionKeyFile}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`, ...extraArgs, join(ROOT, "mcp", "server.js")],
    env: { ...getDefaultEnvironment(), ORVYN_RULES: join(HERE, "rules.json"), ORVYN_SIGNER: signer, ORVYN_SESSION_KEY_FILE: sessionKeyFile,
      ORVYN_APPROVALS: join(ROOT, "aa", "approvals.json"), ORVYN_LEDGER: join(dataDir, "ledger.json") },
  };
}

/** The MCP's question to the owner, answered by a person through ask(question) -> string. */
export const ownerAnswers = (ask, log) => async ({ message, requestedSchema }) => {
  const p = requestedSchema?.properties || {};
  console.log("\n=== Orvyn asks the owner ===\n" + message);
  const yes = /^[ys]/i.test((await ask("Approve? (y/n): ")).trim());
  const content = { approve: yes };
  if (yes && p.proof_kind) content.proof_kind = (await ask(`Kind of proof (${p.proof_kind.enum.join(", ")}): `)).trim();
  if (yes && p.proof) content.proof = (await ask("What it shows (text): ")).trim();
  log({ who: "mcp-asks-owner", message, answer: content });
  return yes ? { action: "accept", content } : { action: "decline" };
};

const EXPECT = {
  pay_link: "Pays into the escrow: approve and pay in one UserOp; the first time it also installs the pay permission. Expected: the order paid, the buyer is the owner's account.",
  open_claim: "Opens the claim; the first time it also installs the claims permission. Expected: the claim open on the escrow (for not_delivered and not_as_described, the store's 5 minute window).",
  withdraw: "Withdraws the refunds from the escrow to the account. Expected: claimable to 0 and the account up by the same.",
  submit_evidence: "Sends what the order waits for from the buyer: the store's emails verified on Lacre for a late claim, in one UserOp, or the owner's proof (the MCP asks the owner).",
};

async function main() {
  const id = process.argv[2];
  if (!MESSAGES[id]) { console.error("usage: node agent.mjs " + Object.keys(MESSAGES).join("|")); process.exit(2); }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error("OPENROUTER_API_KEY is not set in this terminal"); process.exit(2); }
  const sessionKeyFile = setting("ORVYN_SESSION_KEY_FILE") || join(keysDir(), "orvyn-session.env");
  for (const f of [sessionKeyFile, join(ROOT, "aa", "approvals.json")]) if (!existsSync(f)) { console.error("missing: " + f); process.exit(2); }
  const { log: LOG, state: STATE, transcript: TRANSCRIPT, title } = files(id);
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { messages: null, done: [] };
  if (state.done.includes(id)) { console.error(id + " was sent already"); process.exit(2); }
  state.messages ||= [{ role: "system", content: SYSTEM(new Date().toISOString().slice(0, 10)) }];

  const log = (o) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), step: id, ...o }) + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);
  const dataDir = files(id).dataDir || join(HERE, "mcp-data");
  mkdirSync(dataDir, { recursive: true });
  const transport = new StdioClientTransport(mcpLaunch({ sessionKeyFile, dataDir }));
  transport.stderr?.on("data", (d) => log({ who: "mcp-stderr", text: String(d).slice(0, 500) }));
  const mcp = new Client({ name: "orvyn-d6-agent", version: "1" }, { capabilities: { elicitation: {} } });
  mcp.setRequestHandler(ElicitRequestSchema, (r) => ownerAnswers(ask, log)(r.params));
  const gasPrice = async () => {
    const r = await fetch("https://rpc.testnet.arc.io", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }) });
    return (Number(BigInt((await r.json()).result)) / 1e9).toFixed(1) + " gwei";
  };
  const confirm = async ({ name, args }) => {
    console.log(`\n=== The agent wants to sign: ${name} ${JSON.stringify(args)} ===\n${EXPECT[name] || "Not in the plan: answer n."}`);
    console.log(`Gas price on Arc now: ${await gasPrice().catch(() => "could not read it")}.`);
    return /^[ys]/i.test((await ask("Sign? (y/n): ")).trim());
  };
  log({ who: "start", model: MODEL, message_id: id });
  const mark = state.messages.length;
  try {
    await mcp.connect(transport);
    const answer = await turn({ message: MESSAGES[id], messages: state.messages, llm: openRouter(key), mcp, store: storeTools(), confirm, log });
    console.log("\n=== The agent ===\n" + (answer ?? "(stopped: too many steps)"));
    state.done.push(id);
  } catch (e) {
    log({ who: "error", text: e.message });
    state.messages.length = mark; // a turn that failed leaves no half call behind; the log keeps it
    console.error("STOP: " + e.message);
    process.exitCode = 1;
  } finally {
    writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
    writeFileSync(TRANSCRIPT, transcript(readFileSync(LOG, "utf8"), title));
    rl.close();
    await mcp.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
