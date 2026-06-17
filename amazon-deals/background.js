// amazon-deals — Webfuse custom MCP tool (service worker; self-contained).
// Registered in the service worker so it survives page navigation: the tool
// navigates to the deals page, waits for it to settle, reads a real (but small)
// DOM snapshot via the Automation API, and returns a small structured result.
//
// FIX HISTORY: this previously requested domSnapshot({maxTokens:8000}) which
// ERRORED on the deals page ("Could not produce snapshot below 8000 tokens" —
// the page is too big) and downsampled to markdown. It now requests a real,
// smaller snapshot with { quality:1, interactiveOnly:true, webfuseIDs:true }
// (exactly what the captured fixture was taken with) and parses real anchors.

const A = () => browser.webfuseSession.automation;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const abs = (h, base) => { try { return new URL(h, base).href; } catch { return h || ""; } };

// Navigate, then wait until the page settles before reading.
async function goto(url) {
  await A().navigate(url);
  await new Promise((res) => {
    let d = false;
    const f = () => { if (!d) { d = true; res(); } };
    try { A().once("page:stable", f); } catch { /* no event support */ }
    setTimeout(f, 8000);
  });
}

// Real DOM snapshot as an HTML string (service workers have no DOM to query).
// quality:1 keeps it lossless-ish; interactiveOnly + webfuseIDs shrink it enough
// to come back without the maxTokens error while preserving anchors & badges.
async function snapshotHtml(opts = {}) {
  return A().see.domSnapshot({ quality: 1, ...opts });
}

const DEALS_URL = "https://www.amazon.com/deals";
const BASE = "https://www.amazon.com";

// Decode the handful of HTML entities Amazon emits inside attributes / text.
function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

const PRICE_RE = /[$£€]\s?\d[\d.,]*/;
const DISCOUNT_RE = /(\d{1,2})\s?% ?off|-\s?(\d{1,2})\s?%|save\s+(\d{1,2})\s?%/i;
const ASIN_RE = /\/(?:dp|gp\/product|deal)\/(?:product\/)?([A-Z0-9]{10})\b/;

// Parse the deals-page HTML snapshot into a small list of products. There is no
// DOM in a service worker, so we walk product anchors with a regex and pull
// title / price / discount out of a window of markup around each one.
//
// We accept anchors whose href contains /dp/, /gp/product/ or /deal/ (the three
// shapes Amazon uses for deal tiles), dedupe by ASIN, and require a price in the
// surrounding markup so we skip pure-navigation chrome links.
function parse(html, max) {
  const src = String(html || "");
  const out = [];
  const seen = new Set();

  const anchorRe =
    /<a\b[^>]*\bhref=["']([^"']*\/(?:dp|gp\/product|deal)\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = anchorRe.exec(src)) !== null) {
    const rawHref = decode(m[1]);
    // Only keep links that actually point at a product (have a 10-char ASIN).
    const asinM = rawHref.match(ASIN_RE);
    if (!asinM) continue;
    const asin = asinM[1];
    if (seen.has(asin)) continue;

    const url = abs(rawHref, BASE).split("?")[0];
    const inner = m[2];

    // Window: the anchor itself plus a chunk of following markup, so we catch
    // price / discount badges rendered as siblings of the link inside the card.
    // Bound the window at the NEXT product anchor so one card's price/title can't
    // bleed into the following card (Amazon stacks tiles as flat siblings).
    const winStart = m.index;
    let win = src.slice(winStart, winStart + 1400);
    const nextAnchor = win.slice(1).search(/<a\b[^>]*\bhref=["'][^"']*\/(?:dp|gp\/product|deal)\/[^"']*["']/i);
    if (nextAnchor !== -1) win = win.slice(0, nextAnchor + 1);
    const winText = clean(decode(win.replace(/<[^>]+>/g, " ")));

    const priceM = winText.match(PRICE_RE);
    if (!priceM) continue; // skip anchors with no price (per contract)

    // Title preference: anchor text → alt= → aria-label= in the window.
    const innerText = clean(decode(inner.replace(/<[^>]+>/g, " ")));
    const altM = win.match(/\balt=["']([^"']+)["']/i);
    const ariaM = win.match(/\baria-label=["']([^"']+)["']/i);
    let title = innerText || (altM && clean(decode(altM[1]))) ||
      (ariaM && clean(decode(ariaM[1]))) || "";
    title = title.replace(PRICE_RE, "").trim().slice(0, 90);
    if (!title) title = asin;

    const discM = winText.match(DISCOUNT_RE);
    const discount = discM ? `${discM[1] || discM[2] || discM[3]}% off` : null;

    seen.add(asin);
    out.push({ title, price: clean(priceM[0]), discount, url });
    if (out.length >= max) break;
  }
  return { url: DEALS_URL, returned: out.length, deals: out };
}

const WF = typeof browser !== "undefined" ? browser : globalThis.browser;

if (WF?.webfuseSession?.registerTool) {
  WF.webfuseSession.registerTool({
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
      await goto("https://www.amazon.com/deals");
      const html = await snapshotHtml({ interactiveOnly: true, webfuseIDs: true });
      if (!html || !clean(html)) {
        return "Could not read the Amazon deals page (empty or blocked).";
      }
      return JSON.stringify(parse(html, max));
    },
  });

  WF.webfuseSession.registerTool({
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

// Export the pure parser for offline validation (no-op in the service worker).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parse, decode, abs, clean };
}
