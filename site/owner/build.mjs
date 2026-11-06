// Builds site/owner/owner.js from owner-src.mjs and aa/approval.mjs (ZeroDev and viem from aa/node_modules) with esbuild, pinned
// in aa/package.json:
//   node site/owner/build.mjs           writes owner.js
//   node site/owner/build.mjs --check   fails if owner.js is not what the sources build to
// owner.js is committed, so the page needs no build to be served.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const esbuild = createRequire(new URL("../../aa/package.json", import.meta.url))("esbuild");
const out = esbuild.buildSync({ entryPoints: [here + "owner-src.mjs"], bundle: true, format: "esm", platform: "browser", target: "es2022",
  minify: true, legalComments: "none", write: false, logLevel: "warning",
  // Node built ins that the page never reaches (shims/): ZeroDev's EIP-1193 provider class and its multi-chain serialization
  alias: { events: here + "shims/events.js", buffer: here + "shims/buffer.js" } }).outputFiles[0].text;
const file = here + "owner.js";
if (process.argv.includes("--check")) {
  let now = "";
  try { now = readFileSync(file, "utf8"); } catch {}
  if (now !== out) { console.error("owner.js is not up to date: run node site/owner/build.mjs"); process.exit(1); }
  console.log("owner.js is up to date (" + out.length + " bytes)");
} else {
  writeFileSync(file, out);
  console.log("owner.js written (" + out.length + " bytes)");
}
