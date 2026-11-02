// d6-log.jsonl as a readable transcript for the demo and the video: what the owner said, what the agent said and did, what
// Orvyn asked the owner, each OK to sign, and the cost of the model.
const short = (v, n = 600) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + " ..." : s; };

export function transcript(jsonl, title = "Day 6: an agent buys at TechShopping with Orvyn") {
  const rows = jsonl.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const out = [`# ${title}`, ""];
  let cost = 0, calls = 0;
  for (const r of rows) {
    const at = r.t.slice(11, 19) + " UTC";
    if (r.who === "start") out.push(`## ${r.message_id} (${r.t.slice(0, 10)}, model ${r.model})`, "");
    else if (r.who === "owner") out.push(`**Owner** (${at}): ${r.text}`, "");
    else if (r.who === "agent") {
      calls++; cost += r.usage?.cost || 0;
      if (r.text) out.push(`**Agent** (${at}): ${r.text}`, "");
      for (const c of r.tool_calls || []) out.push(`- calls \`${c.name}\` ${short(c.arguments, 300)}`);
      if (r.tool_calls?.length) out.push("");
    } else if (r.who === "tool") out.push(`- \`${r.name}\` returned: ${short(r.result)}`, "");
    else if (r.who === "owner_ok") out.push(`**Owner's OK to sign \`${r.sign}\`** (${at}): ${r.ok ? "yes" : "no"}`, "");
    else if (r.who === "mcp-asks-owner") out.push(`**Orvyn asks the owner** (${at}): ${r.message}`, `**Owner answers:** ${short(r.answer)}`, "");
    else if (r.who === "error" || r.who === "stop") out.push(`**Stopped** (${at}): ${r.text}`, "");
  }
  out.push(`Model calls: ${calls}. OpenRouter cost: ${cost.toFixed(4)} USD.`, "");
  return out.join("\n");
}
