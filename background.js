// amazon-deals — Webfuse custom MCP tool (service worker; self-contained).
// Registered in the service worker so it survives page navigation: each tool
// navigates to the page it needs, waits for it to settle, reads via the
// Automation API (no DOM in a service worker — parse the HTML snapshot), and
// returns a small structured result.

const A = () => browser.webfuseSession.automation;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const abs = (h, base) => { try { return new URL(h, base).href; } catch { return h || ""; } };

// Navigate, then wait until the page settles before reading.
async function goto(url) {
  await A().navigate(url);
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { A().once("page:stable", fin); } catch { /* no event support */ }
    setTimeout(fin, 8000);
  });
}

// Full-page HTML snapshot as a string (service workers have no DOM to query).
async function snapshotHtml(opts = {}) {
  return A().see.domSnapshot({ maxTokens: 8000, ...opts });
}

const DEALS_URL = "https://www.amazon.com/deals";

// Parse the deals page HTML snapshot into a list of products. No DOM available
// in a service worker, so we walk anchors with regex and pull title/price/
// discount out of the surrounding markup.
function parseDeals(html, max, base) {
  const out = [];
  const seen = new Set();
  // Match each product anchor and a chunk of markup that follows it.
  const anchorRe = /<a\b[^>]*\bhref=["']([^"']*\/(?:dp|gp)\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const rawHref = m[1];
    const url = abs(rawHref, base).split("?")[0];
    const id = (url.match(/\/dp\/([A-Z0-9]{8,})/) || [])[1] || url;
    if (seen.has(id)) continue;

    // Look at the anchor's inner HTML plus a window of markup after it so we
    // can catch price/discount badges rendered as siblings.
    const tail = html.slice(m.index, m.index + 1200);
    const text = clean(tail.replace(/<[^>]+>/g, " "));

    const priceM = text.match(/(?:[$£€]\s?)[\d.,]+/);
    if (!priceM) continue;

    seen.add(id);

    const discM = text.match(/(\d{1,2})%\s*off|-\s*(\d{1,2})%|save\s*(\d{1,2})%/i);
    const altM = tail.match(/\balt=["']([^"']+)["']/i);
    const title = clean(altM ? altM[1] : text).slice(0, 90);

    out.push({
      title,
      price: clean(priceM[0]),
      discount: discM ? `${discM[1] || discM[2] || discM[3]}% off` : null,
      url,
    });
    if (out.length >= max) break;
  }
  return out;
}

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "findDeals",
    description:
      "Navigates to amazon.com's Today's Deals page, reads it, and returns discounted products (title, price, discount, url) in a single self-contained call.",
    inputSchema: {
      type: "object",
      properties: {
        max_results: { type: "integer", description: "Max deals to return (default 12)." },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const max = Math.min(Math.max(args?.max_results || 12, 1), 30);
      await goto(DEALS_URL);
      const dom = await snapshotHtml();
      if (!dom || !clean(dom)) {
        return "Could not read the Amazon deals page (empty or blocked).";
      }
      const deals = parseDeals(dom, max, DEALS_URL);
      if (!deals.length) {
        return "No deals parsed from the Amazon deals page (page may be blocked, empty, or layout changed).";
      }
      return JSON.stringify({ url: DEALS_URL, returned: deals.length, deals }, null, 2);
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description:
      "Call when the task is complete. Pass a short result summary; its value is the final result.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[amazon-deals] findDeals + finish registered");
} else {
  console.warn("[amazon-deals] registerTool unavailable — only runs in a Webfuse session");
}
