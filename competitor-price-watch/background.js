// competitor-price-watch — Webfuse custom MCP tool (service worker; self-contained).
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

const PRICE_RE = /(?:[$£€]\s?)[\d.,]+(?:\s?(?:\/mo|\/month|per month|\/yr|\/year))?/i;
const HEADING_RE = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;

// Strip a chunk of HTML to plain text.
const stripTags = (h) => clean(String(h || "").replace(/<[^>]+>/g, " "));

// Parse prices + nearest preceding heading from an HTML snapshot string.
function parsePrices(html, max = 20) {
  const out = [];
  const seen = new Set();

  // Index every heading by its position so we can find the nearest one above a price.
  const headings = [];
  let hm;
  HEADING_RE.lastIndex = 0;
  while ((hm = HEADING_RE.exec(html)) !== null) {
    const text = stripTags(hm[1]).slice(0, 60);
    if (text) headings.push({ pos: hm.index, text });
  }
  const nearestLabel = (pos) => {
    let best = null;
    for (const h of headings) {
      if (h.pos <= pos) best = h.text;
      else break;
    }
    return best;
  };

  // Split into element-ish chunks of text, keep those that are mostly a price (leaf-like).
  const text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Match text between tags; record byte position for label lookup.
  const CELL_RE = />([^<>]+)</g;
  let cm;
  while ((cm = CELL_RE.exec(text)) !== null) {
    const t = clean(cm[1]);
    if (!t || t.length > 24) continue;
    const m = t.match(PRICE_RE);
    if (!m || m[0].length < t.length - 2) continue;
    const label = (nearestLabel(cm.index) || "").slice(0, 60);
    const price = clean(m[0]);
    const key = `${label}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label || null, price });
    if (out.length >= max) break;
  }
  return out;
}

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "readPrices",
    description:
      "Self-contained: navigates to the given pricing page `url`, then extracts prices and the nearest plan/product label. Returns {url, count, prices:[{label, price}]}.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Pricing page URL to read." } },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const url = clean(args?.url);
      if (!url) return JSON.stringify({ url: "", count: 0, prices: [], error: "missing url" });
      const target = abs(url, url);
      await goto(target);
      const html = await snapshotHtml();
      const prices = parsePrices(html || "");
      return JSON.stringify({ url: target, count: prices.length, prices });
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[competitor-price-watch] readPrices + finish registered");
} else {
  console.warn("[competitor-price-watch] registerTool unavailable");
}
