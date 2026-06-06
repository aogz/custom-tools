// job-board-scout — extracts job listings from any job board / results page.

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const abs = (h) => {
  try {
    return new URL(h, location.href).href;
  } catch {
    return h || "";
  }
};

function navHint(navigateTo, tool) {
  return JSON.stringify(
    {
      status: "navigate_required",
      navigateTo,
      message: `Open ${navigateTo} with the navigate tool, then call ${tool} again.`,
    },
    null,
    2,
  );
}

function sameUrl(a, b) {
  try {
    const ua = new URL(a),
      ub = new URL(b, location.href);
    return ua.host === ub.host && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function readJobs(max) {
  const out = [];
  const seen = new Set();
  const anchors = [...document.querySelectorAll("a[href]")].filter((a) =>
    /\b(job|jobs|career|careers|position|vacanc|gh_jid|lever\.co|greenhouse)\b/i.test(
      a.getAttribute("href") || "",
    ),
  );
  for (const a of anchors) {
    const url = abs(a.getAttribute("href")).split("?")[0];
    if (seen.has(url)) continue;
    const title = clean(a.textContent);
    if (!title || title.length < 3 || title.length > 120) continue;
    seen.add(url);
    const card = a.closest("li, article, [class*='job'], [class*='card'], tr, div") || a;
    const ctext = clean(card.innerText || "");
    const loc = (ctext.match(/\b(remote|hybrid|on-?site|[A-Z][a-z]+,\s?[A-Z]{2})\b/) || [])[0] || null;
    out.push({ title, url, location: loc, snippet: ctext.slice(0, 120) });
    if (out.length >= max) break;
  }
  return out;
}

if (!browser?.webfuseSession?.registerTool) {
  console.warn("[job-board-scout] registerTool unavailable");
} else {
  browser.webfuseSession.registerTool({
    name: "readJobs",
    description:
      "Extracts job listings (title, url, location, snippet) from the open page. If `url` is given and not open, returns {status:'navigate_required', navigateTo}.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Job search/results URL to read." },
        max_results: { type: "integer", description: "Max listings (default 15)." },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      const url = clean(args?.url);
      if (url && !sameUrl(url, location.href)) return navHint(url, "readJobs");
      const max = Math.min(Math.max(args?.max_results || 15, 1), 40);
      const jobs = readJobs(max);
      return JSON.stringify({ url: location.href, count: jobs.length, jobs }, null, 2);
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
}
