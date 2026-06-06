// hacker-news-digest — reads the Hacker News front page.

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

function readTop(max) {
  const out = [];
  for (const row of document.querySelectorAll("tr.athing")) {
    const a = row.querySelector(".titleline a, a.storylink, .title a");
    if (!a) continue;
    const sub = row.nextElementSibling;
    const score = clean(sub?.querySelector(".score")?.textContent);
    const links = sub ? [...sub.querySelectorAll("a")] : [];
    const comments = clean(links.length ? links[links.length - 1].textContent : "");
    out.push({
      rank: out.length + 1,
      title: clean(a.textContent),
      url: abs(a.getAttribute("href")),
      score: score || null,
      comments: /comment/i.test(comments) ? comments : null,
    });
    if (out.length >= max) break;
  }
  return out;
}

if (!browser?.webfuseSession?.registerTool) {
  console.warn("[hacker-news-digest] registerTool unavailable");
} else {
  browser.webfuseSession.registerTool({
    name: "getTopStories",
    description:
      "Reads the Hacker News front page and returns the top stories (rank, title, url, score, comments). If HN isn't open, returns {status:'navigate_required', navigateTo}.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many stories (default 10)." } },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      if (!/news\.ycombinator\.com$/.test(location.host) || !document.querySelector("tr.athing")) {
        return navHint("https://news.ycombinator.com/", "getTopStories");
      }
      const limit = Math.min(Math.max(args?.limit || 10, 1), 30);
      return JSON.stringify({ url: location.href, stories: readTop(limit) }, null, 2);
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
}
