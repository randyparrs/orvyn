// The Orvyn page in a simulated DOM (jsdom): console replay, demo tabs, copy buttons, collapsible transactions, scroll reveal,
// links. Animation frames and IntersectionObserver are driven by hand, so nothing depends on real time or layout.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const DIR = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");
const html = readFileSync(DIR + "/index.html", "utf8").replace(/<script src="app\.js[^"]*" defer><\/script>/, "");
const app = readFileSync(DIR + "/app.js", "utf8");
const data = JSON.parse(readFileSync(DIR + "/data.json", "utf8"));
let failed = 0;
const check = (c, what) => { console.log(`${c ? "ok  " : "BAD "} ${what}`); if (!c) failed++; };

function page({ reduce = false } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://orvyn.test/" });
  const w = dom.window, errors = [];
  w.addEventListener("error", (e) => errors.push(e.message));
  w.console.error = (...a) => errors.push(a.join(" "));
  w.matchMedia = (q) => ({ matches: reduce && /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
  let frames = [], now = 0;
  w.requestAnimationFrame = (f) => { frames.push(f); return frames.length; };
  const step = (ms) => { for (let t = 0; t < ms; t += 50) { now += 50; const f = frames; frames = []; f.forEach((x) => x(now)); } };
  const observed = [];
  w.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(t) { observed.push({ io: this, t }); } unobserve() {} disconnect() {} };
  const fire = (t, on) => { const o = observed.find((x) => x.t === t); o.io.cb([{ target: t, isIntersecting: on, intersectionRatio: on ? 0.5 : 0, intersectionRect: { height: on ? 200 : 0 } }]); };
  const copied = [];
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (s) => { copied.push(s); } } });
  w.fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(data)) });
  w.eval(app);
  return { w, d: w.document, step, fire, observed, copied, errors };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

const P = page();
await tick(); await tick();
const { d, w } = P;

// data rendered
check(d.querySelectorAll(".tool-card").length === 6 && d.querySelectorAll(".order-card").length === 2 && d.querySelectorAll(".total").length === 3 && d.querySelectorAll(".net-row").length === 7,
  "renders 6 tools, 2 orders, 3 totals, 7 network rows (both judges and the Lacre Router)");
check(d.querySelector('[data-render="mcp-config"]').textContent === JSON.stringify(data.mcp.clientConfig, null, 2), "the MCP config block shows data.json's config");

// console replay
const lines = () => d.querySelector('[data-console="scroller"]').children;
P.step(400);
check(lines().length >= 1 && /Owner/.test(lines()[0].textContent), "console: starts with the owner's first message");
P.step(20000);
const mid = lines().length;
check(mid > 5 && mid < data.console.lines.length, `console: plays forward (${mid} lines after 20 s)`);
d.querySelector("#console-toggle").click();
const paused = lines().length; P.step(5000);
check(lines().length === paused && d.querySelector("#console-toggle").getAttribute("aria-label") === "Play", "console: pause stops it");
d.querySelector("#console-toggle").click(); P.step(17500);
const full = [...lines()];
const text = d.querySelector('[data-console="scroller"]').textContent;
check(full.length === data.console.lines.length, `console: plays every line (${full.length} of ${data.console.lines.length})`);
check(data.console.lines.filter((l) => l.text).every((l) => text.includes(l.text)), "console: every text is complete, none left half typed");
check(/1\.00 USDC/.test(text) && /2\.00 USDC/.test(text) && d.querySelectorAll(".cl-verdict").length === 2, "console: both verdicts, REFUND 1.00 and 2.00 USDC");
check(d.querySelector('[data-console="turn"]').textContent === "message 5 of 5" && d.querySelectorAll(".console-marker").length === 5, "console: 5 owner messages, 5 markers");
P.step(5000);
check(lines().length < full.length, "console: loops back to the start after the end");
d.querySelector("#console-seek-4").click();
const seekLast = lines()[lines().length - 1]; P.step(3000);
check(seekLast.classList.contains("cl-owner") && /charger arrived today/.test(seekLast.textContent) && d.querySelector('[data-console="turn"]').textContent === "message 4 of 5", "console: a marker jumps to that owner message and types it");
d.querySelector("#console-replay").click();
check(lines().length <= 1, "console: replay starts over");

