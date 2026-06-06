// amazon-deals — a Webfuse custom MCP tool that reads amazon.com's deals page.
//
// Tools READ the currently-open page; the caller navigates. If the deals page
// isn't open, findDeals returns a navigate_required hint with the URL to open.

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abs = (h) => {
  try {
    return new URL(h, location.href).href;
  } catch {
    return h || "";
  }
};

function navHint(navigateTo, tool) {
  return JSON.stringify(
    {
      status: "navigate_required",
      navigateTo,
      message: `Open ${navigateTo} with the navigate tool, then call ${tool} again with the same arguments.`,
    },
    null,
    2,
  );
}

async function waitFor(fn, { timeout = 12000, interval = 300 } = {}) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    try {
      v = fn();
      if (v) return v;
    } catch {
      /* keep polling */
    }
    await sleep(interval);
  }
  return v || null;
}

function readDeals(max) {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/"]')) {
    const card = a.closest("[data-testid], li, div") || a;
    const txt = clean(card.innerText || a.textContent);
    const priceM = txt.match(/(?:[$£€]\s?)[\d.,]+/);
    if (!priceM) continue;
    const url = abs(a.getAttribute("href")).split("?")[0];
    const id = (url.match(/\/dp\/([A-Z0-9]{8,})/) || [])[1] || url;
    if (seen.has(id)) continue;
    seen.add(id);
    const discM = txt.match(/(\d{1,2})%\s*off|-\s*(\d{1,2})%|save\s*(\d{1,2})%/i);
    const title = clean(card.querySelector("img")?.getAttribute("alt") || txt).slice(0, 90);
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

if (!browser?.webfuseSession?.registerTool) {
  console.warn("[amazon-deals] registerTool unavailable — only runs in a Webfuse session");
} else {
  browser.webfuseSession.registerTool({
    name: "findDeals",
    description:
      "Reads amazon.com's Today's Deals page and returns discounted products (title, price, discount, url). If the deals page isn't open, returns {status:'navigate_required', navigateTo}.",
    inputSchema: {
      type: "object",
      properties: {
        max_results: { type: "integer", description: "Max deals to return (default 12)." },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      if (!/\/(deals|gp\/goldbox)/i.test(location.pathname)) {
        return navHint("https://www.amazon.com/deals", "findDeals");
      }
      const max = Math.min(Math.max(args?.max_results || 12, 1), 30);
      await waitFor(() => readDeals(1).length);
      const deals = readDeals(max);
      return JSON.stringify({ url: location.href, returned: deals.length, deals }, null, 2);
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
}
