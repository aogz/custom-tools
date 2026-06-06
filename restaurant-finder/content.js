// restaurant-finder — reads OpenTable search results for open tables.

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      message: `Open ${navigateTo} with the navigate tool, then call ${tool} again with the same arguments.`,
    },
    null,
    2,
  );
}

async function waitFor(fn, { timeout = 15000, interval = 400 } = {}) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    try {
      v = fn();
      if (v) return v;
    } catch {
      /* keep polling */
    }
    await sleep(interval);
  }
  return v || null;
}

function searchUrl(a) {
  const term = [a.cuisine, a.city].filter(Boolean).join(" ");
  const p = new URLSearchParams({ term });
  if (a.party_size) p.set("covers", String(a.party_size));
  if (a.date && a.time) p.set("dateTime", `${a.date}T${a.time}`);
  return `https://www.opentable.com/s?${p.toString()}`;
}

function readResults(max) {
  const out = [];
  const seen = new Set();
  const cards = document.querySelectorAll(
    '[data-test="restaurant-card"], [data-testid="restaurant-card"], li',
  );
  for (const card of cards) {
    const a = card.querySelector('a[href*="/r/"], a[href*="/restaurant/"]');
    if (!a) continue;
    const url = abs(a.getAttribute("href")).split("?")[0];
    if (seen.has(url)) continue;
    const text = clean(card.innerText);
    const name = clean(card.querySelector("h2, h3, a")?.textContent);
    if (!name) continue;
    seen.add(url);
    const rating = (text.match(/\b[0-5]\.\d\b/) || [])[0] || null;
    const price = (text.match(/[$£€]{1,4}/) || [])[0] || null;
    const times = [...new Set((text.match(/\b\d{1,2}:\d{2}\s?(?:AM|PM)?\b/gi) || []))].slice(0, 6);
    out.push({ name, url, rating, price, times });
    if (out.length >= max) break;
  }
  return out;
}

if (!browser?.webfuseSession?.registerTool) {
  console.warn("[restaurant-finder] registerTool unavailable");
} else {
  browser.webfuseSession.registerTool({
    name: "findAvailability",
    description:
      "Returns OpenTable restaurants with open tables (name, cuisine, rating, price, times). If the results page isn't open, returns {status:'navigate_required', navigateTo}.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM (24h)" },
        party_size: { type: "integer" },
        cuisine: { type: "string" },
      },
      required: ["city"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (args) => {
      if (!/\/s(\/|\?|$)/.test(location.pathname + location.search)) {
        return navHint(searchUrl(args), "findAvailability");
      }
      const max = Math.min(Math.max(args?.party_size ? 12 : 12, 1), 20);
      await waitFor(() => readResults(1).length);
      const restaurants = readResults(max);
      return JSON.stringify(
        { url: location.href, returned: restaurants.length, restaurants },
        null,
        2,
      );
    },
  });

  browser.webfuseSession.registerTool({
    name: "finish",
    description: "Call when the task is complete. Pass a short result summary.",
    inputSchema: { type: "object", properties: { summary: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (a) => clean(a?.summary) || "Done.",
  });

  console.log("[restaurant-finder] findAvailability + finish registered");
}
