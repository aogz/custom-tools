# custom-tools

Webfuse extensions that add **custom MCP tools** to a Webfuse Space — the example
automations behind [Anthill](https://github.com/aogz)'s **Explore** tab.

Each subfolder is a self-contained Webfuse extension (`manifest.json` +
`background.js` service worker). Anthill installs one into a freshly-created
Space straight from this repo via the Webfuse REST API — the **subfolder is part
of the `repo_url`** (`github.com/owner/repo/folder`):

```
POST /api/spaces/{space_id}/extensions/github/
{ "name": "...",
  "repo_url": "https://github.com/aogz/custom-tools/<subfolder>",
  "ref": "main", "storage_app": <id> }
```

## Examples

| Folder | Tools | What it does |
| :- | :- | :- |
| `amazon-deals` | `findDeals`, `finish` | Biggest discounts on amazon.com |
| `funda-house-hunter` | `getListProperties`, `getPropertySummary`, `finish` | Homes for sale on funda.nl |
| `hacker-news-digest` | `getTopStories`, `finish` | Top Hacker News stories |
| `github-release-notes` | `getLatestRelease`, `finish` | Latest release of a GitHub repo |
| `competitor-price-watch` | `readPrices`, `finish` | Prices on any pricing page |
| `job-board-scout` | `readJobs`, `finish` | Job listings on any board |
| `flight-deals` | `searchFlights`, `finish` | Cheapest itineraries on Google Flights |
| `restaurant-finder` | `findAvailability`, `finish` | Open tables on OpenTable |
| `markets-watch` | `getQuote`, `finish` | Live quotes on Yahoo Finance |

## How the tools are designed

An on-device (or hosted) model orchestrates these tools and never sees raw DOM —
so every tool returns a **small, structured** result. Key conventions:

- **Self-contained, in the service worker.** Tools are registered in the
  extension's service worker, which survives page navigations — so each tool
  navigates to the page it needs (`automation.navigate`), waits for it to settle
  (`page:stable`), reads it (`automation.see.domSnapshot`), and returns in a
  single call. No `navigate_required` handshake.
- **A `finish` tool** ends the run; its `summary` argument is the result.
- `session_id` is auto-injected by Webfuse — tools never declare it.

See the **webfuse-custom-tools** Claude skill for how to author and debug these.

Docs: https://dev.webfu.se/docs/5-automation/8-custom-mcp-tools
