// The owner's approval of one session key, the same in aa/owner.mjs (a test key) and in the owner's page (site/owner/, the
// owner's browser wallet): the limits for one day, the approval file the agent gets, and the limits in words, shown before
// signing. The owner signs two EIP-712 "Enable" messages (pay and claims), off chain; nothing is sent and no key goes in the file.
import { parseEther } from "viem";
import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { entryPoint, kernelVersion, ownerApprovals } from "./account.mjs";
import { TESTNET } from "../sdk/index.js";

/** The agent's account, the one the owner's wallet opens (nothing is signed or sent: the wallet only gives its address). */
export async function ownerAccountAddress(publicClient, owner) {
  const sudo = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion });
  return (await createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo } })).address;
}

export const GAS_USDC = 0.3;
export const MAX_PER_ORDER_USDC = 5;
export const ORDERS = [1, 2];

/** The owner's limits for one day from now: a new key each day, so unused days never add up. */
export function dayLimits(now, maxUsdc, orders) {
  if (!(maxUsdc > 0 && maxUsdc <= MAX_PER_ORDER_USDC)) throw new Error(`the limit per order is between 0 and ${MAX_PER_ORDER_USDC} USDC`);
  if (!ORDERS.includes(orders)) throw new Error("the number of orders is 1 or 2");
  return { escrow: TESTNET.escrow, usdc: TESTNET.usdc, maxPerOrderUnits: BigInt(Math.round(maxUsdc * 1e6)), interval: 60, times: orders,
    startAt: now, validUntil: now + 86400, gasAllowed: parseEther(String(GAS_USDC)) };
}

const usd = (units) => (Number(units) / 1e6).toFixed(2);
const utc = (s) => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** What the owner is about to sign, in words, from the same limits object that goes into the policies. */
export function limitsInWords(limits, sessionAddress) {
  const per = usd(limits.maxPerOrderUnits), n = limits.times;
  return [
    `For 24 hours, from ${utc(limits.startAt)} to ${utc(limits.validUntil)}, the agent's key ${sessionAddress} can:`,
    `pay ${n === 1 ? "1 order" : n + " orders"} into Tenet Pay's escrow ${limits.escrow}, each up to ${per} USDC (at most ${usd(limits.maxPerOrderUnits * BigInt(n))} USDC in the day);`,
    `open claims, register evidence and withdraw refunds on that escrow;`,
    `spend up to ${GAS_USDC} USDC of gas for payments and ${GAS_USDC} USDC for claims.`,
    `It cannot send USDC to any other address, approve another spender or move native value.`,
  ];
}

/**
 * The approval file for a session key (what aa/owner.mjs writes as approvals.json). owner is a viem local account or the owner's
 * wallet (an EIP-1193 provider); publicClient reads Arc testnet. now is the issue time in seconds.
 */
export async function approvalFile(publicClient, { owner, sessionAddress, now, maxUsdc, orders }) {
  const limits = dayLimits(now, maxUsdc, orders);
  const approvals = await ownerApprovals(publicClient, { owner, sessionAddress, limits });
  const account = JSON.parse(atob(approvals.pay)).accountParams.accountAddress;
  return { account, session_address: sessionAddress, valid_until: new Date(limits.validUntil * 1000).toISOString(), orders: limits.times,
    max_per_order_usdc: maxUsdc, gas_usdc: GAS_USDC, ...approvals };
}
