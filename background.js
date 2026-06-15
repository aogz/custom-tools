// restaurant-finder — Webfuse custom MCP tool (service worker; self-contained).
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

// Preserve the original OpenTable search-URL logic exactly.
function searchUrl(a) {
  const term = [a.cuisine, a.city].filter(Boolean).join(" ");
  const p = new URLSearchParams({ term });
  if (a.party_size) p.set("covers", String(a.party_size));
  if (a.date && a.time) p.set("dateTime", `${a.date}T${a.time}`);
  return `https://www.opentable.com/s?${p.toString()}`;
}

// Parse the same fields the content-script read (name, url, rating, price, times)
// from the HTML snapshot string — no DOM in a service worker, so use regex.
function readResults(html, base, max) {
  const out = [];
  const seen = new Set();
  // Split on restaurant-link anchors (OpenTable detail pages live under /r/ or /restaurant/).
  const linkRe = /<a\b[^>]*\bhref=("|')([^"']*\/(?:r|restaurant)\/[^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  // Capture link positions so we can grab the surrounding card text for each.
  const links = [];
  while ((m = linkRe.exec(html))) {
    links.push({ href: m[2], inner: m[3], index: m.index, end: linkRe.lastIndex });
  }
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const url = abs(link.href, base).split("?")[0];
    if (seen.has(url)) continue;
    // Card text = window around this link up to the next link (best-effort).
    const sliceEnd = i + 1 < links.length ? links[i + 1].index : Math.min(link.end + 1200, html.length);
    const sliceStart = Math.max(0, link.index - 400);
    const card = clean(html.slice(sliceStart, sliceEnd).replace(/<[^>]+>/g, " "));
    const name = clean(link.inner.replace(/<[^>]+>/g, " "));
    if (!name) continue;
    seen.add(url);
    const rating = (card.match(/\b[0-5]\.\d\b/) || [])[0] || null;
    const price = (card.match(/[$£€]{1,4}/) || [])[0] || null;
    const times = [...new Set((card.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)?\b/gi) || []))].slice(0, 6);
    out.push({ name, url, rating, price, times });
    if (out.length >= max) break;
  }
  return out;
}

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "findAvailability",
    description:
      "Self-contained: navigates to OpenTable search and returns restaurants with open tables (name, cuisine, rating, price, times) for a city/date/time/party/cuisine.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City or area, e.g. 'Amsterdam'." },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM (24h)" },
        party_size: { type: "integer" },
        cuisine: { type: "string" },
      },
      required: ["city"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const url = searchUrl(args);
      await goto(url);
      await A().wait(1500);
      const html = await snapshotHtml();
      const max = Math.min(Math.max(args?.party_size ? 12 : 12, 1), 20);
      const restaurants = readResults(html, url, max);
      if (!restaurants.length) {
        return JSON.stringify({
          url,
          returned: 0,
          restaurants: [],
          message: "No restaurants parsed (possibly a consent/bot wall or no availability).",
        });
      }
      return JSON.stringify({ url, returned: restaurants.length, restaurants });
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[restaurant-finder] findAvailability + finish registered");
} else {
  console.warn("[restaurant-finder] registerTool unavailable");
}
