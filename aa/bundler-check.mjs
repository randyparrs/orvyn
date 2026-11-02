// Read only: asks Pimlico's public bundler to estimate a UserOp for a throwaway account on Arc testnet. Nothing is sent: an estimate
// only simulates, and the account has no funds. It shows the endpoint takes this account's UserOps on the real network.
import { createPublicClient, http, encodeFunctionData, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createBundlerClient } from "viem/account-abstraction";
import { entryPoint, ownerApprovals, sessionAccounts } from "./account.mjs";

const USDC = "0x3600000000000000000000000000000000000000", ESCROW = "0x17FBCDF5c1780DfE29dcE5aFf2E3D3921d393798";
const BUNDLER = "https://public.pimlico.io/v2/5042002/rpc";
const chain = { id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } } };
const pub = createPublicClient({ chain, transport: http() });
const now = Math.floor(Date.now() / 1000);
const limits = { escrow: ESCROW, usdc: USDC, maxPerOrderUnits: 1_000_000n, interval: 86400, times: 7, startAt: now, validUntil: now + 7 * 86400, gasAllowed: parseEther("0.5") };
const sessionKey = privateKeyToAccount(generatePrivateKey());
const { asPay } = await sessionAccounts(pub, { sessionKey, approvals: await ownerApprovals(pub, { owner: privateKeyToAccount(generatePrivateKey()), sessionAddress: sessionKey.address, limits }) });
console.log("throwaway account", asPay.address, "deployed:", await asPay.isDeployed());
const data = encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [ESCROW, 1_000_000n] });
const client = createBundlerClient({ account: asPay, client: pub, transport: http(BUNDLER), entryPoint });
console.log("entry points:", (await client.getSupportedEntryPoints()).length, "chain", await client.getChainId());
try {
  const est = await client.estimateUserOperationGas({ calls: [{ to: USDC, value: 0n, data }], stateOverride: [{ address: asPay.address, balance: 10n ** 19n }] });
  console.log("estimate:", JSON.stringify(est, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
} catch (e) {
  console.log("bundler answer:", String(e.details || e.shortMessage || e.message).split("\n")[0].slice(0, 200));
}
