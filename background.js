// github-release-notes — Webfuse custom MCP tool (service worker; self-contained).
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

// Strip HTML tags to text, decoding the few entities GitHub commonly emits.
function htmlToText(html) {
  return clean(
    String(html || "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>(?=)/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

function parseRelease(html, repo, url) {
  // Detect a missing repo / no-releases page.
  if (/This is not the web page you are looking for|Page not found/i.test(html)) {
    return { error: "not_found", message: `No GitHub page for '${repo}' (404).` };
  }

  // Tag: prefer the URL shape (/releases/tag/<tag>), then the page title.
  let tag =
    (url.match(/\/releases\/tag\/([^/?#]+)/) || [])[1] ||
    (html.match(/\/releases\/tag\/([^/?#"]+)/) || [])[1] ||
    "";
  tag = clean(decodeURIComponent(tag));

  // Title: the release header link/heading, falling back to the document title.
  let title =
    htmlToText((html.match(/<h1[^>]*class="[^"]*\brelease-header\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) ||
    htmlToText((html.match(/class="[^"]*\bf1\b[^"]*"[^>]*>([\s\S]*?)<\/(?:h1|a|span)>/i) || [])[1]) ||
    clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1].split("·")[0]);

  // Published date: the datetime attribute of relative-time / time.
  const published = clean(
    (html.match(/<(?:relative-time|time)[^>]*\bdatetime="([^"]+)"/i) || [])[1] || "",
  );

  // Notes: the rendered markdown body.
  let notes =
    htmlToText((html.match(/<div[^>]*class="[^"]*\bmarkdown-body\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]) ||
    htmlToText(html);
  notes = notes.slice(0, 4000);

  if (!title && !tag && !notes) {
    return { error: "empty", message: `Could not read a release for '${repo}'.` };
  }

  return { repo, url, title: title || null, tag: tag || null, published: published || null, notes };
}

if (browser?.webfuseSession?.registerTool) {
  browser.webfuseSession.registerTool({
    name: "getLatestRelease",
    description:
      "Returns a GitHub repo's latest release (tag, title, published, notes). Pass `repo` as 'owner/name', e.g. 'vercel/next.js'. Self-contained: navigates and reads in one call.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "Repository as 'owner/name'." } },
      required: ["repo"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const repo = clean(args?.repo);
      if (!repo) throw new Error("repo is required, e.g. 'vercel/next.js'.");
      const url = abs(`/${repo}/releases/latest`, "https://github.com/");
      await goto(url);
      const html = await snapshotHtml();
      return JSON.stringify(parseRelease(String(html || ""), repo, url), null, 2);
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[github-release-notes] getLatestRelease + finish registered");
} else {
  console.warn("[github-release-notes] registerTool unavailable");
}
