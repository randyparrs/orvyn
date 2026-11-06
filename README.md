# Orvyn, by Tenet

**Buyer protection for AI agents that buy.**

An agent that buys for a person pays through Orvyn. The money goes into an escrow on Arc, not straight to the store. If the owner
reports a problem (the order did not arrive, or what arrived is not what was described), the agent opens a claim. Tenet's judge on
GenLayer decides it under the store's published terms, and the escrow pays the refund back to the owner's account.

Orvyn runs on **Arc testnet** with testnet USDC. There is no mainnet deployment. Page: https://orvyn.paytenet.site

## The owner's key

**Keep the owner's key on another device or a hardware wallet, never on the agent's machine.**

The agent never holds it. The owner approves a session key for one day; the agent and the MCP server get only that session key and
the owner's approval, which holds the limits and the owner's signature and no private key. Run the MCP server under Node's
permission model (below) so it can read nothing else.

The owner approves the key from their own wallet on the owner's page (`site/owner/`): connect a browser wallet (MetaMask, Rabby, or
a hardware wallet through them), paste the session key's address, read the limits in words, and sign two EIP-712 messages. Nothing is
sent and nothing costs gas; the page downloads `approvals.json` for the agent's machine. `aa/owner.mjs` builds the same approval
from a test key in a file, for testnet runs; both use `aa/approval.mjs`, and a test checks they give the same file byte for byte.

## How it works

1. The owner sets rules and approves the agent's session key for one day with the owner's tool.
2. The agent places an order at a store that sells through Tenet Pay and gets a payment link.
3. The agent calls `pay_link`. Orvyn checks the owner's rules and the store's terms against the escrow, then pays. The money is
   held in escrow.
4. If something goes wrong, the agent calls `open_claim`. For "not as described", Orvyn asks the owner for the proof through MCP
   elicitation; the agent cannot write a proof.
5. The store has a window to answer. The judge decides; the result is settled on Arc.
6. The agent calls `withdraw` and the refund goes back to the owner's account.

What is enforced where:
- **On chain**, by the session key's policies: the limit per order, the number of orders, the end date, a gas budget, and calls
  only to the escrow (and USDC approvals to it).
- **In code**, before anything is signed: the daily total, the claims per week, and which claims the agent opens alone.

## Connect an agent

Orvyn is an MCP server (stdio). Any MCP client can use it. A client that supports elicitation can ask the owner; without it, claims
that need the owner are not opened.

```json
{
  "mcpServers": {
    "orvyn": {
      "command": "node",
      "args": [
        "--permission",
        "--allow-fs-read=/home/me/orvyn",
        "--allow-fs-read=/home/me/.orvyn/orvyn-session.env",
        "--allow-fs-read=/home/me/.orvyn/data",
        "--allow-fs-write=/home/me/.orvyn/data",
        "/home/me/orvyn/mcp/server.js"
      ],
      "env": {
        "ORVYN_RULES": "/home/me/orvyn/rules.json",
        "ORVYN_SIGNER": "/home/me/orvyn/aa/mcp-signer.mjs",
        "ORVYN_SESSION_KEY_FILE": "/home/me/.orvyn/orvyn-session.env",
        "ORVYN_APPROVALS": "/home/me/orvyn/aa/approvals.json",
        "ORVYN_LEDGER": "/home/me/.orvyn/data/ledger.json"
      }
    }
  }
}
```

Paths are placeholders. Node 24 takes one `--allow-fs-read` per path. Install first: `npm ci` here and in `aa/`.

| Variable | What it is |
|---|---|
| `ORVYN_RULES` | The owner's rules (JSON, see below) |
| `ORVYN_SIGNER` | The signer module; `aa/mcp-signer.mjs` signs with the session key and the owner's approval |
| `ORVYN_SESSION_KEY_FILE` | The agent's session key |
| `ORVYN_APPROVALS` | The owner's approval of that key (no private key in it) |
| `ORVYN_LEDGER` | Spend and claim counts (no keys, no personal data) |
| `ORVYN_RPC` | Optional; Arc testnet by default |

## The six tools

| Tool | What it does | Signs |
|---|---|---|
| `pay_link` | Pays a Tenet Pay payment link inside the owner's limits. The money goes into escrow, not to the store. Refused if the store's terms do not match the escrow. | yes |
| `order_status` | An order's state: paid, store emails, claim, the judge's steps, the settlement and what comes next. | no |
| `open_claim` | Opens a claim on an order this wallet paid: `late`, `not_delivered` or `not_as_described`. One claim per order. No proof field: the owner is asked. A `late` claim needs a delivery email verified by Lacre, which is not live on this network yet, so today it is refused. | yes |
| `submit_evidence` | Sends what the escrow is waiting for from the buyer: the store emails listed by Tenet, or the owner's proof (asked to the owner). | yes |
| `withdraw` | Withdraws this wallet's refunds from the escrow to the wallet. | yes |
| `rules` | The owner's rules and what is left of the limits. | no |

