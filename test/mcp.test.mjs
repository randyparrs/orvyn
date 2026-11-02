// The MCP server through the real protocol (in-memory transport) with a client: its tools, the owner's question and refusals.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../mcp/server.js";
import { createOrvyn } from "../sdk/index.js";
import { parseRules } from "../sdk/rules.js";
import { RULES, bytesOf, world } from "./world.mjs";

let failed = 0;
const check = (cond, what) => { console.log(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };

/** A connected client; owner answers the elicitation, or the client has no elicitation when owner is null. */
async function connect(owner, w) {
  const server = buildServer((askOwner) => { w.ask = askOwner; return w.orvynWith(askOwner); });
  const client = new Client({ name: "test", version: "1" }, { capabilities: owner ? { elicitation: {} } : {} });
  if (owner) client.setRequestHandler(ElicitRequestSchema, async (r) => owner(r.params));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const stage = (opts = {}) => {
  // the stand-in world, with the server's askOwner in place of a fixed answer
  let ask = async () => null;
  const w = world({ ...opts, ask: (q) => ask(q) });
  w.orvynWith = (a) => { ask = a; return w.orvyn; };
  return w;
};
const body = (r) => JSON.parse(r.content[0].text);

{
  const w = stage();
  const c = await connect(null, w);
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  check(names.join() === "open_claim,order_status,pay_link,rules,submit_evidence,withdraw", "six tools: pay_link, order_status, open_claim, submit_evidence, withdraw, rules");
  const claim = tools.find((t) => t.name === "open_claim");
  check(!Object.keys(claim.inputSchema.properties).some((k) => /proof/i.test(k)) && claim.inputSchema.properties.account.maxLength === 500, "open_claim takes no proof as an argument; account up to 500 characters");
  check(tools.find((t) => t.name === "order_status").annotations.readOnlyHint === true && tools.find((t) => t.name === "pay_link").annotations.destructiveHint === true, "tools marked read only or as spending");
  const r = await c.callTool({ name: "pay_link", arguments: { link: "https://paytenet.site/#pay/TS-476930" } });
  check(!r.isError && body(r).paid === true && w.sent.length === 2, "pay_link through the protocol");
  const s = await c.callTool({ name: "order_status", arguments: { order: "TS-171823" } });
  check(!s.isError && body(s).next.action === "claim", "order_status through the protocol");
  const ru = await c.callTool({ name: "rules", arguments: {} });
  check(body(ru).spent_today_usdc === 1, "rules shows what was spent");
  const nad = await c.callTool({ name: "open_claim", arguments: { order: "TS-171823", event: "not_as_described", account: "x", promised: "a", received: "b" } });
  check(nad.isError && body(nad).refused && /did not approve/.test(body(nad).error) && w.sent.length === 2, "a client that cannot ask the owner: the claim is not opened");
  const bad = await c.callTool({ name: "open_claim", arguments: { order: "TS-171823", event: "not_as_described", account: "x".repeat(501) } }).catch(() => ({ isError: true }));
  check(bad.isError === true, "an account over 500 characters is refused by the tool's schema");
}
{
  const w = stage();
  const seen = [];
  const c = await connect(async (p) => { seen.push(p); return { action: "accept", content: { approve: true, proof_kind: "label", proof: "Output 20 W" } }; }, w);
  const r = await c.callTool({ name: "open_claim", arguments: { order: "TS-171823", event: "not_as_described", account: "It is 20 W.", promised: "65 W", received: "20 W", delivered_date: "2026-10-30" } });
  const claim = JSON.parse(bytesOf(w.sent[0].data));
  check(!r.isError && claim.proof === "Output 20 W" && /proof from you/.test(seen[0].message) && seen[0].requestedSchema.properties.proof, "not_as_described: the owner is asked and the proof is theirs");
}
{
  const w = stage();
  const c = await connect(async () => ({ action: "decline" }), w);
  const r = await c.callTool({ name: "open_claim", arguments: { order: "TS-171823", event: "not_as_described", account: "x", promised: "a", received: "b" } });
  check(r.isError && !w.sent.length, "the owner declines: nothing signed");
}
{
  const w = stage({ rules: { ...RULES, max_per_order_usdc: 0.5 } });
  const c = await connect(null, w);
  const r = await c.callTool({ name: "pay_link", arguments: { link: "TS-476930" } });
  check(r.isError && body(r).refused && /limit per order/.test(body(r).error) && !w.sent.length, "a refusal reaches the agent as a clear error");
}
check(parseRules(RULES).max_per_order_units === 5000000 && typeof createOrvyn === "function", "rules parsed for the server");
console.log(failed ? `MCP FAIL (${failed})` : "mcp: pass");
process.exit(failed ? 1 : 0);
