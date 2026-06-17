// restaurant-finder — Webfuse custom MCP tool (service worker; self-contained).
const A = () => browser.webfuseSession.automation;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const abs = (h, base) => { try { return new URL(h, base).href; } catch { return h || ""; } };
async function goto(url) {
  await A().navigate(url);
  await new Promise((res) => {
    let d = false;
    const f = () => { if (!d) { d = true; res(); } };
    try { A().once("page:stable", f); } catch {}
    setTimeout(f, 8000);
  });
}
async function snapshotHtml(opts = {}) { return A().see.domSnapshot({ quality: 1, ...opts }); }
async function dismissConsent(selectors = []) {
  for (const sel of selectors) {
    try { await A().act.click(sel, { waitForTarget: false }); await A().wait(1500); } catch {}
  }
}

// Decode the handful of HTML entities OpenTable emits inside attributes.
function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

// Preserve the original OpenTable search-URL logic exactly.
function searchUrl(a) {
  const term = [a.cuisine, a.city].filter(Boolean).join(" ");
  const p = new URLSearchParams({ term });
  if (a.party_size) p.set("covers", String(a.party_size));
  if (a.date && a.time) p.set("dateTime", `${a.date}T${a.time}`);
  return `https://www.opentable.com/s?${p.toString()}`;
}

// Parse restaurants from the raw HTML snapshot string (no DOM in a service worker).
// OpenTable renders each result as a `data-test="restaurant-card"` container whose
// detail link is `/r/<slug>`; the name lives in the link's aria-label, and bookable
// times are in per-slot `aria-label="<TIME> Reserve table at <Name> restaurant"`.
function parse(html, base, max) {
  const src = String(html || "");
  const restaurants = [];
  const seen = new Set();

  // Locate each restaurant card so card-local fields stay scoped to one result.
  const cardRe = /data-test="restaurant-card"/gi;
  const starts = [];
  let cm;
  while ((cm = cardRe.exec(src))) starts.push(cm.index);

  // Fallback if the card hook ever churns: anchor on the /r/ detail links.
  if (!starts.length) {
    const aRe = /<a\b[^>]*\bhref=("|')[^"']*\/r\/[^"']*\1/gi;
    let am;
    while ((am = aRe.exec(src))) starts.push(am.index);
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : Math.min(start + 12000, src.length);
    const card = src.slice(start, end);

    // Detail URL: first /r/ anchor in the card.
    const hrefM = card.match(/href=("|')([^"']*\/r\/[^"'#?]*)\1/i);
    if (!hrefM) continue;
    const url = abs(hrefM[2], base).split("?")[0].replace(/#.*$/, "");
    if (seen.has(url)) continue;

    // Name: prefer the "View <Name> restaurant details" aria-label, then the
    // profile-link data-test, then derive from the slug.
    let name =
      (card.match(/aria-label="View ([^"]*?) restaurant details"/i) || [])[1] ||
      (card.match(/data-test="restaurant-card-profile-link-([^"]*)"/i) || [])[1] ||
      "";
    name = clean(decode(name));
    if (!name) {
      const slug = (url.match(/\/r\/([^/]+)/) || [])[1] || "";
      name = clean(slug.replace(/-/g, " ")).replace(/\b\w/g, (c) => c.toUpperCase());
    }
    if (!name) continue;

    const rating = (card.match(/>\s*([0-5]\.\d)\s*</) || card.match(/\b([0-5]\.\d)\b/) || [])[1] || null;

    // Price: OpenTable renders nested spans like `$$$<span>$</span>`; strip tags first.
    const priceText = card.replace(/<[^>]+>/g, "");
    const price = (priceText.match(/[$£€]{1,4}/) || [])[0] || null;

    // Times: bookable slots are `aria-label="<TIME> Reserve table at ..."`.
    const times = [];
    const slotRe = /aria-label="(\d{1,2}:\d{2}\s?(?:AM|PM)?)\s+Reserve table\b/gi;
    let sm;
    while ((sm = slotRe.exec(card))) {
      const t = clean(sm[1]);
      if (t && !times.includes(t)) times.push(t);
    }
    // Fallback: bare time tokens within the card (best-effort, may be empty).
    if (!times.length) {
      const bare = priceText.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)?\b/gi) || [];
      for (const t of bare) { const c = clean(t); if (!times.includes(c)) times.push(c); }
    }

    seen.add(url);
    restaurants.push({ name, url, rating, price, times: times.slice(0, 8) });
    if (restaurants.length >= max) break;
  }

  if (!restaurants.length) return { url: base, returned: 0, message: "no restaurants parsed" };
  return { url: base, returned: restaurants.length, restaurants };
}

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "findAvailability",
    description:
      "Self-contained: navigates to OpenTable search and returns restaurants with open tables (name, url, rating, price, times) for a city/date/time/party/cuisine.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City or area, e.g. 'Amsterdam'." },
        date: { type: "string", description: "Date, YYYY-MM-DD." },
        time: { type: "string", description: "24h time, e.g. '20:00'." },
        party_size: { type: "integer", description: "Number of people (default 2)." },
        cuisine: { type: "string", description: "Optional cuisine, e.g. 'Italian'." },
      },
      required: ["city"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const url = searchUrl(args);
      await goto(url);
      await dismissConsent(['#onetrust-accept-btn-handler', '[aria-label="Accept all"]']);
      await A().wait(2000);
      const html = await snapshotHtml();
      return JSON.stringify(parse(html, url, 20));
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
