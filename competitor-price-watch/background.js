// competitor-price-watch — Webfuse custom MCP tool (service worker; self-contained).
// readPrices: navigates to any pricing page `url`, reads the RAW HTML snapshot
// (domSnapshot {quality:1}) and extracts {label, price} pairs with a generic parser.
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
    try { await A().act.click(sel, { waitForTarget: false }); await A().wait(1200); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Generic pricing parser. Works on raw HTML (quality:1) from any pricing page.
// ---------------------------------------------------------------------------

// Decode the handful of HTML entities that show up in plan/label text.
const decode = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ");

const txt = (h) => clean(decode(String(h || "").replace(/<[^>]+>/g, " ")));

// A money token: $/£/€ + number, optional cadence suffix (/mo, /month, /yr ...).
const PRICE_RE = /[$£€]\s?\d[\d.,]*(?:\s?(?:\/\s?mo(?:nth)?|per\s+month|\/\s?yr|\/\s?year|\s?\/\s?month))?/i;
const PRICE_RE_G = new RegExp(PRICE_RE.source, "gi");

// "Free", "Custom", "Contact (sales)" act as a price when attached to a plan.
const SOFT_PRICE_RE = /\b(free(?:\s+forever)?|custom(?:\s+pricing)?|contact(?:\s+(?:us|sales))?|let'?s\s+talk|get\s+a\s+quote)\b/i;

// CTA / chrome text that masquerades as a short label — never use as a plan.
const STOP_LABEL_RE = /^(sign\s*up|get\s+started|start(?:\s+free)?|try|buy|contact|learn\s+more|see\s+(?:all|more)|view|log\s*in|login|menu|home|popular|new|included|all\b)/i;

// Plan/tier names used to recognise labels. Deliberately excludes "free" and
// "custom" — on real pricing tables those are price VALUES (table cells), not
// tier names, so keeping them out avoids treating every "Custom" cell as a plan.
const PLAN_WORDS = [
  "hobby", "pro", "enterprise", "starter", "basic", "standard",
  "premium", "business", "team", "teams", "plus", "growth", "scale",
  "professional", "developer", "advanced", "ultimate",
  "essential", "essentials",
];
const PLAN_RE = new RegExp("^(?:" + PLAN_WORDS.join("|") + ")\\b", "i");
// Exact plan tier: the whole text node IS the plan name (optionally "Plan").
const PLAN_EXACT_RE = new RegExp("^(?:" + PLAN_WORDS.join("|") + ")(?:\\s+plan)?$", "i");

// Pull every >text< node, recording its byte offset so we can correlate
// labels (which appear before) with prices.
function textNodes(html) {
  const clean_html = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const nodes = [];
  const RE = />([^<>]+)</g;
  let m;
  while ((m = RE.exec(clean_html)) !== null) {
    const t = clean(decode(m[1]));
    if (t) nodes.push({ pos: m.index, text: t });
  }
  return { nodes, clean_html };
}

// Collect candidate labels: real headings (h1-h4), elements whose text is a
// known plan word, and short stand-alone capitalised tokens. Each gets a
// weight so plan-word/heading labels beat generic short text.
function collectLabels(html, nodes) {
  const labels = [];

  // `data-plan="..."` / `data-tier="..."` / `value="..."` attrs — strong, stable
  // plan anchors many pricing tables expose.
  const ARE = /\bdata-(?:plan|tier)\s*=\s*"([^"]{1,24})"/gi;
  let am;
  while ((am = ARE.exec(html)) !== null) {
    const t = clean(decode(am[1]));
    if (t && !STOP_LABEL_RE.test(t)) {
      const text = t.replace(/^\w/, (c) => c.toUpperCase()).slice(0, 60);
      labels.push({ pos: am.index, text, weight: 3, plan: PLAN_EXACT_RE.test(text) });
    }
  }

  // Real headings.
  const HRE = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let hm;
  while ((hm = HRE.exec(html)) !== null) {
    const t = txt(hm[1]).slice(0, 60);
    if (t && !STOP_LABEL_RE.test(t)) labels.push({ pos: hm.index, text: t, weight: 2, plan: PLAN_EXACT_RE.test(t) });
  }

  // Text nodes that look like a plan name.
  for (const n of nodes) {
    if (n.text.length > 24) continue;
    if (PRICE_RE.test(n.text)) continue;
    if (STOP_LABEL_RE.test(n.text)) continue;
    if (PLAN_EXACT_RE.test(n.text)) {
      labels.push({ pos: n.pos, text: n.text.slice(0, 60), weight: 3, plan: true });
    } else if (/^[A-Z][A-Za-z0-9 +.&'-]{1,22}$/.test(n.text) && n.text.split(" ").length <= 4) {
      // Short Title-ish phrase — weak label fallback.
      labels.push({ pos: n.pos, text: n.text.slice(0, 60), weight: 1 });
    }
  }

  labels.sort((a, b) => a.pos - b.pos);
  return labels;
}

// Nearest preceding label, preferring higher weight when several are close by.
function nearestLabel(labels, pos) {
  let best = null;
  let bestScore = -Infinity;
  for (const l of labels) {
    if (l.pos > pos) break;
    const dist = pos - l.pos;
    // Closer + heavier wins. Distance dominates, weight breaks near-ties.
    const score = -dist + l.weight * 400;
    if (score >= bestScore) { bestScore = score; best = l; }
  }
  return best;
}

function parse(html, url, max = 20) {
  html = String(html || "");
  const { nodes } = textNodes(html);
  const labels = collectLabels(html, nodes);

  const collected = [];
  const seen = new Set();
  const add = (lbl, price, soft) => {
    const label = lbl ? clean(lbl.text).slice(0, 60) : null;
    price = clean(price);
    if (!price) return;
    const key = `${(label || "").toLowerCase()}|${price.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Rank: plan-tier rows first (label is an exact plan name), then everything
    // else; soft prices (Free/Custom) for a plan also rank high.
    const isPlan = lbl && lbl.plan;
    const rank = (isPlan ? 0 : 2) + (soft ? -0.5 : 0);
    collected.push({ label: label || null, price, _rank: rank, _ord: collected.length });
  };

  // Hard money tokens, anchored to their position for label lookup.
  for (const n of nodes) {
    let pm;
    PRICE_RE_G.lastIndex = 0;
    while ((pm = PRICE_RE_G.exec(n.text)) !== null) {
      add(nearestLabel(labels, n.pos), pm[0], false);
    }
  }

  // Soft prices (Free / Custom / Contact) — only when the nearest label is an
  // exact plan tier, so we capture e.g. Hobby/Free, Enterprise/Contact.
  for (const n of nodes) {
    if (n.text.length > 40) continue;
    const sm = n.text.match(SOFT_PRICE_RE);
    if (!sm) continue;
    const label = nearestLabel(labels, n.pos);
    if (!label || !label.plan) continue;
    const word = sm[1].toLowerCase();
    const price = /free/.test(word) ? "Free"
      : /custom|quote/.test(word) ? "Custom"
      : "Contact sales";
    add(label, price, true);
  }

  collected.sort((a, b) => (a._rank - b._rank) || (a._ord - b._ord));
  const prices = collected.slice(0, max).map(({ label, price }) => ({ label, price }));
  return { url: url || "", count: prices.length, prices };
}

// ---------------------------------------------------------------------------

if (typeof browser !== "undefined" && browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "readPrices",
    description:
      "Self-contained: navigates to the given pricing page `url`, then extracts prices and the nearest plan/product label. Returns {url, count, prices:[{label, price}]}.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Pricing page URL to read." } },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const url = clean(args?.url);
      if (!url) return JSON.stringify({ url: "", count: 0, prices: [], error: "missing url" });
      await goto(url);
      await dismissConsent([
        "#onetrust-accept-btn-handler",
        'button[name="agree"]',
        '[aria-label="Accept all"]',
        "#didomi-notice-agree-button",
      ]);
      const html = await snapshotHtml();
      return JSON.stringify(parse(html || "", url));
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary; its value is the final result.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[competitor-price-watch] readPrices + finish registered");
} else if (typeof module !== "undefined") {
  module.exports = { parse, clean }; // offline validation only
}
