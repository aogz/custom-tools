// github-release-notes — reads a repo's latest release on github.com.

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

function navHint(navigateTo, tool) {
  return JSON.stringify(
    {
      status: "navigate_required",
      navigateTo,
      message: `Open ${navigateTo} with the navigate tool, then call ${tool} again with the same arguments.`,
    },
    null,
    2,
  );
}

function onReleasesOf(repo) {
  // /owner/name/releases or /releases/tag/... or /releases/latest
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/releases/);
  return m && `${m[1]}/${m[2]}`.toLowerCase() === String(repo).trim().toLowerCase();
}

function readLatest() {
  const title =
    clean(document.querySelector(".release-header a, [data-test-selector='release-card'] a, h1")?.textContent) ||
    clean(document.title.split("·")[0]);
  const tag = clean(
    document.querySelector(".octicon-tag")?.closest("a, span")?.textContent ||
      (location.pathname.match(/\/tag\/([^/]+)/) || [])[1] ||
      "",
  );
  const when = clean(document.querySelector("relative-time, time")?.getAttribute("datetime") || "");
  const body =
    clean(document.querySelector(".markdown-body")?.innerText || "").slice(0, 4000) ||
    clean(document.body?.innerText || "").slice(0, 2000);
  return { title, tag: tag || null, published: when || null, notes: body };
}

if (!browser?.webfuseSession?.registerTool) {
  console.warn("[github-release-notes] registerTool unavailable");
} else {
  browser.webfuseSession.registerTool({
    name: "getLatestRelease",
    description:
      "Returns a GitHub repo's latest release (tag, title, published, notes). If that repo's releases page isn't open, returns {status:'navigate_required', navigateTo}.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "Repository as 'owner/name'." } },
      required: ["repo"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const repo = clean(args?.repo);
      if (!repo) throw new Error("repo is required, e.g. 'vercel/next.js'.");
      if (!onReleasesOf(repo)) {
        return navHint(`https://github.com/${repo}/releases/latest`, "getLatestRelease");
      }
      return JSON.stringify({ repo, url: location.href, ...readLatest() }, null, 2);
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
}
