// github-release-notes — Webfuse custom MCP tool (service worker; self-contained).
const A = () => browser.webfuseSession.automation;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const abs = (h, base) => { try { return new URL(h, base).href; } catch { return h || ""; } };
async function goto(url) {
  await A().navigate(url);
  await new Promise((res) => {
    let d = false;
    const f = () => { if (!d) { d = true; res(); } };
    try { A().once("page:stable", f); } catch { /* no event support */ }
    setTimeout(f, 8000);
  });
}
// Raw, full-fidelity HTML — a small maxTokens triggers Webfuse downsampling
// into lossy markdown that breaks tag/class parsing.
async function snapshotHtml(opts = {}) { return A().see.domSnapshot({ quality: 1, ...opts }); }

// First capture group of a regex, or "" — never undefined, so callers can
// safely .split()/.slice()/decodeURIComponent() the result. This guard fixes
// the "Cannot read properties of undefined (reading 'split')" crash.
function cap(re, str) {
  const m = String(str || "").match(re);
  return (m && m[1] != null) ? m[1] : "";
}

// Strip HTML tags to text, decoding the few entities GitHub commonly emits.
function htmlToText(html) {
  return clean(
    String(html || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#x2[fF];/g, "/"),
  );
}

// Parse the latest-release page HTML into {repo,url,title,tag,published,notes}.
function parse(html, repo, url) {
  html = String(html || "");

  // Detect a missing repo / no-releases page.
  if (/This is not the web page you are looking for|Page not found/i.test(html)) {
    return { repo, url, error: "not found" };
  }

  // Tag: prefer the URL shape (/releases/tag/<tag>), then the page HTML.
  // The char class stops at quote/entity/whitespace boundaries so escaped
  // JSON blobs (…/tag/v1&quot;,…) don't leak into the tag. Guarded via cap().
  const TAG_RE = /\/releases\/tag\/([^/?#"'\s&<>\\]+)/;
  let tag = cap(TAG_RE, url) || cap(TAG_RE, html);
  try { tag = decodeURIComponent(tag); } catch { /* leave raw */ }
  tag = clean(tag);

  // Title: the release header heading. In the real snapshot this is
  // <h1 ... class="...d-inline">v16.2.9</h1>. Fall back to release-header,
  // then <title>, then the tag. cap() ensures .split() never hits undefined.
  let title = htmlToText(cap(/<h1[^>]*class="[^"]*\bd-inline\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i, html));
  if (!title) title = htmlToText(cap(/<h1[^>]*class="[^"]*\brelease-header\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i, html));
  if (!title) title = clean(cap(/<title[^>]*>([\s\S]*?)<\/title>/i, html).split("·")[0]);
  if (!title) title = tag;

  // Published: relative-time is rendered as an element carrying datetime="...".
  // Prefer a full ISO-8601 timestamp; fall back to any datetime value.
  const published = clean(
    cap(/datetime="(\d{4}-\d{2}-\d{2}T[^"]+)"/i, html) ||
    cap(/datetime="([^"]+)"/i, html),
  );

  // Notes: the rendered markdown body, stripped to text and capped.
  let notes = htmlToText(cap(/<div[^>]*class="[^"]*\bmarkdown-body\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i, html));
  notes = (notes || "").slice(0, 4000);

  return {
    repo,
    url,
    title: title || "",
    tag: tag || "",
    published: published || "",
    notes,
  };
}

if (typeof browser !== "undefined" && browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "getLatestRelease",
    description:
      "Returns a GitHub repo's latest release (tag, title, published date, notes). Pass `repo` as 'owner/name', e.g. 'vercel/next.js'. Self-contained: navigates to the repo's latest-release page and reads it in one call.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "Repository as 'owner/name', e.g. 'vercel/next.js'." } },
      required: ["repo"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const repo = clean(args?.repo);
      if (!repo) throw new Error("repo is required, e.g. 'vercel/next.js'.");
      const url = "https://github.com/" + repo + "/releases/latest";
      await goto(url);
      const html = await snapshotHtml();
      return JSON.stringify(parse(html, repo, url));
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary; its value is the final result.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[github-release-notes] getLatestRelease + finish registered");
} else {
  console.warn("[github-release-notes] registerTool unavailable");
}

// --- offline validation harness (ignored inside the service worker) ---
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parse, htmlToText, cap, clean, abs };
}
