// competitor-price-watch — extracts prices + nearby labels from any page.

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const PRICE_RE = /(?:[$£€]\s?)[\d.,]+(?:\s?(?:\/mo|\/month|per month|\/yr|\/year))?/i;

function navHint(navigateTo, tool) {
  return JSON.stringify(
    {
      status: "navigate_required",
      navigateTo,
      message: `Open ${navigateTo} with the navigate tool, then call ${tool} again.`,
    },
    null,
    2,
  );
}

function sameUrl(a, b) {
  try {
    const ua = new URL(a),
      ub = new URL(b, location.href);
    return ua.host === ub.host && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function readPrices(max = 20) {
  const out = [];
  const seen = new Set();
  // Walk small elements whose text is mostly a price; label = nearest heading in the card.
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length > 0) continue; // leaf nodes only
    const t = clean(el.textContent);
    if (!t || t.length > 24) continue;
    const m = t.match(PRICE_RE);
    if (!m || m[0].length < t.length - 2) continue;
    const card = el.closest("[class*='plan'], [class*='tier'], [class*='card'], li, section, div") || el;
    const label = clean(
      card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']")?.textContent || "",
    ).slice(0, 60);
    const key = `${label}|${m[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label || null, price: clean(m[0]) });
    if (out.length >= max) break;
  }
  return out;
}

if (!browser?.webfuseSession?.registerTool) {
  console.warn("[competitor-price-watch] registerTool unavailable");
} else {
  browser.webfuseSession.registerTool({
    name: "readPrices",
    description:
      "Extracts prices (and the nearest plan/product label) from the open page. If `url` is given and not open, returns {status:'navigate_required', navigateTo}.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Pricing page URL to read." } },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const url = clean(args?.url);
      if (url && !sameUrl(url, location.href)) return navHint(url, "readPrices");
      const prices = readPrices();
      return JSON.stringify({ url: location.href, count: prices.length, prices }, null, 2);
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
}
