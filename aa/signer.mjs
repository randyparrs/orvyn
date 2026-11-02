// A signer for the Orvyn SDK made of the session key: { address, sendTransaction, sendBatch }. Each call becomes a UserOp through the
// bundler, under the permission it belongs to: approve and pay go through `pay`, the rest through `claims`. A payment is one UserOp
// with both calls, because the pay permission counts UserOps. What the key may do is decided on chain (account.mjs), not here.
import { http } from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { entryPoint, sessionAccounts } from "./account.mjs";

export const BUNDLER = "https://public.pimlico.io/v2/5042002/rpc";
const PAY = new Set(["0x095ea7b3", "0x919aeb18"]); // approve, pay

// It takes the session key and the approvals made by the owner's tool (owner.mjs), never the owner's key.
export async function sessionSigner({ pub, sessionKey, approvals, bundlerUrl = BUNDLER }) {
  const { asPay, asClaims } = await sessionAccounts(pub, { sessionKey, approvals });
  const transport = http(bundlerUrl);
  const fees = async () => {
    const res = await fetch(bundlerUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "pimlico_getUserOperationGasPrice", params: [] }) });
    const j = await res.json();
    return { maxFeePerGas: BigInt(j.result.standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(j.result.standard.maxPriorityFeePerGas) };
  };
  const client = (account) => createBundlerClient({ account, client: pub, transport, entryPoint, userOperation: { estimateFeesPerGas: fees } });
  const send = async (account, calls) => {
    const c = client(account);
    const hash = await c.sendUserOperation({ calls });
    const r = await c.waitForUserOperationReceipt({ hash, timeout: 180_000 });
    if (!r.success) throw new Error(`user operation ${hash} failed: ${r.reason || "reverted"}`);
    return r.receipt.transactionHash;
  };
  const isPay = ({ data }) => PAY.has(data.slice(0, 10));
  const one = ({ to, data }) => ({ to, data, value: 0n });
  return {
    address: asPay.address, asPay, asClaims, client,
    sendTransaction: (t) => send(isPay(t) ? asPay : asClaims, [one(t)]),
    sendBatch: (calls) => send(calls.every(isPay) ? asPay : asClaims, calls.map(one)),
  };
}
