// flight-deals — Webfuse custom MCP tool (service worker; self-contained).
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
async function dismissConsent(selectors = []) {
  for (const sel of selectors) {
    try {
      await A().act.click(sel, { waitForTarget: false });
      await A().wait(2000);
    } catch {}
  }
}

const PRICE_RE = /[$£€]\s?\d[\d.,]*/;

// Google Flights accepts a natural-language `q` query param, so we build a
// results URL from the args. Preserved from the original content-script logic.
function flightsUrl(a) {
  const parts = [`Flights from ${a.from} to ${a.to} on ${a.depart}`];
  if (a.return) parts.push(`returning ${a.return}`);
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(parts.join(" "))}`;
}

// Strip tags + decode common entities and collapse whitespace into text.
function htmlToText(html) {
  return clean(
    String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<"),
  );
}

// Parse itineraries out of the DOM snapshot HTML string (no DOMParser in a
// service worker). Google Flights renders each result as <li class="pIav2d">…</li>;
// we isolate those blocks, then extract price / stops / duration / a short
// detail snippet with text heuristics. Best-effort scraping.
function parse(html, url, max) {
  const src = String(html || "");
  // Primary: split on the itinerary list-item class. Fall back to generic
  // <li>/role=listitem blocks if Google churns the hashed class name.
  let blocks = src.split(/<li class="pIav2d"[^>]*>/i).slice(1);
  if (!blocks.length) {
    blocks = src.split(/<li\b[^>]*>|<[^>]*role="listitem"[^>]*>/i).slice(1);
  }

  const out = [];
  const seen = new Set();
  for (const block of blocks) {
    const t = htmlToText(block);
    const priceM = t.match(PRICE_RE);
    if (!priceM) continue;
    const stopsM = t.match(/\bNonstop\b/i) || t.match(/\b\d+\s*stop(?:s)?\b/i);
    const durM = t.match(/\b\d+\s*hr(?:\s*\d+\s*min)?\b/i);
    // Require a recognisable itinerary shape so we skip stray priced UI bits.
    if (!stopsM && !durM) continue;

    const price = clean(priceM[0]);
    const stops = stopsM ? clean(stopsM[0]) : null;
    const duration = durM ? clean(durM[0]) : null;
    // Compact detail: the text leading up to the price (times + airline + route).
    const idx = t.indexOf(priceM[0]);
    const detail = (idx > 0 ? clean(t.slice(0, idx)) : t).slice(0, 160);

    const key = `${price}|${stops}|${duration}|${detail.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ price, stops, duration, detail });
  }

  const num = (p) => Number(String(p).replace(/[^\d.]/g, "")) || Infinity;
  out.sort((a, b) => num(a.price) - num(b.price)); // cheapest first
  const flights = out.slice(0, max);
  if (!flights.length) return { url, returned: 0, message: "no itineraries parsed" };
  return { url, returned: flights.length, flights };
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
      const max = Math.min(Math.max(args?.max_results || 8, 1), 20);
      const url = flightsUrl(args);
      await goto(url);
      // Google Flights shows a consent wall first; dismiss it, then wait for
      // the JS results to render before snapshotting.
      await dismissConsent(['[aria-label="Accept all"]']);
      await A().wait(4000);
      const html = await snapshotHtml();
      return JSON.stringify(parse(html, url, max));
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
