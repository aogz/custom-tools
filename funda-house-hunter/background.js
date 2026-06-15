// funda-house-hunter — Webfuse custom MCP tools (service worker; self-contained).
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
  return A().see.domSnapshot({ maxTokens: 9000, ...opts });
}

// funda.nl rewrites its markup often and (Tailwind-)hashes its class names, so
// every extractor here leans on stable-ish `data-test-id`/`data-testid` hooks
// first and falls back to URL-shape + text heuristics, never on visual classes.
// In a service worker we only have the snapshot as an HTML *string*, so the
// helpers below regex over that string (no DOM, no DOMParser).

const DETAIL_HREF_RE = /\/(?:detail\/)?koop\/[^"'?#\s]*?\/\d{6,}\/?(?:[?#]|(?=["'\s]))/gi;
const LISTING_ID_RE = /(\d{6,})\/?(?:[?#]|$)/;

// Build the funda search URL the same way the original makelaar host did.
function fundaSearchUrl(postcode, min, max) {
  const area = encodeURIComponent(JSON.stringify([String(postcode || "").trim().toLowerCase()]));
  let url = `https://www.funda.nl/zoeken/koop?selected_area=${area}`;
  if (min || max) {
    const price = `${min || 0}-${max || ""}`;
    url += `&price=${encodeURIComponent(`"${price}"`)}`;
  }
  return url;
}

function listingIdOf(u) {
  const m = String(u || "").match(LISTING_ID_RE);
  return m ? m[1] : "";
}

// Strip tags from a chunk of HTML and collapse entities/whitespace.
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
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">"),
  );
}

// funda fronts everything with the Didomi consent wall and sometimes an Imperva
// "are you human" interstitial. Detect them so the tool fails loud and clear.
function looksBlocked(html) {
  const t = stripTags(html).toLowerCase();
  return (
    /even geduld|verifi(e|ë)ren dat je een mens|are you human|access denied|verify you are|pardon our interruption/i.test(t) &&
    t.length < 1500
  );
}

// ── search-results parsing ──────────────────────────────────────────────────

// Pull the headline match count funda prints above the results, e.g.
// "295 huizen te koop". Falls back to null so the caller can use list length.
function readResultCount(html) {
  // Prefer the stable search-result-count hook if present.
  const hookM = html.match(/data-test-?id="search-result-count"[^>]*>([\s\S]*?)<\//i);
  const hooked = hookM ? stripTags(hookM[1]) : "";
  const candidates = [hooked, stripTags(html)];
  for (const t of candidates) {
    const m = t.match(/([\d.]{1,7})\s*(?:huiz|woning|result|home|propert)/i);
    if (m) return parseInt(m[1].replace(/\./g, ""), 10);
  }
  return null;
}

// Split the snapshot into per-anchor blocks, group by listing id, and lift
// address / price / thumbnail out of the surrounding HTML. Robust to funda's
// class-name churn because it keys off the koop/.../<id>/ href shape.
function extractListings(html, base, max) {
  const byId = new Map();
  // Walk every anchor opening tag and its trailing chunk of HTML (the card).
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>/gi;
  let m;
  const hits = [];
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    if (!new RegExp(DETAIL_HREF_RE.source, "i").test(href)) continue;
    hits.push({ href, at: m.index });
  }

  for (let i = 0; i < hits.length; i++) {
    const { href, at } = hits[i];
    const url = abs(href, base);
    const idm = url.match(LISTING_ID_RE);
    const id = idm ? idm[1] : url;
    // The card chunk: from this anchor up to the next listing anchor (or +4000).
    const next = hits[i + 1] ? hits[i + 1].at : at + 4000;
    const chunk = html.slice(at, Math.min(next, at + 4000));
    if (!byId.has(id)) byId.set(id, { url, chunk });
  }

  const listings = [];
  for (const [id, { url, chunk }] of byId) {
    const blockText = stripTags(chunk);
    const priceM = blockText.match(/€\s?[\d.]+(?:,-|\s?k\.k\.|\b)/i);
    listings.push({
      id,
      url,
      address: pickAddress(chunk) || "(adres onbekend)",
      price: priceM ? clean(priceM[0]) : "",
      image: firstImg(chunk, base),
    });
    if (listings.length >= max) break;
  }
  return listings;
}

