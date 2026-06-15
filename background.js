// markets-watch — Webfuse custom MCP tool (service worker; self-contained).
const A = () => browser.webfuseSession.automation;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const abs = (h, base) => { try { return new URL(h, base).href; } catch { return h || ""; } };
async function goto(url) {
  await A().navigate(url);
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { A().once("page:stable", fin); } catch { /* no event support */ }
    setTimeout(fin, 8000);
  });
}
async function snapshotHtml(opts = {}) {
  return A().see.domSnapshot({ maxTokens: 8000, ...opts });
}

// --- HTML-string parsing helpers (no DOM in a service worker) ---

// Strip tags from an HTML fragment to get its text.
function textOf(html) {
  return clean(String(html || "").replace(/<[^>]*>/g, " "));
}

// Yahoo annotates quote values with data-field / data-symbol on <fin-streamer>,
// usually carrying the value in a `value` attribute. Match by field name,
// preferring the entry scoped to this symbol; read `value`, else inner text.
function field(html, symbol, name) {
  const sym = symbol.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const fld = name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  // Find all fin-streamer (or any) tags carrying the wanted data-field.
  const tagRe = new RegExp(`<([a-z0-9-]+)\\b[^>]*\\bdata-field="${fld}"[^>]*>([\\s\\S]*?)<\\/\\1>`, "gi");
  let best = "";
  let m;
  while ((m = tagRe.exec(html))) {
    const open = m[0];
    const attrs = open.slice(0, open.indexOf(">"));
    const valMatch = attrs.match(/\bvalue="([^"]*)"/i);
    const val = valMatch ? clean(valMatch[1]) : textOf(m[2]);
    if (!val) continue;
    // Prefer the streamer scoped to this exact symbol.
    if (new RegExp(`\\bdata-symbol="${sym}"`, "i").test(attrs)) return val;
    if (!best) best = val;
  }
  return best;
}

// Stats are label/value pairs inside list items / table rows. Find the row
// whose text starts with the label, then return the remainder.
function statByLabel(html, label) {
  const rowRe = /<(li|tr)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = rowRe.exec(html))) {
    const t = textOf(m[0]);
    if (t.toLowerCase().startsWith(label.toLowerCase())) {
      return clean(t.slice(label.length).replace(/^[:\s]+/, ""));
    }
  }
  return "";
}

function firstH1(html) {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? textOf(m[1]) : "";
}

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "getQuote",
    description:
      "Self-contained: navigates to a ticker's Yahoo Finance quote page and returns its live quote (name, price, day change %, day range, market cap). Pass `symbol` like 'AAPL', 'NVDA', or 'BTC-USD'.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker, e.g. 'AAPL' or 'BTC-USD'." } },
      required: ["symbol"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const symbol = clean(args?.symbol).toUpperCase();
      if (!symbol) throw new Error("symbol is required, e.g. 'AAPL'.");
      const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
      await goto(url);
      const html = await snapshotHtml();
      const price = field(html, symbol, "regularMarketPrice");
      const changePercent = field(html, symbol, "regularMarketChangePercent");
      if (!price && !changePercent) {
        return JSON.stringify({ symbol, error: "No quote data found (page empty or blocked).", url });
      }
      return JSON.stringify({
        symbol,
        name: firstH1(html) || symbol,
        price: price || null,
        changePercent: changePercent || null,
        dayRange: statByLabel(html, "Day's Range") || null,
        marketCap: statByLabel(html, "Market Cap") || null,
        url,
      });
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[markets-watch] getQuote + finish registered");
} else {
  console.warn("[markets-watch] registerTool unavailable");
}
