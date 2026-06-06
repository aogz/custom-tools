// flight-deals — reads Google Flights results for a route + dates.
//
// Google Flights accepts a natural-language `q` query param, so we build a
// results URL from the args and let the caller navigate to it, then read the
// itinerary list. Markup is obfuscated, so we lean on role + currency/text.

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRICE_RE = /(?:[$£€]\s?)[\d.,]+/;

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

async function waitFor(fn, { timeout = 15000, interval = 400 } = {}) {
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

function flightsUrl(a) {
  const parts = [`Flights from ${a.from} to ${a.to} on ${a.depart}`];
  if (a.return) parts.push(`returning ${a.return}`);
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(parts.join(" "))}`;
}

function readItineraries(max) {
  const out = [];
  const seen = new Set();
  for (const li of document.querySelectorAll('[role="listitem"], li')) {
    const t = clean(li.innerText);
    const priceM = t.match(PRICE_RE);
    if (!priceM || t.length > 400) continue;
    const key = t.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const stops = (t.match(/\b(nonstop|\d\s*stop[s]?)\b/i) || [])[0] || null;
    const dur = (t.match(/\b\d+\s*hr(?:\s*\d+\s*min)?\b/i) || [])[0] || null;
    out.push({ price: clean(priceM[0]), stops, duration: dur, detail: t.slice(0, 140) });
    if (out.length >= max) break;
  }
  // cheapest first
  return out.sort(
    (x, y) =>
      Number(x.price.replace(/[^\d.]/g, "")) - Number(y.price.replace(/[^\d.]/g, "")),
  );
}

if (!browser?.webfuseSession?.registerTool) {
  console.warn("[flight-deals] registerTool unavailable");
} else {
  browser.webfuseSession.registerTool({
    name: "searchFlights",
    description:
      "Searches Google Flights and returns the cheapest itineraries (price, stops, duration). If the results page isn't open, returns {status:'navigate_required', navigateTo}.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        depart: { type: "string", description: "YYYY-MM-DD" },
        return: { type: "string", description: "YYYY-MM-DD (optional)" },
        max_results: { type: "integer" },
      },
      required: ["from", "to", "depart"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      if (!/\/travel\/flights/.test(location.pathname) || !location.search.includes("q=")) {
        return navHint(flightsUrl(args), "searchFlights");
      }
      const max = Math.min(Math.max(args?.max_results || 8, 1), 20);
      await waitFor(() => readItineraries(1).length);
      const flights = readItineraries(max);
      return JSON.stringify({ url: location.href, returned: flights.length, flights }, null, 2);
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[flight-deals] searchFlights + finish registered");
}
