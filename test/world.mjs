// A stand-in for the gateway's API and Arc's RPC, from public snapshots (fixtures/), with a signer that only records.
import { readFileSync } from "node:fs";
import { SEL } from "../sdk/encode.js";
import { createOrvyn } from "../sdk/index.js";
import { parseRules } from "../sdk/rules.js";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
export const BUYER = "0xd0f42a77331bd8fe051f857d246fa75e8b42ddac";
export const RULES = { max_per_order_usdc: 5, max_per_day_usdc: 10, max_claims_per_week: 2, claims: { late: "auto", not_delivered: "auto", not_as_described: "ask_owner" } };

export function world({ rules = RULES, ask, allowance = 0n, claimable = 0n, onChainTerms, ledger, now = 1793400000, patchCheckout = (c) => c, patchOrder = (o) => o, address = BUYER } = {}) {
  const net = { api: "https://api.test", rpc: "https://rpc.test", chainId: 5042002, escrow: "0x17FBCDF5c1780DfE29dcE5aFf2E3D3921d393798",
    usdc: "0x3600000000000000000000000000000000000000", windows: { response: "5 minutes", proof: "5 minutes" } };
  const sent = [], calls = [];
  const checkout = patchCheckout(fx("checkout")), order = patchOrder(fx("order-paid"));
  const reply = (o, status = 200) => ({ ok: status === 200, status, json: async () => o });
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith(net.api + "/api/checkout/")) return reply(checkout);
    if (String(url).startsWith(net.api + "/api/orders/")) return reply(order);
    if (url === net.rpc) {
      const { method, params } = JSON.parse(init.body);
      if (method === "eth_getTransactionReceipt") return reply({ result: { status: "0x1" } });
      const data = params[0].data.slice(2, 10);
      if (data === SEL.allowance) return reply({ result: "0x" + allowance.toString(16) });
      if (data === SEL.claimable) return reply({ result: "0x" + claimable.toString(16) });
      if (data === SEL.merchantTermsHash) return reply({ result: onChainTerms || checkout.terms.terms_hash });
    }
    return reply({ error: "not found" }, 404);
  };
  const signer = { address, sendTransaction: async (t) => { sent.push(t); return "0x" + String(sent.length).padStart(64, "0"); } };
  const led = ledger || { spends: [], claims: [] };
  const orvyn = createOrvyn({ net, signer, rules: parseRules(rules), ledger: led, askOwner: ask, fetchImpl, now: () => now, pollMs: 1 });
  return { orvyn, sent, calls, ledger: led, net, checkout, order, fetchImpl };
}

/** The text of an openClaim or submit: the bytes after selector, ref, offset and length. */
export function bytesOf(data) {
  const body = data.slice(10), len = parseInt(body.slice(128, 192), 16);
  return Buffer.from(body.slice(192, 192 + len * 2), "hex").toString("utf8");
}
