# Ads Updates Tracker

**Live site:** https://thisnomanbutt.github.io/Ads-Updates-Tracker/ · **RSS:** `/feed.xml`

> Note: some corporate networks (including CureMD's) block `*.github.io`. If the page will not
> load at the office, publish the same `docs/` folder on Netlify as well and use that URL.

A self-updating page that collects **Google Ads** and **Meta Ads** product news (new features, renamed or
re-branded features, functionality changes, deprecations, policy changes) and rewrites each item in plain English
with "what changed / why it matters / what to do".

How it works:

1. A GitHub Action runs every 6 hours (`.github/workflows/update.yml`).
2. `scripts/update.mjs` pulls the RSS/Atom feeds in `scripts/sources.json`, drops anything already seen or
   off-topic, and asks Claude to classify and summarize each new item.
3. The results are committed to `docs/data/items.json` and `docs/feed.xml`.
4. Netlify (or GitHub Pages) serves the `docs/` folder. The page (`docs/index.html`) is static and reads the JSON.
5. Optional: new items are posted to a Slack and/or Teams incoming webhook.

Nothing runs on your machine. The only thing you pay for is the Claude API calls (roughly 1 to 2 US cents per
news item at the default model; typically 10 to 40 items per day).

## One-time setup (about 15 minutes)

### 1. Push this folder to GitHub

Create an empty repository on github.com (private is fine), then from this folder:

```powershell
git remote add origin https://github.com/<your-user>/ads-updates-tracker.git
git push -u origin main
```

### 2. Add the API key (optional, but recommended)

Without a key the tracker still runs: items are classified by keyword rules and shown with the source's own
excerpt. With a key, each item gets a plain-English AI summary plus "what changed / why it matters / what to do".

To get a key: sign up at https://console.anthropic.com, add a payment method under Billing (a $5 prepaid
credit lasts months at this volume), then API Keys → Create Key. Then:

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |

Optional secrets (same place): `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL` for chat notifications.

Optional variables (**Variables** tab, not Secrets):

| Name | Default | Purpose |
|---|---|---|
| `SITE_URL` | empty | Public URL of the site, used in the RSS feed and webhook messages |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Set `claude-sonnet-5` or `claude-haiku-4-5` to cut cost |
| `MAX_ITEM_AGE_DAYS` | `30` | Ignore feed items older than this (first run backfills this many days) |
| `MAX_NEW_PER_RUN` | `40` | Cost guard per run; leftovers are picked up next run |

### 3. Run it once

**Actions → Update ads news → Run workflow.** The first run backfills the last 30 days and commits
`docs/data/items.json`. Later runs only process new items.

### 4. Host the page

**Netlify (recommended):** app.netlify.com → Add new site → Import from Git → pick the repo.
Build command: leave empty. Publish directory: `docs`. Netlify redeploys automatically every time the
Action commits. Then set `SITE_URL` (step 2) to the Netlify URL.

**GitHub Pages (alternative):** Settings → Pages → Source "Deploy from a branch" → branch `main`, folder `/docs`.
Note: some corporate networks block `*.github.io`, in which case use Netlify.

## Getting notified

- **RSS**: subscribe to `<SITE_URL>/feed.xml` in Outlook (Add RSS feed), Slack (`/feed subscribe <url>`), Feedly, etc.
- **Slack**: create an Incoming Webhook and store it as the `SLACK_WEBHOOK_URL` secret.
- **Teams**: create an Incoming Webhook (Workflows app) and store it as `TEAMS_WEBHOOK_URL`. Payload is an Adaptive Card.
- **Email**: point Zapier/Power Automate at the RSS feed, or use Outlook's RSS subscription.

## Sources

| Source | Type | Notes |
|---|---|---|
| Google Ads Developer Blog | official | API changes, deprecations, sunsets |
| Google Ads & Commerce Blog | official | Product announcements |
| Google Marketing Platform Blog | official | Keyword-filtered to paid-media posts |
| Meta for Developers Blog | official | Keyword-filtered (Marketing API, Conversions API, ads) |
| Meta Newsroom | official | Keyword-filtered to advertising posts |
| PPC Land, Search Engine Land, Search Engine Roundtable, Social Media Today, Jon Loomer | trade press | Keyword-filtered; the model decides final relevance |

Meta's own "Facebook for Business news" RSS stopped updating in 2020, so Meta announcements arrive via the
Newsroom, the developer blog and trade press. Add or remove feeds in `scripts/sources.json`:
`filter: "none"` sends every item to the model, `filter: "keywords"` requires an ads keyword match first.

## Adjusting behaviour

- **Schedule**: edit the `cron` line in `.github/workflows/update.yml` (UTC).
- **Keyword pre-filter**: the `KEYWORDS` regex near the top of `scripts/update.mjs`.
- **What counts as relevant / writing style**: `SYSTEM_PROMPT` in `scripts/update.mjs`.
- **Fields shown on the page**: the `Analysis` schema in `scripts/update.mjs` and `card()` in `docs/index.html`.
- **Dry run** (fetch + filter only, no API calls): run the workflow locally with `DRY_RUN=1 node scripts/update.mjs`,
  or add `DRY_RUN: "1"` to the workflow env temporarily.

## Files

```
.github/workflows/update.yml   scheduled job: fetch → summarize → commit
scripts/update.mjs             the whole pipeline
scripts/sources.json           feed list
docs/index.html                the site (static, no build step)
docs/data/items.json           generated data
docs/feed.xml                  generated RSS
state/seen.json                ids already processed (prevents re-summarizing)
netlify.toml                   tells Netlify to publish docs/
```
