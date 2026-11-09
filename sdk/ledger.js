// The MCP server's ledger file: what each agent wallet spent and claimed, for the owner's daily and weekly limits in code. One file
// keeps one ledger per wallet, so a new account (a new owner, or a new agent) starts at zero and never counts another's claims.
//   { "version": 2, "wallets": { "<wallet, lowercase>": { "spends": [...], "claims": [...] } } }
// A file in the first format (a single { spends, claims } for whichever wallet ran) is kept apart as "unassigned": it counts for no
// wallet, since it does not say whose it was. No keys and no personal data go in the file.

/** The file's content (parsed JSON, or nothing) as a book of ledgers. */
export function readBook(raw) {
  if (!raw) return { version: 2, wallets: {} };
  if (raw.version === 2 && raw.wallets && typeof raw.wallets === "object") return raw;
  if (Array.isArray(raw.spends) || Array.isArray(raw.claims)) return { version: 2, wallets: {}, unassigned: raw };
  throw new Error("ledger: not a ledger file");
}

/** The ledger of one wallet inside the book; the SDK adds to it and the caller saves the whole book. */
export function walletLedger(book, wallet) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(wallet))) throw new Error("ledger: the wallet is not an address");
  const k = String(wallet).toLowerCase();
  book.wallets[k] ||= { spends: [], claims: [] };
  return book.wallets[k];
}