function pickAddress(chunk) {
  const hooks = [
    /data-test-?id="street-name-house-number"[^>]*>([\s\S]*?)<\//i,
    /data-test-?id="listingDetailsAddress"[^>]*>([\s\S]*?)<\//i,
    /<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
    /<h3\b[^>]*>([\s\S]*?)<\/h3>/i,
  ];
  for (const re of hooks) {
    const m = chunk.match(re);
    if (m) {
      const t = stripTags(m[1]);
      if (t) return t;
    }
  }
  return "";
}

function firstImg(scope, base) {
  const m = scope.match(/<img\b[^>]*>/i);
  if (!m) return null;
  const tag = m[0];
  const src =
    (tag.match(/\bsrc="([^"]+)"/i) || [])[1] ||
    (tag.match(/\bdata-src="([^"]+)"/i) || [])[1] ||
    ((tag.match(/\bsrcset="([^"]+)"/i) || [])[1] || "").split(" ")[0];
  return src ? abs(src, base) : null;
}

// ── single-listing parsing ──────────────────────────────────────────────────

function readAddress(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = stripTags(h1[1]);
    if (t) return t;
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title ? clean(stripTags(title[1]).split("|")[0]) : "";
}

function readPrice(html) {
  const hooks = [
    /data-test-?id="object-price"[^>]*>([\s\S]*?)<\//i,
  ];
  for (const re of hooks) {
    const m = html.match(re);
    if (m) {
      const t = stripTags(m[1]);
      if (t) return t;
    }
  }
  const m = stripTags(html).match(/€\s?[\d.]+(?:\s?k\.k\.|,-|\b)/);
  return m ? clean(m[0]) : "";
}

function readDescription(html) {
  const hooks = [
    /data-test-?id="object-description-body"[^>]*>([\s\S]*?)<\/[a-z]+>/i,
    /<[^>]*class="[^"]*object-description-body[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i,
  ];
  for (const re of hooks) {
    const m = html.match(re);
    if (m) {
      const t = stripTags(m[1]);
      if (t && t.length > 80) return t;
    }
  }
  // Fallback: the single longest paragraph-ish text block on the page.
  let best = "";
  const blockRe = /<(p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = blockRe.exec(html))) {
    const t = stripTags(m[2]);
    if (t.length > best.length && t.length < 6000 && /\s/.test(t)) best = t;
  }
  return best;
}

// Key features live in <dt>/<dd> pairs ("Soort woonhuis", "Woonoppervlakte", …).
function readFeatures(html, max = 24) {
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

function readImages(html, base, max = 8) {
  const urls = new Set();
  const og = html.match(/<meta\b[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (og) urls.add(abs(og[1], base));
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    const src =
      (tag.match(/\bsrc="([^"]+)"/i) || [])[1] ||
      (tag.match(/\bdata-src="([^"]+)"/i) || [])[1] ||
      ((tag.match(/\bsrcset="([^"]+)"/i) || [])[1] || "").split(" ")[0];
    if (!src) continue;
    const u = abs(src, base);
    // funda serves listing media off cloud.funda.nl / media hosts; skip sprites,
    // icons and tiny ui assets.
    if (/funda|fnd|media|cloudinary|images/i.test(u) && !/icon|sprite|logo|\.svg(\?|$)/i.test(u)) {
      urls.add(u);
    }
    if (urls.size >= max) break;
  }
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
      // The description can be long; read a larger snapshot for this page.
      const html = await snapshotHtml({ maxTokens: 16000 });

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
