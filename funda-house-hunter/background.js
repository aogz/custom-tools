// funda-house-hunter — Webfuse custom MCP tools (service worker; self-contained).
const A = () => browser.webfuseSession.automation;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const abs = (h, base) => { try { return new URL(h, base).href; } catch { return h || ""; } };
async function goto(url) {
  await A().navigate(url);
  await new Promise((res) => { let d = false; const f = () => { if (!d) { d = true; res(); } }; try { A().once("page:stable", f); } catch {} setTimeout(f, 8000); });
}
async function snapshotHtml(opts = {}) { return A().see.domSnapshot({ quality: 1, ...opts }); }
async function dismissConsent(selectors = []) {
  for (const sel of selectors) { try { await A().act.click(sel, { waitForTarget: false }); await A().wait(1500); } catch {} }
}

const CONSENT = ['#didomi-notice-agree-button', 'button[aria-label*="Akkoord"]', 'button[aria-label*="Agree"]'];

// funda hashes its Tailwind classes and reorders markup often, so extraction keys
// off stable hooks (data-testid, the /detail/koop/<id>/ href shape, the € price
// text) and never leans on visual class names. In a service worker the snapshot
// is an HTML *string* (no DOM / DOMParser), so helpers regex over that string.

// Detail-listing anchor href shape: /detail/koop/<city>/<slug>/<6+ digit id>/
const DETAIL_HREF_RE = /\/detail\/koop\/[a-z0-9-]+\/[^"'?#\s]+?\/(\d{6,})\/?/i;

function fundaSearchUrl(postcode, min, max) {
  const area = encodeURIComponent(JSON.stringify([String(postcode || "").trim().toLowerCase()]));
  let url = `https://www.funda.nl/zoeken/koop?selected_area=${area}`;
  if (min || max) {
    const price = `${min || 0}-${max || ""}`;
    url += `&price=${encodeURIComponent(`"${price}"`)}`;
  }
  return url;
}

function stripTags(html) {
  return clean(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&euro;/gi, "€")
      .replace(/&#8364;/g, "€")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">"),
  );
}

// Only treat the page as blocked on a real bot/verification wall — funda's normal
// pages are full of consent/cookie text, so require the wall phrase AND a tiny body.
function looksBlocked(html) {
  const t = stripTags(html).toLowerCase();
  return (
    /are you human|access denied|verify you are (a )?human|pardon our interruption|even geduld a\.u\.b/i.test(t) &&
    t.length < 1500
  );
}

const PRICE_RE = /€\s?\d[\d.]*(?:,-)?(?:\s?(?:k\.k\.|v\.o\.n\.|kosten koper|vrij op naam))?/i;

// ── search-results parsing ──────────────────────────────────────────────────

// "Op Funda vind je momenteel 202 huizen te koop …" — take the count nearest such
// a phrase; fall back to null so the caller uses the listing count.
function readResultCount(html) {
  const t = stripTags(html);
  const m = t.match(/([\d][\d.]{0,9})\s*(?:huiz(?:en)?|woning(?:en)?|resultaten)\b/i);
  if (m) {
    const n = parseInt(m[1].replace(/\./g, ""), 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

// Walk every <a> tag; keep those whose href is a detail listing, and remember the
// span of HTML each listing id occupies (its image-anchor + content-anchor both
// reference the same id). Then lift address / price / image out of that span.
function extractListings(html, base, max) {
  const anchorRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi;
  const byId = new Map(); // id -> { url, start, end }
  const order = [];
  let m;
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    const idm = href.match(DETAIL_HREF_RE);
    if (!idm) continue;
    const id = idm[1];
    const url = abs(href.match(/^[^"'\s]+/)[0], base);
    const at = m.index;
    if (!byId.has(id)) { byId.set(id, { url, start: at, end: at }); order.push(id); }
    else { const e = byId.get(id); if (at < e.start) e.start = at; if (at > e.end) e.end = at; }
  }

  const listings = [];
  for (const id of order) {
    if (listings.length >= max) break;
    const { url, start, end } = byId.get(id);
    // Window covers both anchors for this listing; pad to catch the image that may
    // sit just inside the first anchor and the price block after the address.
    const winStart = Math.max(0, start - 200);
    const winEnd = Math.min(html.length, end + 2500);
    const chunk = html.slice(winStart, winEnd);
    const priceM = stripTags(chunk).match(PRICE_RE);
    listings.push({
      id,
      url,
      address: pickAddress(chunk) || "(adres onbekend)",
      price: priceM ? clean(priceM[0]) : "",
      image: firstImg(chunk, base),
    });
  }
  return listings;
}

function pickAddress(chunk) {
  // Preferred: the content-anchor carries data-testid="listingDetailsAddress" with
  // a street <span> and a "<postcode> <city>" <div> inside it.
  const hook = chunk.match(/data-testid="listingDetailsAddress"[^>]*>([\s\S]*?)<\/a>/i);
  if (hook) {
    const t = stripTags(hook[1]);
    if (t) return t;
  }
  // Promoted ("top-position") cards: address + city/price live in an <h2><p>…</p>.
  const h2 = chunk.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2) {
    const t = stripTags(h2[1]);
    if (t) return t.replace(/\s*,?\s*€[\s\S]*$/i, "").trim() || t; // drop trailing ", € … k.k."
  }
  return "";
}

function firstImg(scope, base) {
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(scope))) {
    const src = imgSrc(m[0]);
    if (src && /cloud\.funda\.nl|funda/i.test(src) && !/icon|sprite|logo|\.svg(\?|$)/i.test(src)) {
      return abs(src, base);
    }
  }
  // Fall back to the first <img> with any src.
  const any = scope.match(/<img\b[^>]*>/i);
  const s = any ? imgSrc(any[0]) : "";
  return s ? abs(s, base) : null;
}

function imgSrc(tag) {
  return (
    (tag.match(/\bsrc="([^"]+)"/i) || [])[1] ||
    (tag.match(/\bdata-src="([^"]+)"/i) || [])[1] ||
    ((tag.match(/\bsrcset="([^"]+)"/i) || [])[1] || "").trim().split(/\s+/)[0] ||
    ""
  );
}

// ── single-listing parsing ──────────────────────────────────────────────────

function readAddress(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    // The h1 ends with a neighbourhood <a> link; keep only the street + postcode/city spans.
    const spans = [...h1[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((mm) => stripTags(mm[1])).filter(Boolean);
    if (spans.length) return clean(spans.join(" "));
    const t = stripTags(h1[1]);
    if (t) return t;
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title ? clean(stripTags(title[1]).split("|")[0]) : "";
}

function readPrice(html) {
  // Prefer the headline € price that sits just after the <h1> address.
  const h1End = html.search(/<\/h1>/i);
  if (h1End >= 0) {
    const m = stripTags(html.slice(h1End, h1End + 1500)).match(PRICE_RE);
    if (m) return clean(m[0]);
  }
  // Else the "Vraagprijs" feature row, else the first € anywhere.
  const dd = readFeatureValue(html, /^vraagprijs$/i);
  if (dd) return dd;
  const m = stripTags(html).match(PRICE_RE);
  return m ? clean(m[0]) : "";
}

function readFeatureValue(html, ...keyTests) {
  const dtRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = dtRe.exec(html))) {
    const k = stripTags(m[1]);
    for (const test of keyTests) {
      if (test.test(k)) {
        const v = stripTags(m[2]);
        if (v) return v;
      }
    }
  }
  return "";
}

function readDescription(html) {
  // The object description sits inside the "Omschrijving" expandable panel.
  const idx = html.search(/Omschrijving\s*<\/h2>/i);
  if (idx >= 0) {
    const after = html.slice(idx, idx + 20000);
    const panel = after.match(/data-testid="expandable-panel-header"[^>]*>([\s\S]*?)(?:<\/section>|data-testid="expandable-panel-footer"|<h2\b)/i);
    if (panel) {
      const t = cleanDescription(panel[1]);
      if (t.length > 80) return t;
    }
    const t = cleanDescription(after);
    if (t.length > 80) return t;
  }
  // Fallback: longest text-bearing block, ignoring the cookie/consent wall text.
  let best = "";
  const blockRe = /<(p|div|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = blockRe.exec(html))) {
    const t = stripTags(m[2]);
    if (/cookies op funda|toestemming|partners cookies/i.test(t)) continue;
    if (t.length > best.length && t.length < 8000 && /\s/.test(t)) best = t;
  }
  return best;
}

function cleanDescription(html) {
  // Keep paragraph breaks (the source uses literal \n) but collapse runs of space.
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&euro;/gi, "€")
    .replace(/&#8364;/g, "€")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

// Key features live in <dt>/<dd> pairs ("Vraagprijs", "Bouwjaar", "Wonen", …).
function readFeatures(html, max = 30) {
  const out = [];
  const seen = new Set();
  const dtRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = dtRe.exec(html)) && out.length < max) {
    const k = stripTags(m[1]);
    const v = stripTags(m[2]);
    if (k && v && !seen.has(k)) {
      seen.add(k);
      out.push(`${k}: ${v}`);
    }
  }
  return out;
}

function readImages(html, base, max = 10) {
  const urls = new Set();
  const seenBase = new Set();
  const add = (raw) => {
    if (!raw) return;
    const u = abs(raw, base);
    if (!/cloud\.funda\.nl/i.test(u)) return; // listing photos live on cloud.funda.nl
    if (/icon|sprite|logo|\/maps?\/|map_|\.svg(\?|$)/i.test(u)) return;
    const key = u.split("?")[0]; // collapse the same image at different ?options=width=
    if (seenBase.has(key)) return;
    seenBase.add(key);
    urls.add(u);
  };
  const og = html.match(/<meta\b[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
             html.match(/<meta\b[^>]*name="twitter:image"[^>]*content="([^"]+)"/i);
  if (og) add(og[1]);
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) && urls.size < max) add(imgSrc(m[0]));
  return Array.from(urls).slice(0, max);
}

// ── tool registrations ──────────────────────────────────────────────────────

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "getListProperties",
    description:
      "Searches funda.nl for homes for sale in a postal-code area + price range and returns how many were found plus the first page of listings (address, price, listing URL, thumbnail). Self-contained: it navigates to the funda search page for these criteria itself and reads the results in one call.",
    inputSchema: {
      type: "object",
      properties: {
        postal_code: { type: "string", description: "Dutch postcode or area, e.g. '1019' or 'amsterdam'." },
        price_min: { type: "integer", description: "Minimum asking price in euros." },
        price_max: { type: "integer", description: "Maximum asking price in euros." },
        max_results: { type: "integer", description: "Cap on returned listings (default 12)." },
      },
      required: ["postal_code"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const max = Math.min(Math.max(args?.max_results || 12, 1), 30);
      const url = fundaSearchUrl(args?.postal_code, args?.price_min, args?.price_max);
      await goto(url);
      await dismissConsent(CONSENT);
      const html = await snapshotHtml();

      if (looksBlocked(html)) {
        return 'funda is showing a "verify you are human" interstitial — the search results could not be read. Try again or enable residential IPs on the Space.';
      }

      const count = readResultCount(html);
      const listings = extractListings(html, url, max);
      if (!listings.length && count == null) {
        return "Could not read any funda listings from the search page (possible consent/bot wall or empty result).";
      }

      return JSON.stringify({
        query: {
          postal_code: args?.postal_code ?? null,
          price_min: args?.price_min ?? null,
          price_max: args?.price_max ?? null,
        },
        url,
        totalFound: count ?? listings.length,
        returned: listings.length,
        listings,
      });
    },
  });

  browser.webfuseSession.registerTool({
    name: "getPropertySummary",
    description:
      "Opens a single funda.nl listing by URL and returns its address, asking price, full description, key features and image URLs. Self-contained: it navigates to the listing URL itself and reads the page in one call.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full funda.nl listing URL (from getListProperties)." },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const url = String(args?.url || "");
      if (!url) return "No listing URL was provided.";
      await goto(url);
      await dismissConsent(CONSENT);
      const html = await snapshotHtml();

      if (looksBlocked(html)) {
        return "funda is showing a human-verification interstitial — this listing could not be read.";
      }

      const address = readAddress(html);
      const description = readDescription(html);
      if (!address && !description) {
        return "Could not read this funda listing (possible consent/bot wall).";
      }

      return JSON.stringify({
        url,
        address,
        price: readPrice(html),
        description: description.length > 2000 ? description.slice(0, 2000) + "…" : description,
        features: readFeatures(html),
        images: readImages(html, url),
      });
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description:
      "Call when the task is complete. Pass a short result summary; its value is returned as the final automation result.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short summary of the result." },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[funda-house-hunter] getListProperties + getPropertySummary + finish registered");
} else {
  console.warn("[funda-house-hunter] webfuseSession.registerTool unavailable — only runs inside a Webfuse session");
}
