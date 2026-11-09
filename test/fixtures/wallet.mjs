// A browser wallet for the tests (window.ethereum): it holds a throwaway key, gives its address, signs EIP-712 and forwards reads
// to Arc testnet. It refuses to sign anything else or to send a transaction.
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc.testnet.arc.io";
// the network as it was when this module loaded: a test may stub fetch to block the page's public RPC, never the wallet's own
const realFetch = globalThis.fetch;

export function testWallet(key) {
  const acct = privateKeyToAccount(key), asked = [];
  // as a wallet's provider does: the result, or the node's error with its code and data (a revert keeps its data)
  const rpc = async (method, params) => {
    const j = await (await realFetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
  return { asked, address: acct.address, async request({ method, params }) {
    asked.push(method);
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [acct.address];
    if (method === "eth_chainId") return "0x4cef52";
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
    if (method === "eth_signTypedData_v4") {
      if (params[0].toLowerCase() !== acct.address.toLowerCase()) throw new Error("another address");
      const td = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      const { EIP712Domain, ...types } = td.types;
      return acct.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
    }
    if (method === "personal_sign" || method === "eth_sign" || method === "eth_sendTransaction") throw new Error("the page must not ask for " + method);
    return rpc(method, params);
  } };
}