// demo tabs, both directions
const tabs = [...d.querySelectorAll(".tab")], cur = () => tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
const owner = () => d.querySelector('[data-demo="owner"]').textContent, items = () => d.querySelector("#demo-panel").children.length;
check(tabs.length === 5 && cur() === 0 && owner() === data.demo.steps[0].owner && d.querySelector("#demo-prev").disabled, "tabs: M1 first, Previous disabled");
let ok = true;
for (let i = 1; i < 5; i++) { d.querySelector("#demo-next").click(); ok &&= cur() === i && owner() === data.demo.steps[i].owner && items() === data.demo.steps[i].items.length; }
check(ok && d.querySelector("#demo-next").disabled && d.querySelector('[data-demo="count"]').textContent === "M5 of 5", "tabs: Next goes M1 to M5 with each step's items; Next disabled at M5");
ok = true;
for (let i = 3; i >= 0; i--) { d.querySelector("#demo-prev").click(); ok &&= cur() === i && owner() === data.demo.steps[i].owner && items() === data.demo.steps[i].items.length; }
check(ok && d.querySelector("#demo-prev").disabled, "tabs: Previous goes M5 back to M1");
tabs[3].click(); check(cur() === 3, "tabs: a click selects that tab");
const key = (k) => d.querySelector('[role="tablist"]').dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true }));
key("ArrowRight"); const r1 = cur(); key("ArrowLeft"); key("ArrowLeft"); const r2 = cur(); key("End"); const r3 = cur(); key("Home"); const r4 = cur();
check(r1 === 4 && r2 === 2 && r3 === 4 && r4 === 0, "tabs: arrow keys, Home and End");
d.querySelector("#demo-next").click(); d.querySelector("#demo-next").click(); d.querySelector("#demo-next").click();
check(d.querySelector("#demo-panel .ask") && /Output 20 W/.test(d.querySelector("#demo-panel").textContent), "tabs: M4 shows Orvyn's question and the owner's answer");

// copy buttons
d.querySelector("#copy-config").click(); await tick();
d.querySelector("#copy-rules").click(); await tick();
check(P.copied[0] === JSON.stringify(data.mcp.clientConfig, null, 2) && P.copied[1] === JSON.stringify(data.rules.example, null, 2), "copy: config and rules go to the clipboard as shown");
check(d.querySelector("#copy-config").textContent === "Copied", "copy: the button says Copied");
await new Promise((r) => setTimeout(r, 1700));
check(d.querySelector("#copy-config").textContent === "Copy", "copy: and goes back to Copy");

// collapsible transactions
const toggles = [...d.querySelectorAll(".tx-toggle")], lists = [...d.querySelectorAll(".tx-list")];
check(lists.every((l) => l.hidden) && toggles.every((t) => t.getAttribute("aria-expanded") === "false"), "transactions: closed at first");
toggles[0].click();
check(lists.every((l) => !l.hidden) && toggles.every((t) => t.getAttribute("aria-expanded") === "true" && /Hide/.test(t.textContent)), "transactions: open (both cards together)");
toggles[1].click();
check(lists.every((l) => l.hidden), "transactions: close again");
const txLinks = [...d.querySelectorAll(".tx-link, .total-link")].map((a) => a.href);
const okLink = (u) => /^https:\/\/explorer\.testnet\.arc\.io\/tx\/0x[0-9a-f]{64}$/.test(u) || /^https:\/\/scan\.bradbury\.genlayer\.com\/tx\/0x[0-9a-f]{64}$/.test(u);
check(txLinks.length && txLinks.every(okLink), `transactions: ${txLinks.length} links, each to the Arc or GenLayer explorer with a full hash`);
const gl = [...d.querySelectorAll(".tx-link")].filter((a) => /genlayer/.test(a.href)).map((a) => a.closest("li").textContent);
check(gl.length === 2 && gl.every((t) => /judge/.test(t)), "transactions: the judge steps go to GenLayer, the rest to Arc");

// scroll reveal, down and up, again and again
const rv = [...d.querySelectorAll("[data-reveal]")];
const e = rv[5];
check(rv.length > 20 && P.observed.length === rv.length && d.documentElement.classList.contains("motion"), `reveal: ${rv.length} elements observed`);
const seq = [];
for (const on of [true, false, true, false, true]) { P.fire(e, on); seq.push(e.classList.contains("is-in")); }
check(seq.join() === "true,false,true,false,true", "reveal: plays when it enters, resets when it leaves, and plays again each time");
check(/\.motion \[data-reveal\]/.test(readFileSync(DIR + "/styles.css", "utf8")) && /\.is-in/.test(readFileSync(DIR + "/styles.css", "utf8")), "reveal: the CSS has the hidden and shown states");

// reduced motion: everything shown at once, console complete, nothing hidden
{
  const R = page({ reduce: true }); await tick(); await tick(); R.step(200);
  check(R.d.querySelector('[data-console="scroller"]').children.length === data.console.lines.length && !R.d.documentElement.classList.contains("motion"), "reduced motion: full console, no reveal animation");
  check(!R.d.querySelector('[data-note="owner-panel"]').closest("[hidden]") && R.d.querySelector('[data-link="owner-header"]'), "reduced motion: the owner panel's button and line are there at once");
}

