// job-board-scout — Webfuse custom MCP tool (service worker; self-contained).
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

// Strip tags from an HTML fragment to recover its visible text.
function stripTags(html) {
  return clean(String(html || "").replace(/<[^>]+>/g, " "));
}

// Parse the snapshot HTML for job-listing anchors. Mirrors the original
// content-script logic: href must look job-related, title comes from the
// anchor text, location is sniffed from nearby text, snippet is a short
// excerpt. No DOMParser in a service worker, so we regex over the string.
function parseJobs(html, base, max) {
  const out = [];
  const seen = new Set();
  const jobHref = /\b(job|jobs|career|careers|position|vacanc|gh_jid|lever\.co|greenhouse)\b/i;
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1] ?? m[2] ?? "";
    if (!jobHref.test(href)) continue;
    const url = abs(href, base).split("?")[0];
    if (seen.has(url)) continue;
    const title = stripTags(m[3]);
    if (!title || title.length < 3 || title.length > 120) continue;
    seen.add(url);
    // Context: take a window of HTML around the anchor and strip it to text.
    const start = Math.max(0, m.index - 400);
    const end = Math.min(html.length, anchorRe.lastIndex + 400);
    const ctext = stripTags(html.slice(start, end));
    const loc =
      (ctext.match(/\b(remote|hybrid|on-?site|[A-Z][a-z]+,\s?[A-Z]{2})\b/) || [])[0] || null;
    out.push({ title, url, location: loc, snippet: ctext.slice(0, 120) });
    if (out.length >= max) break;
  }
  return out;
}

if (browser?.webfuseSession?.registerTool) {
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
      const html = await snapshotHtml();
      if (!html) return JSON.stringify({ url, count: 0, jobs: [], error: "empty snapshot" });
      const jobs = parseJobs(html, url, max);
      return JSON.stringify({ url, count: jobs.length, jobs });
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
