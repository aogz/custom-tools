// makelaar-funda-tool: two custom MCP tools for funda.nl.
//
//   getListProperties   — read the current funda search-results page: how many
//                          homes were found + the first page of listings
//                          (address, price, url, thumbnail).
//   getPropertySummary  — read a single funda listing page: address, price, the
//                          full description, key features and image urls.
//
// Both tools READ the page that is currently loaded in the session tab. The
// *host app* drives navigation with the built-in `navigate` MCP tool (the same
// proven pattern the chess + nice-world demos use): it navigates to the funda
// search URL, then calls getListProperties; then navigates to each listing URL
// and calls getPropertySummary. Reading the live DOM directly (instead of
// navigating from inside execute()) keeps the content-script realm intact and
// is the reliable path — a content script does not survive a full-page
// navigation, but the automation backend that the host app talks to does.
//
// funda.nl rewrites its markup often and (Tailwind-)hashes its class names, so
// every extractor here leans on stable-ish `data-test-id`/`data-testid` hooks
// first and falls back to URL-shape + text heuristics, never on visual classes.

const automation = () => browser.webfuseSession.automation;

const DETAIL_HREF_RE = /\/(?:detail\/)?koop\/[^?#]*?\/\d{6,}\/?(?:[?#]|$)/i;
const LISTING_ID_RE = /(\d{6,})\/?(?:[?#]|$)/;

// ── small DOM helpers ───────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function text(el, sel) {
    const n = sel ? el?.querySelector(sel) : el;
    return n ? clean(n.textContent) : '';
}

async function waitFor(predicate, { timeout = 12000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try {
            last = predicate();
            if (last) return last;
        } catch (_) { /* keep polling */ }
        await sleep(interval);
    }
    return last || null;
}

// funda fronts everything with the Didomi consent wall; until it's dismissed
// the results are blurred/empty. Click "agree" if it's there (best-effort).
async function dismissConsent() {
    const sels = [
        '#didomi-notice-agree-button',
        'button#didomi-notice-agree-button',
        'button[aria-label="Akkoord"]',
        'button[aria-label="Agree"]',
    ];
    for (const sel of sels) {
        const btn = document.querySelector(sel);
        if (btn) {
            try { btn.click(); } catch (_) {}
            await sleep(400);
            return true;
        }
    }
    return false;
}

// Some funda flows interpose an "are you human" / Imperva interstitial. Detect
// it so the tool can fail loud and clear rather than returning an empty list.
function looksBlocked() {
    const t = (document.body?.innerText || '').toLowerCase();
    return (
        /even geduld|verifi(e|ë)ren dat je een mens|are you human|access denied|verify you are|pardon our interruption/i.test(
            t,
        ) && t.length < 1500
    );
}

function absUrl(href) {
    try { return new URL(href, location.href).href; } catch { return href || ''; }
}

function firstImg(scope) {
    const img = scope?.querySelector('img');
    if (!img) return null;
    const src =
        img.getAttribute('src') ||
        img.getAttribute('data-src') ||
        (img.getAttribute('srcset') || '').split(' ')[0];
    return src ? absUrl(src) : null;
}

// ── self-contained navigation helpers ───────────────────────────────────────
// A content script can't navigate AND survive to read in one call, so instead
// of navigating from execute() we compute the exact target URL and — if the
// session isn't already there — hand it back so the caller navigates and
// re-calls. The makelaar host pre-navigates, so it always hits the read path;
// a generic agent (anthill) gets the URL from us and never has to build it.

// Identical to the makelaar host's fundaSearchUrl(), so behaviour matches.
function fundaSearchUrl(postcode, min, max) {
    const area = encodeURIComponent(JSON.stringify([String(postcode || '').trim().toLowerCase()]));
    let url = `https://www.funda.nl/zoeken/koop?selected_area=${area}`;
    if (min || max) {
        const price = `${min || 0}-${max || ''}`;
        url += `&price=${encodeURIComponent(`"${price}"`)}`;
    }
    return url;
}

// Are we on a funda search-results page for the requested postcode/area?
function onSearchPageFor(postcode) {
    if (!/\/zoeken\//i.test(location.pathname)) return false;
    if (!postcode) return true;
    const want = String(postcode).trim().toLowerCase();
    try {
        const area = new URL(location.href).searchParams.get('selected_area') || '';
        return area.toLowerCase().includes(want);
    } catch {
        return location.href.toLowerCase().includes(want);
    }
}

function listingIdOf(u) {
    const m = String(u || '').match(LISTING_ID_RE);
    return m ? m[1] : '';
}

// A "navigate first, then re-call me" instruction the caller can act on.
function navigateHint(navigateTo, toolName) {
    return JSON.stringify(
        {
            status: 'navigate_required',
            navigateTo,
            message: `Not on the right page yet. Call the navigate tool with url "${navigateTo}", then call ${toolName} again with the same arguments.`,
        },
        null,
        2,
    );
}

// ── search-results scraping ─────────────────────────────────────────────────

// Pull the headline match count funda prints above the results, e.g.
// "295 huizen te koop". Falls back to null so the caller can use list length.
function readResultCount() {
    const hooks = [
        '[data-test-id="search-result-count"]',
        '[data-testid="search-result-count"]',
        '[class*="result"] h1',
        'h1',
    ];
    for (const sel of hooks) {
        for (const el of document.querySelectorAll(sel)) {
            const m = clean(el.textContent).match(/([\d.]{1,7})\s*(?:huiz|woning|result|home|propert)/i);
            if (m) return parseInt(m[1].replace(/\./g, ''), 10);
        }
    }
    return null;
}

// Group every "detail/koop/.../<id>/" anchor on the page by its listing id,
// then lift address / price / thumbnail out of the smallest card-like ancestor
// that contains the anchor. Robust to funda's class-name churn.
function extractListings(max) {
    const byId = new Map();
    const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) =>
        DETAIL_HREF_RE.test(a.getAttribute('href') || ''),
    );

    for (const a of anchors) {
        const href = absUrl(a.getAttribute('href'));
        const idm = href.match(LISTING_ID_RE);
        const id = idm ? idm[1] : href;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(a);
    }

    const listings = [];
    for (const [id, group] of byId) {
        const anchor = group[0];
        const card = cardAncestor(anchor);
        const blockText = clean(card?.innerText || anchor.textContent);

        const priceM = blockText.match(/€\s?[\d.]+(?:,-|\s?k\.k\.|\b)/i);
        const address = pickAddress(card, anchor);
        listings.push({
            id,
            url: absUrl(anchor.getAttribute('href')),
            address: address || '(adres onbekend)',
            price: priceM ? clean(priceM[0]) : '',
            image: firstImg(card),
        });
        if (listings.length >= max) break;
    }
    return listings;
}

// Walk up a few levels and keep the ancestor that both holds a price-looking
// string and stays reasonably small — that's the listing card.
function cardAncestor(anchor) {
    let el = anchor;
    let best = anchor;
    for (let i = 0; i < 6 && el; i++) {
        const t = el.innerText || '';
        if (/€\s?[\d.]/.test(t)) { best = el; if (t.length < 600) break; }
        el = el.parentElement;
    }
    return best;
}

function pickAddress(card, anchor) {
    const hooks = [
        '[data-test-id="street-name-house-number"]',
        '[data-testid="street-name-house-number"]',
        '[data-test-id="listingDetailsAddress"]',
        'h2',
        'h3',
    ];
    for (const sel of hooks) {
        const t = text(card, sel);
        if (t) return t;
    }
    const at = clean(anchor.textContent);
    return at && at.length < 120 ? at : '';
}

// ── single-listing scraping ─────────────────────────────────────────────────

function readAddress() {
    const h1 = document.querySelector('h1');
    if (h1) return clean(h1.innerText);
    return clean(document.title.split('|')[0]);
}

function readPrice() {
    const hooks = [
        '[data-test-id="object-price"]',
        '[data-testid="object-price"]',
        '[class*="object-header"] [class*="price"]',
    ];
    for (const sel of hooks) {
        const t = text(document, sel);
        if (t) return t;
    }
    const m = (document.body?.innerText || '').match(/€\s?[\d.]+(?:\s?k\.k\.|,-|\b)/);
    return m ? clean(m[0]) : '';
}

function readDescription() {
    const hooks = [
        '[data-test-id="object-description-body"]',
        '[data-testid="object-description-body"]',
        '.object-description-body',
        '[class*="description"]',
    ];
    for (const sel of hooks) {
        const t = text(document, sel);
        if (t && t.length > 80) return t;
    }
    // Fallback: the single longest paragraph-ish block on the page.
    let best = '';
    for (const p of document.querySelectorAll('p, div')) {
        const t = clean(p.innerText);
        if (t.length > best.length && t.length < 6000 && /\s/.test(t)) best = t;
    }
    return best;
}

// Key features live in <dt>/<dd> pairs ("Soort woonhuis", "Woonoppervlakte", …).
function readFeatures(max = 24) {
    const out = [];
    const seen = new Set();
    for (const dl of document.querySelectorAll('dl')) {
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        for (let i = 0; i < dts.length && out.length < max; i++) {
            const k = clean(dts[i].textContent);
            const v = clean(dds[i]?.textContent);
            if (k && v && !seen.has(k)) { seen.add(k); out.push(`${k}: ${v}`); }
        }
    }
    return out;
}

function readImages(max = 8) {
    const urls = new Set();
    const og = document.querySelector('meta[property="og:image"]')?.content;
    if (og) urls.add(absUrl(og));
    for (const img of document.querySelectorAll('img')) {
        const src =
            img.getAttribute('src') ||
            img.getAttribute('data-src') ||
            (img.getAttribute('srcset') || '').split(' ')[0];
        if (!src) continue;
        const u = absUrl(src);
        // funda serves listing media off cloud.funda.nl / *.fundani / media hosts;
        // skip sprites, icons and tiny ui assets.
        if (/funda|fnd|media|cloudinary|images/i.test(u) && !/icon|sprite|logo|\.svg(\?|$)/i.test(u)) {
            urls.add(u);
        }
        if (urls.size >= max) break;
    }
    return Array.from(urls).slice(0, max);
}

// ── tool registrations ──────────────────────────────────────────────────────

if (!browser?.webfuseSession?.registerTool) {
    console.warn('[makelaar] webfuseSession.registerTool unavailable — only runs inside a Webfuse session');
} else {
    browser.webfuseSession.registerTool({
        name: 'getListProperties',
        description:
            'Searches funda.nl for homes for sale in a postal-code area + price range and returns how many were found plus the first page of listings (address, price, listing URL, thumbnail). Self-contained: if the funda search page for these criteria is not open yet, it returns {status:"navigate_required", navigateTo} — open that URL with the navigate tool, then call this again.',
        inputSchema: {
            type: 'object',
            properties: {
                postal_code: { type: 'string', description: "Dutch postcode or area, e.g. '1019' or 'amsterdam'." },
                price_min: { type: 'integer', description: 'Minimum asking price in euros.' },
                price_max: { type: 'integer', description: 'Maximum asking price in euros.' },
                max_results: { type: 'integer', description: 'Cap on returned listings (default 12).' },
            },
            required: ['postal_code'],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (args, ctx) => {
            const max = Math.min(Math.max(args?.max_results || 12, 1), 30);

            // Self-contained: ensure we're on the funda search page for these
            // criteria. If not, hand back the URL to navigate to and re-call.
            if (!onSearchPageFor(args?.postal_code)) {
                return navigateHint(
                    fundaSearchUrl(args?.postal_code, args?.price_min, args?.price_max),
                    'getListProperties',
                );
            }

            beat(ctx, 'dismissing the cookie wall');
            await dismissConsent();

            beat(ctx, 'waiting for funda results to load');
            const ok = await waitFor(
                () => document.querySelectorAll('a[href]').length && extractListings(1).length,
                { timeout: 15000 },
            );

            if (!ok) {
                if (looksBlocked()) {
                    throw new Error(
                        'funda is showing a "verify you are human" interstitial — the search results could not be read. Try again or enable residential IPs on the Space.',
                    );
                }
                // No listings found is a legitimate (zero-result) answer, not an error.
            }

            const count = readResultCount();
            const listings = extractListings(max);
            return JSON.stringify(
                {
                    query: {
                        postal_code: args?.postal_code ?? null,
                        price_min: args?.price_min ?? null,
                        price_max: args?.price_max ?? null,
                    },
                    url: location.href,
                    totalFound: count ?? listings.length,
                    returned: listings.length,
                    listings,
                },
                null,
                2,
            );
        },
    });

    browser.webfuseSession.registerTool({
        name: 'getPropertySummary',
        description:
            'Opens a single funda.nl listing by URL and returns its address, asking price, full description, key features and image URLs. Self-contained: if that listing page is not open yet, it returns {status:"navigate_required", navigateTo} — open that URL with the navigate tool, then call this again.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Full funda.nl listing URL (from getListProperties).' },
            },
            required: ['url'],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (args, ctx) => {
            // Self-contained: make sure the requested listing is the open page.
            const want = listingIdOf(args?.url);
            if (args?.url && want && !location.href.includes(want)) {
                return navigateHint(args.url, 'getPropertySummary');
            }

            beat(ctx, 'dismissing the cookie wall');
            await dismissConsent();

            beat(ctx, 'reading the listing');
            await waitFor(() => readDescription().length > 80 || document.querySelector('h1'), {
                timeout: 15000,
            });

            if (looksBlocked()) {
                throw new Error('funda is showing a human-verification interstitial — this listing could not be read.');
            }

            return JSON.stringify(
                {
                    url: args?.url || location.href,
                    address: readAddress(),
                    price: readPrice(),
                    description: readDescription(),
                    features: readFeatures(),
                    images: readImages(),
                },
                null,
                2,
            );
        },
    });

    // Lets a generic agent (anthill) end a run cleanly and return a result.
    // The makelaar host orchestrates its own flow and simply ignores this.
    browser.webfuseSession.registerTool({
        name: 'finish',
        description:
            'Call when the task is complete. Pass a short result summary; its value is returned as the final automation result.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'Short summary of the result.' },
            },
        },
        annotations: { readOnlyHint: true },
        execute: async (args) => clean(args?.summary) || 'Done.',
    });

    console.log('[makelaar] getListProperties + getPropertySummary + finish registered');
}

// Heartbeat so the Session MCP Server's idle timeout doesn't kill a slow read.
function beat(ctx, message) {
    try {
        browser.webfuseSession.sendAutomationProgress(ctx?.eventId, { progress: 0, total: 0, message });
    } catch (_) { /* optional */ }
}
