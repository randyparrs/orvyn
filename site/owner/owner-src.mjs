// The owner's page: the owner's browser wallet approves the agent's session key for one day. Built into owner.js
// (node site/owner/build.mjs) from aa/approval.mjs, the same code as aa/owner.mjs. The wallet only gives its address and signs two
// EIP-712 "Enable" messages; Arc is read through its public RPC; nothing is sent and nothing leaves the page but approvals.json.
import { createPublicClient, defineChain, http, isAddress } from "viem";
import { approvalFile, dayLimits, limitsInWords, ownerAccountAddress, MAX_PER_ORDER_USDC } from "../../aa/approval.mjs";

const RPC = "https://rpc.testnet.arc.io";
const ARC = { chainId: "0x4cef52", chainName: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: [RPC],
  blockExplorerUrls: ["https://explorer.testnet.arc.io"] };
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: ARC.nativeCurrency, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const REVIEW_FOR = 600; // a review older than 10 minutes is made again before signing

const $ = (id) => document.getElementById(id);
const state = { owner: null, account: null, review: null, file: null, busy: false, error: "" };

function show(id, on) { $(id).hidden = !on; }
function render() {
  $("owner-address").textContent = state.owner || "";
  $("agent-account").textContent = state.account || "";
  show("step-key", !!state.owner);
  show("step-review", !!state.review);
  show("step-done", !!state.file);
  $("btn-connect").disabled = state.busy;
  $("btn-review").disabled = state.busy || !state.owner;
  $("btn-sign").disabled = state.busy || !state.review;
  $("error").textContent = state.error;
  show("error", !!state.error);
  const list = $("limits-words");
  list.innerHTML = "";
  for (const line of state.review ? state.review.words : []) { const li = document.createElement("li"); li.textContent = line; list.appendChild(li); }
  $("review-account").textContent = state.account || "";
  if (state.file) {
    $("done-summary").textContent = `Approved key ${state.file.session_address} for account ${state.file.account}, until ${state.file.valid_until}: ` +
      `${state.file.orders} ${state.file.orders === 1 ? "order" : "orders"} of up to ${state.file.max_per_order_usdc.toFixed(2)} USDC.`;
  }
}
const fail = (e) => { state.busy = false; state.error = String(e?.shortMessage || e?.message || e).slice(0, 300); render(); };

async function connect() {
  const eth = window.ethereum;
  if (!eth) return fail("No browser wallet found. Open this page in a browser with a wallet such as MetaMask or Rabby.");
  state.busy = true; state.error = ""; render();
  try {
    const [address] = await eth.request({ method: "eth_requestAccounts" });
    if (!address) throw new Error("The wallet gave no address.");
    const id = await eth.request({ method: "eth_chainId" });
    if (String(id).toLowerCase() !== ARC.chainId) {
      try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.chainId }] }); }
      catch (e) { if (e && e.code === 4902) await eth.request({ method: "wallet_addEthereumChain", params: [ARC] }); else throw e; }
    }
    state.owner = address;
    state.account = await ownerAccountAddress(pub, eth);
    state.busy = false; render();
  } catch (e) { fail(e); }
}

function readForm() {
  const sessionAddress = $("f-session").value.trim();
  const maxUsdc = Number($("f-max").value), orders = Number($("f-orders").value);
  if (!isAddress(sessionAddress)) throw new Error("Paste the address of the agent's session key (0x followed by 40 hex characters).");
  if (sessionAddress.toLowerCase() === String(state.owner).toLowerCase()) throw new Error("That is your own wallet. Paste the agent's session key address.");
  if (!(maxUsdc > 0 && maxUsdc <= MAX_PER_ORDER_USDC)) throw new Error(`The limit per order is more than 0 and up to ${MAX_PER_ORDER_USDC} USDC.`);
  return { sessionAddress, maxUsdc, orders };
}

function review() {
  state.error = ""; state.file = null;
  try {
    const f = readForm(), now = Math.floor(Date.now() / 1000);
    state.review = { ...f, now, words: limitsInWords(dayLimits(now, f.maxUsdc, f.orders), f.sessionAddress) };
  } catch (e) { state.review = null; state.error = e.message; }
  render();
}

async function sign() {
  if (!state.review) return;
  const f = readForm();
  if (f.sessionAddress !== state.review.sessionAddress || f.maxUsdc !== state.review.maxUsdc || f.orders !== state.review.orders
    || Math.floor(Date.now() / 1000) - state.review.now > REVIEW_FOR) { review(); state.error = "The limits changed or the review is old: check them again, then sign."; render(); return; }
  state.busy = true; state.error = ""; render();
  try {
    const r = state.review;
    state.file = await approvalFile(pub, { owner: window.ethereum, sessionAddress: r.sessionAddress, now: r.now, maxUsdc: r.maxUsdc, orders: r.orders });
    const blob = new Blob([JSON.stringify(state.file, null, 1) + "\n"], { type: "application/json" });
    const a = $("download");
    a.href = URL.createObjectURL(blob);
    a.download = "approvals.json";
    state.busy = false; render();
    a.click();
  } catch (e) { fail(e); }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const act = t.getAttribute("data-action");
  if (act === "connect") connect();
  else if (act === "review") review();
  else if (act === "sign") sign();
});
document.addEventListener("input", (e) => { if (e.target.closest("#step-key") && state.review) { state.review = null; state.file = null; render(); } });
window.OrvynOwner = { state, render };
render();
