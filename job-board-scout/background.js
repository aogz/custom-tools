// job-board-scout — Webfuse custom MCP tool (service worker; self-contained).
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
async function snapshotHtml(opts = {}) {
  return A().see.domSnapshot({ quality: 1, ...opts });
}
async function dismissConsent(selectors = []) {
  for (const sel of selectors) {
    try { await A().act.click(sel, { waitForTarget: false }); await A().wait(1200); } catch {}
  }
}

// --- parsing helpers -------------------------------------------------------

// Strip tags from an HTML fragment to recover its visible text.
function stripTags(html) {
  return clean(String(html || "").replace(/<[^>]+>/g, " "));
}

// Nav/footer/junk words to exclude (whole-title matches only).
const NAV_WORDS = new Set([
  "login", "log in", "logout", "submit", "past", "comments", "comment", "ask",
  "show", "newest", "new", "hacker news", "ycombinator", "y combinator",
  "privacy", "terms", "about", "contact", "guidelines", "faq", "lists", "api",
  "security", "legal", "apply", "more", "help", "home", "jobs", "search",
  "threads", "settings", "support", "feedback", "rss", "back", "next", "prev",
  "previous", "reply", "favorite", "hide", "flag", "vouch", "career", "careers",
]);

function isNavTitle(title) {
  const t = clean(title).toLowerCase().replace(/[|·•\-–—]+$/g, "").trim();
  if (!t) return true;
  if (NAV_WORDS.has(t)) return true;
  return false;
}

// HN-specific extraction: each posting is a `<tr class="athing ...">` row whose
// `<span class="titleline"><a href>Title</a>` holds the job. The optional
// `<span class="sitebit"><span class="sitestr">company.com</span>` gives a hint.
function parseHN(html, base, max) {
  const out = [];
  const seen = new Set();
  // Capture each athing row's content up to the next athing row / table end.
  const rowRe = /<tr[^>]*\bclass="athing[^"]*"[^>]*>([\s\S]*?)(?=<tr[^>]*\bclass="athing|<\/table>|$)/gi;
  const titleRe = /<span class="titleline"><a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/i;
  const siteRe = /<span class="sitestr">([^<]*)<\/span>/i;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1] || "";
    const t = titleRe.exec(row);
    if (!t) continue;
    const href = t[1] ?? t[2] ?? "";
    const title = stripTags(t[3]);
    if (!title || title.length < 4 || isNavTitle(title)) continue;
    const url = abs(href, base);
    if (seen.has(url)) continue;
    seen.add(url);
    const site = (siteRe.exec(row) || [])[1] || null;
    // Best-effort location sniff from the title text.
    const loc = (title.match(/\b(remote|hybrid|on-?site)\b/i) || [])[0] || null;
    out.push({
      title,
      url,
      location: loc,
      snippet: site ? clean(site) : null,
    });
    if (out.length >= max) break;
  }
  return out;
}

// Generic fallback for non-HN boards: scan anchors whose href/text look like a
// job posting and skip obvious nav/footer links.
function parseGeneric(html, base, max) {
  const out = [];
  const seen = new Set();
  const jobHref = /\b(job|jobs|career|careers|position|opening|vacanc|gh_jid|lever\.co|greenhouse|workable|ashby|smartrecruiters)\b/i;
  const titleHint = /\b(engineer|developer|manager|designer|scientist|analyst|lead|director|hiring|intern|recruiter|founding|marketer|sales|architect|specialist|consultant)\b/i;
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1] ?? m[2] ?? "";
    const title = stripTags(m[3]);
    if (!title || title.length < 4 || title.length > 140) continue;
    if (isNavTitle(title)) continue;
    // The link must look job-related either by URL shape or title wording.
    if (!jobHref.test(href) && !titleHint.test(title)) continue;
    const url = abs(href, base).split("#")[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const start = Math.max(0, m.index - 400);
    const end = Math.min(html.length, anchorRe.lastIndex + 400);
    const ctext = stripTags(html.slice(start, end));
    const loc =
      (ctext.match(/\b(remote|hybrid|on-?site|[A-Z][a-z]+,\s?[A-Z]{2})\b/) || [])[0] || null;
    out.push({ title, url, location: loc, snippet: ctext.slice(0, 120) || null });
    if (out.length >= max) break;
  }
  return out;
}

// Top-level parser: prefer the HN structure, fall back to generic anchors.
function parse(html, base, max) {
  const cap = Math.min(Math.max(max || 15, 1), 40);
  let jobs = parseHN(html, base, cap);
  if (jobs.length === 0) jobs = parseGeneric(html, base, cap);
  return { url: base, count: jobs.length, jobs };
}

// --- tool registration -----------------------------------------------------

if (typeof browser !== "undefined" && browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "readJobs",
    description:
      "Self-contained: navigates to the given job search/results `url` and extracts job listings (title, url, location, snippet) from the page. Returns a small JSON list of the newest postings.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Job search/results URL to read." },
        max_results: { type: "integer", description: "Max listings (default 15)." },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const url = clean(args?.url);
      if (!url) return JSON.stringify({ error: "url is required", jobs: [] });
      const max = Math.min(Math.max(args?.max_results || 15, 1), 40);
      await goto(url);
      await dismissConsent([
        "#onetrust-accept-btn-handler",
        '[aria-label="Accept all"]',
        'button[name="agree"]',
      ]);
      const html = await snapshotHtml();
      if (!html) return JSON.stringify({ url, count: 0, jobs: [], error: "empty snapshot" });
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

  console.log("[job-board-scout] readJobs + finish registered");
} else {
  console.warn("[job-board-scout] registerTool unavailable");
}

// Exported for offline validation only (ignored in the service worker).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parse, parseHN, parseGeneric, clean, abs };
}
