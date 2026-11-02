// Local settings: the environment first, then local.env at the repository root (kept out of git). None of these is a key; they
// are paths to the files and folders that hold them, or to code the tests compare with.
//   ORVYN_KEYS_DIR          the folder with the test keys: orvyn-owner.env (the owner's tool only) and orvyn-session.env (the agent)
//   ORVYN_FUNDER_KEY_FILE   a test wallet that funds the account (aa/run.mjs fund); ORVYN_FUNDER_KEY_NAME is its line, FUNDER_KEY by default
//   TENET_PAY_DIR           a checkout of github.com/randyparrs/tenet-pay; ../tenet-pay by default
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]$/, "");
const file = join(ROOT, "local.env");
const local = existsSync(file)
  ? Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]))
  : {};

export const setting = (name, fallback) => process.env[name] || local[name] || fallback;
export const keysDir = () => setting("ORVYN_KEYS_DIR") || (() => { throw new Error("ORVYN_KEYS_DIR is not set (environment or local.env)"); })();
export const tenetPayDir = () => setting("TENET_PAY_DIR", join(ROOT, "..", "tenet-pay"));
