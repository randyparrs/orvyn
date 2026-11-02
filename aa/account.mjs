// The session key of Orvyn on a ZeroDev Kernel account (ERC-4337, EntryPoint 0.7): what the agent can do, in policies the
// chain enforces. The owner approves the key (ownerApprovals) and the agent only ever holds the key (sessionAccounts). Two
// permissions, one key:
//   pay     approve USDC to the escrow and pay, each up to the limit per order, one UserOp per interval, up to `days` times
//   claims  openClaim, submit and withdraw of USDC on the escrow, nothing else
// Both carry a gas policy (the key cannot burn the account's USDC as gas) and an end date. Neither can move value.
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { addressToEmptyAccount, createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { deserializePermissionAccount, serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import { CallPolicyVersion, ParamCondition, toCallPolicy, toGasPolicy, toRateLimitPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";

export const entryPoint = getEntryPoint("0.7");
export const kernelVersion = KERNEL_V3_3;

const approveAbi = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] }];
const escrowAbi = [
  { type: "function", name: "pay", stateMutability: "nonpayable", inputs: [{ name: "orderRef", type: "bytes32" }, { name: "merchant", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint128" }, { name: "expectedHold", type: "uint64" }, { name: "termsHash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "openClaim", stateMutability: "nonpayable", inputs: [{ name: "orderRef", type: "bytes32" }, { name: "claim", type: "bytes" }], outputs: [] },
  { type: "function", name: "submit", stateMutability: "nonpayable", inputs: [{ name: "orderRef", type: "bytes32" }, { name: "submission", type: "bytes" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
];

export function payPolicies({ escrow, usdc, maxPerOrderUnits, interval, times, startAt, validUntil, gasAllowed }) {
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_5, permissions: [
      { target: usdc, abi: approveAbi, functionName: "approve", valueLimit: 0n,
        args: [{ condition: ParamCondition.EQUAL, value: escrow }, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: maxPerOrderUnits }] },
      { target: escrow, abi: escrowAbi, functionName: "pay", valueLimit: 0n,
        args: [null, null, { condition: ParamCondition.EQUAL, value: usdc }, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: maxPerOrderUnits }, null, null] },
    ] }),
    // startAt anchors the windows to the key's issue date: with 0 they are all in the past and only the count limits it
    toRateLimitPolicy({ interval, count: times, startAt }),
    toTimestampPolicy({ validUntil }),
    toGasPolicy({ allowed: gasAllowed }),
  ];
}

export function claimPolicies({ escrow, usdc, validUntil, gasAllowed }) {
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_5, permissions: [
      { target: escrow, abi: escrowAbi, functionName: "openClaim", valueLimit: 0n, args: [null, null] },
      { target: escrow, abi: escrowAbi, functionName: "submit", valueLimit: 0n, args: [null, null] },
      { target: escrow, abi: escrowAbi, functionName: "withdraw", valueLimit: 0n, args: [{ condition: ParamCondition.EQUAL, value: usdc }] },
    ] }),
    toTimestampPolicy({ validUntil }),
    toGasPolicy({ allowed: gasAllowed }),
  ];
}

/**
 * The owner's side, outside the agent: the owner's wallet approves a session key it only knows by address. The result is two
 * strings (pay and claims) with the policies and the owner's enable signature, and no private key. owner is a viem local account
 * here; in production it is the owner's own wallet.
 */
export async function ownerApprovals(publicClient, { owner, sessionAddress, limits }) {
  const sudo = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion });
  const signer = await toECDSASigner({ signer: addressToEmptyAccount(sessionAddress) });
  const approve = async (policies) => {
    const regular = await toPermissionValidator(publicClient, { entryPoint, kernelVersion, signer, policies });
    return serializePermissionAccount(await createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo, regular } }));
  };
  return { pay: await approve(payPolicies(limits)), claims: await approve(claimPolicies(limits)) };
}

/** The agent's side: the account through the owner's approvals, signed by the session key alone. sessionKey is a viem local account. */
export async function sessionAccounts(publicClient, { sessionKey, approvals }) {
  const signer = await toECDSASigner({ signer: sessionKey });
  const open = (approval) => deserializePermissionAccount(publicClient, entryPoint, kernelVersion, approval, signer);
  return { asPay: await open(approvals.pay), asClaims: await open(approvals.claims) };
}
