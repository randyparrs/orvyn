#!/usr/bin/env node
// Orvyn's MCP server: pay a Tenet Pay link, follow the order, open a claim, send evidence, withdraw. Runs on the owner's machine.
//
//   ORVYN_RULES   the owner's rules (JSON, see rules.example.json). Without it the server does not start.
//   ORVYN_SIGNER  a module of the owner that exports { address, sendTransaction({ to, data }) }. Orvyn imports it and calls it;
//                  this server never reads, asks for or stores a key.
//   ORVYN_LEDGER  where the spend and claim counts are kept (no keys, no personal data). Default orvyn-ledger.json.
//
// A proof for "not as described" comes from the owner through MCP elicitation. No tool takes a proof as an argument, so the agent
// cannot write one. If the client cannot ask the owner, the claim is not opened.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createOrvyn, Refused, TESTNET } from "../sdk/index.js";
import { parseRules } from "../sdk/rules.js";

/** The owner has 10 minutes to answer; after that nothing is signed and the call says it waits for the owner. */
export const OWNER_WAIT_MS = 600_000;

/** The MCP server over an Orvyn instance; askOwner is set to the client's elicitation. Separate from main so tests can use it. */
export function buildServer(makeOrvyn, { ownerWaitMs = OWNER_WAIT_MS } = {}) {
  const server = new McpServer({ name: "orvyn", version: "0.1.0" });
  const ask = async (q) => {
    if (!server.server.getClientCapabilities()?.elicitation) return null;
    const message = q.kind === "claim"
      ? `Your agent wants to open a "${q.event}" claim on order ${q.order}. Its words: "${q.account}".` + (q.needs_proof ? " It needs proof from you: what the label, model or serial number shows." : "")
      : `Order ${q.order} needs proof from you: what the label, model or serial number of the item shows.`;
    const properties = { approve: { type: "boolean", title: "Approve" } };
    if (q.needs_proof || q.kind === "proof") Object.assign(properties, { proof_kind: { type: "string", title: "Kind of proof", enum: q.proof_kinds }, proof: { type: "string", title: "What it shows", maxLength: 200 } });
    let r;
    try {
      r = await server.server.elicitInput({ message, requestedSchema: { type: "object", properties, required: ["approve"] } }, { timeout: ownerWaitMs });
    } catch (e) {
      // a late answer goes nowhere: this request is over, and what needed it is refused
      if (/timed out/i.test(e.message)) throw new Refused(`the owner did not answer within ${Math.round(ownerWaitMs / 60000)} minutes, so nothing was signed; this waits for the owner`);
      throw e;
    }
    if (r.action !== "accept" || !r.content?.approve) return null;
    return { approved: true, proof: r.content.proof ? { kind: r.content.proof_kind, text: r.content.proof } : null };
  };
  const orvyn = makeOrvyn(ask);
  const tool = (name, description, shape, fn, annotations) => server.tool(name, description, shape, annotations || {}, async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(args), null, 1) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ refused: !!e.refused, error: e.message }) }] };
    }
  });
  const order = z.string().describe("Order number, for example TS-924455");
  tool("pay_link", "Pay a Tenet Pay payment link, inside the owner's limits. The money goes into escrow, not to the store. Refused if the store's terms do not match the escrow.",
    { link: z.string().describe("The payment link or the order number") }, ({ link }) => orvyn.payLink(link), { destructiveHint: true, title: "Pay a link" });
  tool("order_status", "An order's state: paid, store emails, claim, the judge's steps, the settlement and what comes next.",
    { order }, ({ order: n }) => orvyn.orderStatus(n), { readOnlyHint: true, title: "Order status" });
  tool("open_claim", "Open a claim on an order this wallet paid. An order takes one claim and it cannot be changed. For not_as_described the proof comes from the owner, who is asked; do not invent it.",
    { order, event: z.enum(["late", "not_delivered", "not_as_described"]), account: z.string().max(500).optional().describe("What happened, in plain facts. Not used for late: a late claim is the store's own emails"),
      promised: z.string().max(200).optional().describe("not_as_described: what the description promised, quoted"),
      received: z.string().max(200).optional().describe("not_as_described: what arrived"),
      delivered_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("not_as_described: the delivery date, YYYY-MM-DD") },
    ({ order: n, event, ...details }) => orvyn.openClaim(n, event, details), { destructiveHint: true, title: "Open a claim" });
  tool("submit_evidence", "Send what the escrow is waiting for from the buyer on an order: the store emails listed by Tenet, or the owner's proof, who is asked.",
    { order }, ({ order: n }) => orvyn.submitEvidence(n), { destructiveHint: true, title: "Send evidence" });
  tool("withdraw", "Withdraw this wallet's refunds from the escrow to the wallet.", {}, () => orvyn.withdraw(), { destructiveHint: true, title: "Withdraw" });
  tool("rules", "The owner's rules and what is left of the limits.", {}, () => orvyn.rulesStatus(), { readOnlyHint: true, title: "Owner's rules" });
  return server;
}

async function main() {
  const need = (k) => process.env[k] || (console.error(`${k} is not set`), process.exit(2));
  const rules = parseRules(JSON.parse(readFileSync(need("ORVYN_RULES"), "utf8")));
  const signer = (await import(pathToFileURL(need("ORVYN_SIGNER")).href)).default;
  const path = process.env.ORVYN_LEDGER || "orvyn-ledger.json";
  const ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { spends: [], claims: [] };
  const server = buildServer((askOwner) => createOrvyn({ net: TESTNET, signer, rules, ledger, askOwner, saveLedger: async (l) => writeFileSync(path, JSON.stringify(l, null, 1) + "\n") }));
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((e) => { console.error(e.message); process.exit(1); });
