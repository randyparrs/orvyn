// The owner's rules, applied in code before anything is signed. The limit per order and the number of orders also go on chain
// (the session key's policies, aa/account.mjs); these checks give the agent a clear answer first and hold the rules that are
// decisions, not limits. A file with a missing or wrong field stops the server: nothing runs on defaults.
const CLAIM_MODES = ["auto", "ask_owner", "never"];
const EVENTS = ["late", "not_delivered", "not_as_described"];
const DAY = 86400, WEEK = 7 * DAY;

export function parseRules(r) {
  const bad = (what) => { throw new Error("rules: " + what); };
  if (!r || typeof r !== "object") bad("not an object");
  for (const k of ["max_per_order_usdc", "max_per_day_usdc"]) if (!(typeof r[k] === "number" && r[k] > 0)) bad(`${k} must be a positive number`);
  if (r.max_per_order_usdc > r.max_per_day_usdc) bad("max_per_order_usdc is above max_per_day_usdc");
  if (!(Number.isInteger(r.max_claims_per_week) && r.max_claims_per_week >= 0)) bad("max_claims_per_week must be a whole number");
  if (!r.claims || typeof r.claims !== "object") bad("claims is missing");
  for (const e of EVENTS) if (!CLAIM_MODES.includes(r.claims[e])) bad(`claims.${e} must be one of ${CLAIM_MODES.join(", ")}`);
  if (r.claims.not_as_described === "auto") bad("claims.not_as_described cannot be auto: the proof comes from the owner");
  return { max_per_order_units: Math.round(r.max_per_order_usdc * 1e6), max_per_day_units: Math.round(r.max_per_day_usdc * 1e6),
    max_claims_per_week: r.max_claims_per_week, claims: { ...r.claims } };
}

/** What the owner's rules say about a payment. ledger: { spends: [{ at, units }], claims: [{ at }] }, kept by the caller. */
export function checkPay(rules, ledger, units, now) {
  if (units > rules.max_per_order_units) return `the order is ${units / 1e6} USDC and the owner's limit per order is ${rules.max_per_order_units / 1e6} USDC`;
  const today = spentToday(ledger, now);
  if (today + units > rules.max_per_day_units) return `paying ${units / 1e6} USDC would pass the owner's daily limit of ${rules.max_per_day_units / 1e6} USDC (spent today: ${today / 1e6})`;
  return null;
}

export const spentToday = (ledger, now) => ledger.spends.filter((s) => s.at > now - DAY).reduce((n, s) => n + s.units, 0);
export const claimsThisWeek = (ledger, now) => ledger.claims.filter((c) => c.at > now - WEEK).length;

/** null to go ahead; otherwise why not. "ask_owner" passes only with the owner's yes in this call. */
export function checkClaim(rules, ledger, event, now, ownerSaidYes) {
  const mode = rules.claims[event];
  if (mode === undefined) return `the owner's rules do not cover the claim type ${event}`;
  if (mode === "never") return `the owner's rules do not allow claims of type ${event}`;
  if (mode === "ask_owner" && !ownerSaidYes) return `the owner has to approve a claim of type ${event}`;
  const n = claimsThisWeek(ledger, now);
  if (n >= rules.max_claims_per_week) return `the owner's limit is ${rules.max_claims_per_week} claims a week and ${n} were opened`;
  return null;
}
