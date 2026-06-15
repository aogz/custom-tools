// hacker-news-digest — Webfuse custom MCP tool (service worker; self-contained).
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

const HN_URL = "https://news.ycombinator.com/";

// Strip tags and decode the handful of entities HN emits.
function text(html) {
  return clean(
    String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, "/")
      .replace(/&nbsp;/g, " "),
  );
}

// Parse the HN front page HTML string into story objects.
function parseStories(html, max) {
  const out = [];
  if (!html) return out;
  // Each story headline lives in a <tr class="athing ..."> row.
  const rowRe = /<tr[^>]*\bclass="[^"]*\bathing\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) && out.length < max) {
    const row = m[1];
    // Title anchor: the .titleline link (fallbacks for older markup).
    const linkRe =
      /<span[^>]*class="[^"]*titleline[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
    let link = linkRe.exec(row);
    if (!link) {
      link = /<a[^>]+class="[^"]*(?:storylink|titlelink)[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    }
    if (!link) continue;
    const url = abs(text(link[1]), HN_URL);
    const title = text(link[2]);
    if (!title) continue;

    // Subtext row immediately follows the athing row in the source.
    const after = html.slice(rowRe.lastIndex);
    const subM = /<td[^>]*class="[^"]*subtext[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(after);
    const sub = subM ? subM[1] : "";
    const scoreM = /<span[^>]*class="[^"]*score[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(sub);
    const score = scoreM ? text(scoreM[1]) : "";
    // Comments: last anchor in the subtext that mentions "comment".
    let comments = "";
    const aRe = /<a[^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(sub))) {
      const t = text(am[1]);
      if (/comment/i.test(t) || /^\d+$/.test(t)) comments = t;
    }
    out.push({
      rank: out.length + 1,
      title,
      url,
      score: score || null,
      comments: /comment/i.test(comments) ? comments : null,
    });
  }
  return out;
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
      const stories = parseStories(html, limit);
      if (!stories.length) {
        return JSON.stringify({ url: HN_URL, stories: [], message: "No stories found." }, null, 2);
      }
      return JSON.stringify({ url: HN_URL, stories }, null, 2);
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