// what the page says: only what Orvyn does today
const body = d.body.textContent;
check(/If the owner reports a problem, the agent opens a claim/.test(body) && !/If something goes wrong, it opens a claim/.test(body), "the owner reports a problem; Orvyn does not detect it");
check(d.querySelector('[data-link="hero-how"]').textContent === "How it works" && !/Read the docs/.test(body), "the hero's second link is How it works");
check(data.console.lines.concat(data.demo.steps.flatMap((s) => s.items)).every((x) => !/photos of the label/.test(x.text || "")) && /window to respond\. \.\.\.$/.test(data.demo.steps[3].items.at(-1).text), "the agent's M4 words are cut before the part that is not right");
check(/Could not load the demo data\./.test(readFileSync(DIR + "/app.js", "utf8")) && !/http\.server/.test(readFileSync(DIR + "/app.js", "utf8")), "no developer text in the error message");

const icon = readFileSync(DIR + "/favicon.svg", "utf8");
check(d.querySelector('link[rel="icon"]')?.getAttribute("href") === "favicon.svg" && /^<svg[\s>]/.test(icon) && !/<script|\son\w+=|href=/i.test(icon), "the page has its icon: an O with Tenet's plus, plain SVG");

const status = d.querySelector(".status-note");
check(/^Dispute path tested on Arc testnet: the store disputed with a fact, the closing round ran and the judge decided DENY \(claim not proven\)\./.test(status.textContent) && !/Not shown on this page yet/.test(body)
  && status.querySelector('[data-link="status-dispute-transcript"]').getAttribute("href") === "https://github.com/randyparrs/orvyn/blob/main/demo/dD-transcript.md"
  && status.querySelector('[data-link="status-dispute-verdict"]').getAttribute("href") === "https://scan.bradbury.genlayer.com/tx/0x854c2015c6ee27d03cf1d7bf872b9f7204509ba43bbad610978b694067bec749",
  "Status: the dispute path tested on Arc testnet, with its transcript and the verdict on GenLayer");
const lateNote = d.querySelector('[data-note="late"]'), ownerNote = d.querySelector('[data-note="owner"]'), lateRun = d.querySelector('[data-note="late-run"]');
check(/^Late path tested on Arc testnet and GenLayer Bradbury Phase 2: .*REFUND 1\.50 USDC \(50%, per policy\)\./.test(lateNote.textContent)
  && lateNote.querySelector('[data-link="status-late-transcript"]').getAttribute("href") === "https://github.com/randyparrs/orvyn/blob/main/demo/dL-transcript.md"
  && lateNote.querySelector('[data-link="status-late-verdict"]').getAttribute("href") === "https://scan.bradbury.genlayer.com/tx/0xe7fd9a6dedb3ec5adff2083135fe40dc2e0e1d7ee9278b2e567540b1f764747c",
  "Status: the late path tested (test L), with its transcript and the verdict on GenLayer");
check(ownerNote.querySelector('[data-link="status-owner-page"]').getAttribute("href") === "owner/" && /browser wallet/.test(ownerNote.textContent)
  && !/signing the owner's approval from a wallet/.test(body) && /approving from a phone wallet/.test(body),
  "Status: the owner panel is linked; signing from a wallet is no longer listed as not built, a phone wallet is");
const ownerBtn = d.querySelector('[data-link="owner-header"]'), ghBtn = d.querySelector('[data-link="github-header"]');
check(ownerBtn && ownerBtn.getAttribute("href") === "owner/" && !ownerBtn.hasAttribute("target") && ownerBtn.textContent.trim() === "Owner panel"
  && ownerBtn.nextElementSibling === ghBtn && ownerBtn.classList.contains("btn-github"),
  "header: an Owner panel button just left of GitHub, with the same bordered style, opening /owner/ in the same tab");
const sessionLine = d.querySelector('#session [data-note="owner-panel"]');
check(sessionLine && sessionLine.textContent.trim() === "Approve your agent's key in the owner panel." && sessionLine.querySelector('[data-link="session-owner-panel"]').getAttribute("href") === "owner/",
  "The session key: the line Approve your agent's key in the owner panel., linked to /owner/");
check(!/[–—]/.test(readFileSync(DIR + "/index.html", "utf8")), "no long dashes in the page");
check(/Another run: an order that arrived late/.test(lateRun.textContent) && /REFUND 1\.50 USDC per policy/.test(lateRun.textContent)
  && lateRun.querySelector('[data-link="demo-late-transcript"]').getAttribute("href") === "https://github.com/randyparrs/orvyn/blob/main/demo/dL-transcript.md",
  "Demo: test L, the late run, with its transcript");

// links and errors
const href = (k) => d.querySelector(`[data-link="${k}"]`)?.getAttribute("href");
check(href("github-header") === "https://github.com/randyparrs/orvyn" && href("github-footer") === "https://github.com/randyparrs/orvyn", `links: GitHub (now "${href("github-header")}")`);
check(href("tenet-footer") === "https://paytenet.site", `links: Tenet (now "${href("tenet-footer")}")`);
check(P.errors.length === 0, "no script errors" + (P.errors.length ? ": " + P.errors.slice(0, 2).join(" | ") : ""));
console.log(failed ? `PAGE FAIL (${failed})` : "page: pass");
process.exit(failed ? 1 : 0);
