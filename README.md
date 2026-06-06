# custom-tools

Webfuse extensions that add **custom MCP tools** to a Webfuse Space — the example
automations behind [Anthill](https://github.com/aogz)'s **Explore** tab.

Each subfolder is a self-contained Webfuse extension (`manifest.json` +
`content.js`). Anthill installs one into a freshly-created Space straight from
this repo via the Webfuse REST API:

```
POST /api/spaces/{space_id}/extensions/github/
{ "name": "...", "repo_url": "https://github.com/aogz/custom-tools",
  "ref": "main", "storage_app": <id>, "storage_app_directory": "<subfolder>" }
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

## How the tools are designed

An on-device (or hosted) model orchestrates these tools and never sees raw DOM —
so every tool returns a **small, structured** result. Key conventions:

- **Self-contained.** A tool computes the URL it needs and, if that page isn't
  open, returns `{ "status": "navigate_required", "navigateTo": "<url>" }`. The
  caller opens it with the built-in `navigate` tool and re-calls — a content
  script can't survive a full page load, so navigation is the caller's job.
- **A `finish` tool** ends the run; its `summary` argument is the result.
- `session_id` is auto-injected by Webfuse — tools never declare it.

See the **webfuse-custom-tools** Claude skill for how to author and debug these.

Docs: https://dev.webfu.se/docs/5-automation/8-custom-mcp-tools
