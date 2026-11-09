// The MCP's ledger file, one ledger per agent wallet (sdk/ledger.js): counts never mix between accounts, and a file in the first
// format counts for no wallet. No network.
import { readBook, walletLedger } from "../sdk/ledger.js";
import { claimsThisWeek, spentToday } from "../sdk/rules.js";

let failed = 0;
const check = (c, what) => { console.log(`${c ? "ok  " : "BAD "} ${what}`); if (!c) failed++; };
const refused = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
const A = "0xE15cB50505878EcF42772d38eB022C00509EF02B", B = "0x296333E0223DeE30E08aaCA8cb8f94D194042306", now = 1794100000;

{
  const book = readBook(null);
  check(book.version === 2 && Object.keys(book.wallets).length === 0, "no file: an empty book");
  const a = walletLedger(book, A), b = walletLedger(book, B);
  a.claims.push({ at: now - 3600, order: "TS-1", event: "not_delivered" }, { at: now - 7200, order: "TS-2", event: "not_as_described" }, { at: now - 86400, order: "TS-3", event: "not_as_described" });
  a.spends.push({ at: now - 600, units: 2_000_000, order: "TS-1" });
  check(claimsThisWeek(b, now) === 0 && spentToday(b, now) === 0 && claimsThisWeek(a, now) === 3,
    "two wallets in one file: the claims and spends of one never count for the other");
  check(walletLedger(book, A.toLowerCase()) === a && Object.keys(book.wallets).join() === [A, B].map((x) => x.toLowerCase()).join(),
    "the wallet's address is its key, whatever its case");
  const saved = readBook(JSON.parse(JSON.stringify(book)));
  check(claimsThisWeek(walletLedger(saved, A), now) === 3 && claimsThisWeek(walletLedger(saved, B), now) === 0, "saved and read again: the same counts per wallet");
}
{
  const legacy = { spends: [{ at: now - 60, units: 1_000_000, order: "TS-9" }], claims: [{ at: now - 60, order: "TS-9", event: "late" }] };
  const book = readBook(legacy);
  check(book.unassigned === legacy && claimsThisWeek(walletLedger(book, B), now) === 0 && spentToday(walletLedger(book, B), now) === 0,
    "a file in the first format is kept apart as unassigned and counts for no wallet");
}
check(refused(() => readBook({ foo: 1 }), /not a ledger/) && refused(() => walletLedger(readBook(null), "me"), /not an address/),
  "a file that is not a ledger, or a wallet that is not an address: refused");

console.log(failed ? `LEDGER FAIL (${failed})` : "ledger: one per wallet");
process.exit(failed ? 1 : 0);
