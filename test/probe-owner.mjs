// Test only (keys.test.mjs): loaded into the MCP server's process with --import, it tries to read the owner's key file from inside
// that process, as a tool or a dependency gone bad would. It prints only whether it could; never the file.
import { readFileSync } from "node:fs";

const f = process.env.ORVYN_PROBE_FILE;
let r;
try { readFileSync(f); r = "read"; } catch (e) { r = e.code || e.message; }
process.stderr.write(`PROBE owner key file: ${r}; allowed: ${process.permission ? process.permission.has("fs.read", f) : "no permission model"}\n`);
