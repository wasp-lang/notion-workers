# Wasp Blog Stats Worker

A Notion Worker that pulls per-post analytics for the [wasp.sh](https://wasp.sh) blog
from the [Plausible Stats API v2](https://plausible.io/docs/stats-api) into a Notion
database, refreshed daily.

## Capabilities

| Key | Type | What it does |
| --- | --- | --- |
| `contentPipelineStatsSync` | Daily job (sync-shaped, writes via Notion API) | Cross-references the existing **Content Pipeline** database by its `URL` property (wasp.sh / wasp-lang.dev blog links) and writes unique visitors + pageviews for the last 30 days and all time, plus a "Stats Updated" date, onto the matching pages. Skips pages whose numbers haven't changed. Requires `NOTION_API_TOKEN`. |
| `getBlogPostStats` | Agent tool | On-demand stats (unique visitors, pageviews, bounce rate) for a single post — by path or slug — or the top posts for a period (`day`, `7d`, `30d`, `6mo`, `12mo`, `all`). Callable by Notion AI or via the CLI. |

The Plausible API key is declared as a brokered credential (`PLAUSIBLE_API_KEY`):
Notion injects it into requests to `plausible.io`, so deployed worker code never sees
the plaintext. For local runs the same variable is read from `.env`.

## Setup / deploy

1. **Notion API token** (needed by `contentPipelineStatsSync` — sync capabilities are not
   pre-authenticated against the workspace):
   - Create a connection at https://app.notion.com/developers/connections
   - Give it access to the **Content Pipeline** database (Growth Dashboard)
   - Add `NOTION_API_TOKEN=<token>` to `.env` (alongside `PLAUSIBLE_API_KEY`)

2. Deploy:

```bash
ntn login                     # authenticate with the Notion workspace (opens browser)
ntn workers deploy            # build and publish the worker
ntn workers env push          # push .env secrets to the deployed worker
ntn workers sync trigger contentPipelineStatsSync # first run now, instead of waiting
```

The sync then runs automatically once a day.

Note: the Workers platform requires every sync to target a managed database, so
deploying creates an empty database called "Plausible Sync (internal, unused)".
The sync never writes to it — hide or ignore it.

The Content Pipeline stat columns (`Unique Visitors (30d)`, `Pageviews (30d)`,
`Unique Visitors (All Time)`, `Pageviews (All Time)`, `Stats Updated`) already exist;
the worker only writes values into them, keyed on the `URL` property
(data source `476e60eb-4d1c-4559-b498-9fcee0b4c381`).

## Common commands

```bash
# Run the tool (locally or against the deployed worker)
ntn workers exec getBlogPostStats --local -d '{"path": null, "period": "30d", "limit": 10}'
ntn workers exec getBlogPostStats -d '{"path": "wasp-typescript-spec", "period": "all", "limit": 10}'

# Trigger the sync manually / check on it
ntn workers sync trigger contentPipelineStatsSync
ntn workers sync status
ntn workers runs list

# Rotate the Plausible key: update .env, then
ntn workers env push
```
