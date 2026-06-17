// markets-watch — Webfuse custom MCP tool (service worker; self-contained).
const A = () => browser.webfuseSession.automation;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function goto(url) {
  await A().navigate(url);
  await new Promise((res) => {
    let d = false;
    const f = () => { if (!d) { d = true; res(); } };
    try { A().once("page:stable", f); } catch {}
    setTimeout(f, 8000);
  });
}

async function snapshotHtml(opts = {}) {
  return A().see.domSnapshot({ quality: 1, ...opts });
}

// Click through any consent/cookie wall before reading the page.
async function dismissConsent(selectors = []) {
  for (const sel of selectors) {
    try {
      await A().act.click(sel, { waitForTarget: false });
      await A().wait(1500);
    } catch {}
  }
}

// --- HTML-string parsing helpers (no DOM in a service worker) ---

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

// Strip tags from an HTML fragment to get its text.
function textOf(html) {
  return clean(String(html || "").replace(/<[^>]*>/g, " "));
}

// Read the inner text of the first element bearing the given data-testid.
function byTestId(html, testid) {
  const re = new RegExp(
    `<([a-z0-9-]+)\\b[^>]*\\bdata-testid="${esc(testid)}"[^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i"
  );
  const m = html.match(re);
  return m ? textOf(m[2]) : "";
}

// Yahoo's current quote DOM annotates stat values with data-field on a <div>
// that carries the value in a `data-value` attribute (e.g. regularMarketDayRange,
// marketCap). Older/streamer markup used a `value` attribute on <fin-streamer>.
// Match by field name, preferring an entry scoped to this symbol; read
// data-value, then value, then inner text.
function field(html, symbol, name) {
  const sym = esc(symbol);
  const fld = esc(name);
  const tagRe = new RegExp(
    `<([a-z0-9-]+)\\b[^>]*\\bdata-field="${fld}"[^>]*>([\\s\\S]*?)<\\/\\1>`,
    "gi"
  );
  let best = "";
  let m;
  while ((m = tagRe.exec(html))) {
    const open = m[0].slice(0, m[0].indexOf(">"));
    const dv = open.match(/\bdata-value="([^"]*)"/i);
    const v = open.match(/\bvalue="([^"]*)"/i);
    const val = clean(dv ? dv[1] : v ? v[1] : textOf(m[2]));
    if (!val) continue;
    if (new RegExp(`\\bdata-symbol="${sym}"`, "i").test(open)) return val;
    if (!best) best = val;
  }
  return best;
}

// Stats are label/value pairs inside list items. Find the row whose text
// starts with the label, then return the remainder (fallback for field()).
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

// The first <h1> is the Yahoo Finance site logo; the quote name is the <h1>
// with the "heading" class. Prefer that, else the first non-"Yahoo Finance" h1.
function quoteName(html) {
  const re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let m;
  let fallback = "";
  while ((m = re.exec(html))) {
    const open = m[0].slice(0, m[0].indexOf(">"));
    const txt = textOf(m[1]);
    if (!txt) continue;
    if (/\bclass="[^"]*\bheading\b/i.test(open)) return txt;
    if (!fallback && !/^Yahoo Finance$/i.test(txt)) fallback = txt;
  }
  return fallback;
}

// Parse a Yahoo Finance quote page into a compact result.
function parse(html, symbol, url) {
  // Current Yahoo layout exposes the headline quote via data-testid.
  let price = byTestId(html, "qsp-price");
  let changePercent = byTestId(html, "qsp-price-change-percent");

  // Fallback to fin-streamer / data-field markup scoped to the symbol.
  if (!price) price = field(html, symbol, "regularMarketPrice");
  if (!changePercent) changePercent = field(html, symbol, "regularMarketChangePercent");

  // Normalise "(+0.95%)" -> "+0.95%".
  changePercent = clean(changePercent).replace(/^\(|\)$/g, "");

  if (!price) {
    return { symbol, url, error: "no quote data" };
  }

  const dayRange =
    field(html, symbol, "regularMarketDayRange") ||
    statByLabel(html, "Day's Range") ||
    null;
  const marketCap =
    field(html, symbol, "marketCap") ||
    statByLabel(html, "Market Cap") ||
    null;

  return {
    symbol,
    name: quoteName(html) || symbol,
    price: clean(price) || null,
    changePercent: changePercent || null,
    dayRange: dayRange || null,
    marketCap: marketCap || null,
    url,
  };
}

if (typeof browser !== "undefined" && browser?.webfuseSession?.registerTool) {
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
      const url = "https://finance.yahoo.com/quote/" + encodeURIComponent(symbol);
      await goto(url);
      await dismissConsent(['button[name="agree"]', ".accept-all", "#scroll-down-btn"]);
      await A().wait(1500);
      const html = await snapshotHtml();
      return JSON.stringify(parse(html, symbol, url));
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
} else if (typeof browser !== "undefined") {
  console.warn("[markets-watch] registerTool unavailable");
}

// Export for offline validation under Node (no-op in the service worker).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parse, quoteName, field, byTestId, statByLabel };
}