The owner has 10 minutes to answer a question from Orvyn. With no answer, nothing is signed and the agent is told the step waits
for the owner.

## The owner's rules

```json
{
  "max_per_order_usdc": 5,
  "max_per_day_usdc": 10,
  "max_claims_per_week": 3,
  "claims": { "late": "auto", "not_delivered": "auto", "not_as_described": "ask_owner" }
}
```

`claims` sets, per event, `auto` (the agent opens it), `ask_owner` (the owner approves) or `never`. A file with a missing or wrong
field stops the server.

## The session key

The owner's account is an ERC-4337 smart account (ZeroDev Kernel 3.3, EntryPoint 0.7) on Arc testnet. Two permissions, one key:
- **pay**: approve USDC to the escrow and pay into it, each up to the limit per order; a number of orders counted from the time the
  key was issued; an end date; a gas budget; no native value.
- **claims**: open a claim, submit evidence and withdraw USDC on the escrow, nothing else; an end date and a gas budget.

The agent creates the key (`node aa/run.mjs new-key`) and gives the owner its address; the owner approves it
(`node aa/owner.mjs approve <address> --max-per-order 2 --orders 2`). The first UserOp of each permission installs it.

Signed and simulated against Arc testnet, and refused by the policy: a USDC transfer to another address, an approve to another
spender, an approve or pay above the limit per order, native value, a third order on a key approved for two. On a local fork of
Arc (`aa/fork.test.mjs`): the claims permission paying or transferring, a withdraw of another token, a spent gas budget, a key past
its end date, and an approval with a limit changed by the agent.

## Demo

On 2026-11-02 a real agent (`anthropic/claude-haiku-5.5` through OpenRouter) bought two items at TechShopping, a test store,
through this MCP server, with every signature waiting for the owner's OK:
- a phone case that never arrived: the agent opened the claim alone, the store did not answer, REFUND 1.00 USDC;
- a charger that was not as described: Orvyn asked the owner for the proof, the store admitted it, REFUND 2.00 USDC;
- one withdrawal of 3.00 USDC.

The full run, message by message, is in [`demo/d6-transcript.md`](demo/d6-transcript.md), and on the page.

On 2026-11-03 the dispute path ran on Arc testnet with a new charger order: the store disputed the claim with a fact, the
closing round ran (the owner gave a closing proof through Orvyn and the store answered with another fact), and the judge decided
DENY (claim not proven); the 2.00 USDC went to the store. Before it, the agent declined to pay while the owner's daily limit had
no room and asked the owner. The run is in [`demo/dD-transcript.md`](demo/dD-transcript.md) and its log in `demo/dD-log.jsonl`.

## Repository

| Path | What it is |
|---|---|
| `sdk/` | The agent's side of Tenet Pay: payments, claims, evidence, withdrawals, the owner's rules |
| `mcp/` | The MCP server and an example of the owner's rules |
| `aa/` | The smart account and session key (`account.mjs`), its signer, the owner's tool (`owner.mjs`) and a step-by-step CLI (`run.mjs`) |
| `demo/` | The demo agent (`agent.mjs`), its rules and the day 6 transcript |
| `site/` | The page at orvyn.paytenet.site |
| `test/` | Tests for the SDK, the MCP server and the keys |
| `config.mjs` | Local settings: the environment or a `local.env` file (not in git) |

## Tests

`npm test` runs the suites that need no keys and no network (as CI does): the SDK's encoding against Tenet Pay's checkout code
(`TENET_PAY_DIR`, a checkout of github.com/randyparrs/tenet-pay), the SDK, the MCP server, the demo agent with a scripted model, and
the page in a simulated DOM.

Others need more: `test/keys.test.mjs` reads Arc testnet; `test/owner-page.test.mjs` and `site/test/owner.test.mjs` (add `--built`
for the bundle) check the owner's page against `aa/owner.mjs`, reading Arc testnet; `node site/owner/build.mjs` builds the page's
`owner.js` with esbuild (`--check` tells if it is up to date); `test/anvil.test.mjs` and `aa/fork.test.mjs` need Foundry's anvil and
Tenet's escrow built in tenet-pay's `tenet/` (the fork test copies Arc testnet locally).

## Not built yet

- Delivery verification: Orvyn does not check whether an order arrived; the owner says so.
- Approving from a phone wallet (WalletConnect).
- A daily USDC total on chain. Today the chain limits a key to a day, a number of orders and an amount per order (the daily
  limit is their product); a policy of its own that sums USDC per day is future work.
- Mainnet.

## License

MIT. See [LICENSE](LICENSE).
