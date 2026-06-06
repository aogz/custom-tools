// markets-watch — reads a ticker's quote from Yahoo Finance.

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(fn, { timeout = 12000, interval = 250 } = {}) {
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

// Yahoo annotates quote values with data-field / data-symbol — stable hooks.
function field(symbol, name) {
  const el =
    document.querySelector(`fin-streamer[data-symbol="${symbol}"][data-field="${name}"]`) ||
    document.querySelector(`[data-symbol="${symbol}"][data-field="${name}"]`) ||
    document.querySelector(`fin-streamer[data-field="${name}"]`);
  return el ? clean(el.getAttribute("value") || el.textContent) : "";
}

function statByLabel(label) {
  for (const row of document.querySelectorAll("li, tr, [data-test]")) {
    const t = clean(row.innerText);
    if (t.toLowerCase().startsWith(label.toLowerCase())) {
      return clean(t.slice(label.length).replace(/^[:\s]+/, ""));
    }
  }
  return "";
}

if (!browser?.webfuseSession?.registerTool) {
  console.warn("[markets-watch] registerTool unavailable");
} else {
  browser.webfuseSession.registerTool({
    name: "getQuote",
    description:
      "Returns a ticker's quote from Yahoo Finance (name, price, day change %, day range, market cap). If that quote page isn't open, returns {status:'navigate_required', navigateTo}.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker, e.g. 'AAPL' or 'BTC-USD'." } },
      required: ["symbol"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const symbol = clean(args?.symbol).toUpperCase();
      if (!symbol) throw new Error("symbol is required, e.g. 'AAPL'.");
      if (!new RegExp(`/quote/${symbol}(?:[/?]|$)`, "i").test(location.href)) {
        return navHint(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`, "getQuote");
      }
      await waitFor(() => field(symbol, "regularMarketPrice"));
      return JSON.stringify(
        {
          symbol,
          name: clean(document.querySelector("h1")?.textContent) || symbol,
          price: field(symbol, "regularMarketPrice") || null,
          changePercent: field(symbol, "regularMarketChangePercent") || null,
          dayRange: statByLabel("Day's Range") || null,
          marketCap: statByLabel("Market Cap") || null,
          url: location.href,
        },
        null,
        2,
      );
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
}
