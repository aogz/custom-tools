// flight-deals — Webfuse custom MCP tool (service worker; self-contained).
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

const PRICE_RE = /(?:[$£€]\s?)[\d.,]+/;

// Google Flights accepts a natural-language `q` query param, so we build a
// results URL from the args. Preserved from the original content-script logic.
function flightsUrl(a) {
  const parts = [`Flights from ${a.from} to ${a.to} on ${a.depart}`];
  if (a.return) parts.push(`returning ${a.return}`);
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(parts.join(" "))}`;
}

// Strip tags from an HTML fragment and collapse whitespace into readable text.
function htmlToText(html) {
  return clean(String(html || "").replace(/<[^>]*>/g, " "));
}

// Parse itineraries out of the DOM snapshot HTML string (no DOMParser in a
// service worker). We split on list-item-ish blocks and apply the same
// price/stops/duration heuristics the original used.
function readItineraries(html, max) {
  const out = [];
  const seen = new Set();
  // Break the snapshot into candidate list-item blocks.
  const blocks = String(html || "").split(/<li\b[^>]*>|<[^>]*role="listitem"[^>]*>/i);
  for (const block of blocks) {
    const t = htmlToText(block);
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

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "searchFlights",
    description:
      "Searches Google Flights and returns the cheapest itineraries (price, stops, duration). Self-contained: navigates to the results page for the given route + dates and reads the itinerary list in one call.",
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
      const url = flightsUrl(args);
      await goto(url);
      await A().wait(2000); // let the itinerary list render
      const max = Math.min(Math.max(args?.max_results || 8, 1), 20);
      const html = await snapshotHtml();
      const flights = readItineraries(html, max);
      if (!flights.length) {
        return JSON.stringify({
          url,
          returned: 0,
          message:
            "No itineraries parsed — Google Flights may have shown a consent wall or changed its markup (scraping is best-effort).",
        });
      }
      return JSON.stringify({ url, returned: flights.length, flights }, null, 2);
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
} else {
  console.warn("[flight-deals] registerTool unavailable");
}
