// hacker-news-digest — Webfuse custom MCP tool (service worker; self-contained).
const A = () => browser.webfuseSession.automation;
const clean = (s) => String(s||"").replace(/\s+/g," ").trim();
const abs = (h, base) => { try { return new URL(h, base).href; } catch { return h||""; } };
async function goto(url) {
  await A().navigate(url);
  await new Promise((res)=>{let d=false;const f=()=>{if(!d){d=true;res();}};try{A().once("page:stable",f);}catch{}setTimeout(f,8000);});
}
// Raw, full-fidelity HTML — a small maxTokens triggers Webfuse D2Snap
// downsampling into lossy markdown that breaks tag/class parsing.
async function snapshotHtml(opts = {}) { return A().see.domSnapshot({ quality: 1, ...opts }); }

const HN_URL = "https://news.ycombinator.com/";

// Decode the handful of HTML entities HN emits, then strip tags.
function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x2f;/g, "/")
    .replace(/&nbsp;/g, " ");
}
function text(html) {
  return clean(decode(String(html || "").replace(/<[^>]*>/g, " ")));
}

// Parse the HN front-page HTML string into { url, stories:[{rank,title,url,score,comments}] }.
function parse(html, max) {
  const out = [];
  if (!html) return { url: HN_URL, stories: out };
  // Each story headline lives in a <tr class="athing ..."> row.
  const rowRe = /<tr[^>]*\bclass="[^"]*\bathing\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) && out.length < max) {
    const row = m[1];
    // Title anchor: the .titleline link (fallbacks for older markup).
    let link =
      /<span[^>]*class="[^"]*\btitleline\b[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) {
      link = /<a[^>]+class="[^"]*(?:storylink|titlelink)[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    }
    if (!link) continue;
    const url = abs(decode(link[1]), HN_URL);
    const title = text(link[2]);
    if (!title) continue;

    // Rank, if present, otherwise positional.
    const rankM = /<span[^>]*class="[^"]*\brank\b[^"]*"[^>]*>\s*(\d+)\.?\s*<\/span>/i.exec(row);
    const rank = rankM ? parseInt(rankM[1], 10) : out.length + 1;

    // The subtext row immediately follows the athing row in the source.
    const after = html.slice(rowRe.lastIndex);
    const subM = /<td[^>]*class="[^"]*\bsubtext\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(after);
    const sub = subM ? subM[1] : "";

    const scoreM = /<span[^>]*class="[^"]*\bscore\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(sub);
    const score = scoreM ? text(scoreM[1]) : null;

    // Comments: last subtext anchor whose href points at an item/comment thread.
    let comments = null;
    const aRe = /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(sub))) {
      const href = am[1];
      const t = text(am[2]);
      if (/comment/i.test(href) || /comment/i.test(t)) {
        const n = t.match(/\d[\d,]*/);
        comments = n ? parseInt(n[0].replace(/,/g, ""), 10) : (/^discuss$/i.test(t) ? 0 : comments);
      }
    }

    out.push({ rank, title, url, score, comments });
  }
  return { url: HN_URL, stories: out };
}

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "getTopStories",
    description:
      "Navigates to the Hacker News front page and returns the top stories (rank, title, url, score, comments). Self-contained: it opens HN itself, no prior navigation needed.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many stories (default 10)." } },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const limit = Math.min(Math.max(args?.limit || 10, 1), 30);
      await goto(HN_URL);
      const html = await snapshotHtml();
      return JSON.stringify(parse(html, limit));
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[hacker-news-digest] getTopStories + finish registered");
} else {
  console.warn("[hacker-news-digest] registerTool unavailable");
}
