// Fetches RSS/Atom feeds about Google Ads and Meta Ads, asks Claude to classify
// and summarize each new item in plain English, then writes:
//   docs/data/items.json  - the data the static site renders
//   docs/feed.xml         - an RSS feed you can subscribe to (Outlook, Slack, Feedly...)
//   state/seen.json       - ids already processed, so nothing is summarized twice
// Optionally posts new items to a Slack and/or Teams incoming webhook.
//
// Runs in GitHub Actions (see .github/workflows/update.yml). Node 20+.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const DATA_FILE = path.join(ROOT, "docs", "data", "items.json");
const FEED_FILE = path.join(ROOT, "docs", "feed.xml");
const SEEN_FILE = path.join(ROOT, "state", "seen.json");
const SOURCES = JSON.parse(await fs.readFile(path.join(here, "sources.json"), "utf8"));

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-opus-5";
const MAX_AGE_DAYS = toInt(process.env.MAX_ITEM_AGE_DAYS, 30); // ignore feed items older than this
const MAX_NEW_PER_RUN = toInt(process.env.MAX_NEW_PER_RUN, 40); // cost guard
const MAX_ITEMS_KEPT = 600;
const CONCURRENCY = 4;
const FEED_TIMEOUT_MS = 20000; // hard per-feed deadline, including reading the body
const ARTICLE_TIMEOUT_MS = 20000;
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const DRY_RUN = process.env.DRY_RUN === "1"; // fetch + filter only, no API calls, no writes
const HAS_API_KEY = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
// Without an API key the tracker still works: items are classified with simple keyword rules and shown with the
// source's own excerpt instead of an AI summary. Add the ANTHROPIC_API_KEY secret to switch summaries on.
const USER_AGENT = "ads-updates-tracker/1.0 (+https://github.com)";

// Items from "keywords"-filtered sources must match this before we spend an API call.
const KEYWORDS =
  /\b(google ads|adwords|performance max|pmax|demand gen|smart bidding|search ads|shopping ads|merchant center|youtube ads|display ads|discovery ads|google ads api|ads editor|ads liaison|google marketing platform|display\s?&\s?video 360|dv360|search ads 360|campaign manager 360|meta ads|facebook ads|instagram ads|whatsapp ads|threads ads|messenger ads|reels ads|ads manager|advantage\+|advantage plus|marketing api|conversions api|capi|meta business suite|business manager|meta pixel|lead ads|catalog ads|dynamic ads|ad(s)? (policy|policies|format|placement|auction|attribution)|paid (search|social|media)|ppc|advertis\w*|ad campaign|ad spend|cpc|cpm|roas)(?![a-z0-9])/i;

function toInt(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// What we ask Claude for, per item
// ---------------------------------------------------------------------------

const Analysis = z.object({
  relevant: z
    .boolean()
    .describe("true only if the item is about a Google Ads or Meta Ads product/feature/policy/API change or announcement"),
  platform: z.enum(["Google Ads", "Meta Ads", "Both", "Other"]),
  category: z.enum([
    "New feature",
    "Feature update",
    "Rename or rebrand",
    "Deprecation or removal",
    "Policy or compliance",
    "API or developer",
    "Reporting or measurement",
    "Other",
  ]),
  impact: z.enum(["High", "Medium", "Low"]).describe("How much a typical performance marketer needs to care"),
  headline: z.string().describe("Plain-English headline, max 12 words, no clickbait"),
  summary: z.string().describe("2-3 short sentences a busy marketer can read in 15 seconds"),
  what_changed: z.string().describe("One or two sentences: the concrete before/after. Include old and new names for renames."),
  why_it_matters: z.string().describe("One or two sentences on the practical effect on campaigns, budgets, reporting or workflow"),
  action: z.string().describe("One sentence: what an advertiser should do, or 'No action needed.'"),
  products: z.array(z.string()).describe("Specific products or features named, e.g. 'Performance Max', 'Advantage+ Shopping'"),
  effective_date: z.string().describe("Rollout or enforcement date if stated, else empty string"),
  duplicate_of_recent: z
    .boolean()
    .describe("true if this covers the same announcement as one of the recent headlines provided"),
});

const SYSTEM_PROMPT = `You are an analyst who tracks Google Ads and Meta Ads product changes for a marketing team.
You receive one news item (title, source, date, body text). Classify it and rewrite it in plain, jargon-free English.

Relevant means the item concerns advertising products, features, names, policies, APIs, reporting or pricing on:
- Google Ads (including Performance Max, Demand Gen, Search, Shopping and Merchant Center, YouTube ads, Display, Smart Bidding, Google Ads Editor, Google Ads API, and paid-media features of Google Marketing Platform such as DV360 or SA360)
- Meta Ads (Facebook, Instagram, WhatsApp, Threads and Messenger advertising, Ads Manager, Advantage+, Meta Marketing API, Conversions API, Meta Pixel, Meta Business Suite ads features)

Not relevant: company earnings, executive news, organic/SEO changes, consumer app features with no advertising angle,
developer tools unrelated to ads, opinion pieces or tutorials that do not describe a concrete change, and other ad platforms
(Microsoft, TikTok, Amazon, LinkedIn) unless the item is also about Google Ads or Meta Ads.

Writing rules: explain acronyms the first time, name the feature exactly as the platform does, prefer concrete facts (dates,
limits, what replaces what) over marketing language, and never invent details that are not in the text. If the body text is
thin, say what is known and keep it short.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function normalizeUrl(raw = "") {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

function idFor(link, title) {
  return createHash("sha1").update(normalizeUrl(link) || title).digest("hex").slice(0, 16);
}

function escapeXml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// A hard deadline that covers connecting, headers AND reading the body. `fetch` alone will
// happily hang on a server that trickles bytes, so the abort signal is what actually saves us.
async function fetchWithTimeout(url, ms = 20000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*", ...extraHeaders },
    });
    // Read the body while the same deadline is still armed.
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: () => text };
  } finally {
    clearTimeout(t);
  }
}

// If a feed only gives a teaser, pull the article body so the summary has something to work with.
async function fetchArticleText(url) {
  try {
    const res = await fetchWithTimeout(url, ARTICLE_TIMEOUT_MS);
    if (!res.ok) return "";
    const html = await res.text();
    const main =
      html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
      html.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
      html.match(/<body[\s\S]*?<\/body>/i)?.[0] ||
      html;
    return stripHtml(main);
  } catch {
    return "";
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Step 1: fetch feeds and pick candidates
// ---------------------------------------------------------------------------

async function fetchCandidates(seenIds) {
  // We download the feed ourselves with a hard AbortController deadline rather than letting
  // rss-parser do it: a server that accepts the connection and then trickles bytes can hang
  // the parser's own timeout indefinitely, which stalls the whole job.
  const parser = new Parser({
    customFields: { item: [["content:encoded", "contentEncoded"], "summary", "description"] },
  });

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
  const candidates = [];
  const report = [];

  const fetched = await mapWithConcurrency(SOURCES, 5, async (source) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetchWithTimeout(source.url, FEED_TIMEOUT_MS, {
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Strip a BOM or leading whitespace; either makes the XML parser reject the document.
        const xml = (await res.text()).replace(/^﻿/, "").trimStart();
        return { source, feed: await parser.parseString(xml), error: null };
      } catch (err) {
        if (attempt === 2) return { source, feed: null, error: err.message };
      }
    }
  });

  for (const { source, feed, error } of fetched.filter(Boolean)) {
    if (!feed) {
      report.push(`  ${source.name}: FAILED (${error})`);
      continue;
    }
    let kept = 0;
    for (const entry of feed.items ?? []) {
      const link = entry.link || entry.guid || "";
      const title = (entry.title || "").trim();
      if (!link || !title) continue;

      const publishedMs = Date.parse(entry.isoDate || entry.pubDate || entry.published || entry.updated || "");
      if (!Number.isFinite(publishedMs) || publishedMs < cutoff) continue;

      const id = idFor(link, title);
      if (seenIds.has(id)) continue;

      const rawBody = entry.contentEncoded || entry.content || entry.summary || entry.description || entry.contentSnippet || "";
      const body = stripHtml(rawBody);

      if (source.filter === "keywords" && !KEYWORDS.test(`${title}\n${body.slice(0, 3000)}`)) continue;

      candidates.push({
        id,
        title,
        link: link.trim(),
        published: new Date(publishedMs).toISOString(),
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        sourcePlatformHint: source.platform,
        body,
      });
      kept++;
    }
    report.push(`  ${source.name}: ${feed.items?.length ?? 0} in feed, ${kept} new candidates`);
  }

  console.log("Feeds:\n" + report.join("\n"));

  // Same article syndicated under two URLs -> keep one.
  const byId = new Map();
  for (const c of candidates) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}

// ---------------------------------------------------------------------------
// Step 2: ask Claude about each candidate
// ---------------------------------------------------------------------------

async function analyze(client, candidate, recentHeadlines) {
  let body = candidate.body;
  if (body.length < 400) {
    const full = await fetchArticleText(candidate.link);
    if (full.length > body.length) body = full;
  }
  body = body.slice(0, 12000);

  const userText = [
    `Source: ${candidate.sourceName} (${candidate.sourceType === "official" ? "official platform source" : "trade press"})`,
    candidate.sourcePlatformHint ? `Source usually covers: ${candidate.sourcePlatformHint}` : null,
    `Published: ${candidate.published.slice(0, 10)}`,
    `Title: ${candidate.title}`,
    `URL: ${candidate.link}`,
    "",
    "Body text:",
    body || "(no body text available; judge from the title only)",
    "",
    "Recent headlines already on the tracker (for the duplicate check):",
    recentHeadlines.length ? recentHeadlines.map((h) => `- ${h}`).join("\n") : "- (none yet)",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "low", format: zodOutputFormat(Analysis) },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Model declined (${response.stop_details?.category ?? "unknown category"})`);
  }
  if (!response.parsed_output) {
    throw new Error(`Could not parse model output (stop_reason=${response.stop_reason})`);
  }
  return response.parsed_output;
}

// Fallback used when no API key is configured: keyword rules + the feed's own excerpt.
function analyzeHeuristic(candidate) {
  const text = `${candidate.title}\n${candidate.body.slice(0, 4000)}`;
  const mentionsGoogle =
    /\b(google|adwords|performance max|pmax|demand gen|youtube|merchant center|dv360|display\s?&\s?video 360|search ads 360|smart bidding)\b/i.test(text);
  const mentionsMeta =
    /\b(meta|facebook|instagram|whatsapp|threads|messenger|advantage\+|ads manager|marketing api|conversions api|meta pixel)\b/i.test(text);
  const platform =
    mentionsGoogle && mentionsMeta ? "Both" : mentionsGoogle ? "Google Ads" : mentionsMeta ? "Meta Ads" : candidate.sourcePlatformHint || "Other";

  const t = candidate.title.toLowerCase();
  const category = /deprecat|sunset|remov|retir|shut(ting)? down|end of life|discontinu/.test(t)
    ? "Deprecation or removal"
    : /renam|rebrand|now called|becomes|new name/.test(t)
      ? "Rename or rebrand"
      : /polic|complian|privacy|restrict|\bban\b|enforc/.test(t)
        ? "Policy or compliance"
        : /\bapi\b|\bsdk\b|developer|\bv\d+(\.\d+)?\b/.test(t)
          ? "API or developer"
          : /report|measur|attribution|analytics|insight|conversion/.test(t)
            ? "Reporting or measurement"
            : /introduc|launch|\bnew\b|announc|now available|roll(s|ing)? out|expand|adds?\b/.test(t)
              ? "New feature"
              : "Feature update";

  const excerpt = candidate.body.replace(/\s+/g, " ").trim();
  const summary = excerpt
    ? excerpt.slice(0, 320) + (excerpt.length > 320 ? "…" : "")
    : "No excerpt available in the feed. Open the source for details.";

  return {
    relevant: platform !== "Other",
    platform,
    category,
    impact: candidate.sourceType === "official" ? "Medium" : "Low",
    headline: candidate.title,
    summary,
    what_changed: "",
    why_it_matters: "",
    action: "",
    products: [],
    effective_date: "",
    duplicate_of_recent: false,
  };
}

// ---------------------------------------------------------------------------
// Step 3: outputs
// ---------------------------------------------------------------------------

function buildFeedXml(items) {
  const now = new Date().toUTCString();
  const entries = items
    .slice(0, 50)
    .map((it) => {
      const desc = [
        `<p><strong>${escapeXml(it.platform)}</strong> · ${escapeXml(it.category)} · Impact: ${escapeXml(it.impact)}</p>`,
        `<p>${escapeXml(it.summary)}</p>`,
        it.whatChanged ? `<p><strong>What changed:</strong> ${escapeXml(it.whatChanged)}</p>` : "",
        it.whyItMatters ? `<p><strong>Why it matters:</strong> ${escapeXml(it.whyItMatters)}</p>` : "",
        it.action ? `<p><strong>What to do:</strong> ${escapeXml(it.action)}</p>` : "",
        `<p>Source: <a href="${escapeXml(it.link)}">${escapeXml(it.sourceName)}</a></p>`,
      ].join("");
      return `    <item>
      <title>${escapeXml(`[${it.platform}] ${it.headline}`)}</title>
      <link>${escapeXml(it.link)}</link>
      <guid isPermaLink="false">${it.id}</guid>
      <pubDate>${new Date(it.published).toUTCString()}</pubDate>
      <category>${escapeXml(it.category)}</category>
      <description><![CDATA[${desc}]]></description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Google Ads &amp; Meta Ads updates</title>
    <link>${escapeXml(SITE_URL || "https://github.com")}</link>
    <description>Plain-English summaries of new features, renames, deprecations and policy changes on Google Ads and Meta Ads.</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
${SITE_URL ? `    <atom:link href="${escapeXml(SITE_URL)}/feed.xml" rel="self" type="application/rss+xml" />\n` : ""}${entries}
  </channel>
</rss>
`;
}

async function postWebhooks(newItems) {
  if (!newItems.length) return;
  const top = newItems.slice(0, 15);
  const siteLine = SITE_URL ? `\nFull tracker: ${SITE_URL}` : "";

  if (process.env.SLACK_WEBHOOK_URL) {
    const lines = top.map(
      (it) => `• *[${it.platform}] <${it.link}|${it.headline}>* (${it.category}, ${it.impact} impact)\n   ${it.summary}`,
    );
    const text = `*${newItems.length} new Google Ads / Meta Ads update${newItems.length === 1 ? "" : "s"}*\n${lines.join("\n")}${siteLine}`;
    try {
      const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      console.log(`Slack webhook: ${res.status}`);
    } catch (err) {
      console.warn(`Slack webhook failed: ${err.message}`);
    }
  }

  if (process.env.TEAMS_WEBHOOK_URL) {
    const bodyBlocks = [
      { type: "TextBlock", size: "Large", weight: "Bolder", text: `${newItems.length} new Google Ads / Meta Ads updates` },
      ...top.flatMap((it) => [
        { type: "TextBlock", weight: "Bolder", wrap: true, text: `[${it.platform}] [${it.headline}](${it.link})` },
        { type: "TextBlock", wrap: true, isSubtle: true, text: `${it.category} · ${it.impact} impact · ${it.sourceName}` },
        { type: "TextBlock", wrap: true, text: it.summary },
      ]),
      ...(SITE_URL ? [{ type: "TextBlock", wrap: true, text: `[Open the tracker](${SITE_URL})` }] : []),
    ];
    const card = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: bodyBlocks },
        },
      ],
    };
    try {
      const res = await fetch(process.env.TEAMS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card),
      });
      console.log(`Teams webhook: ${res.status}`);
    } catch (err) {
      console.warn(`Teams webhook failed: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const data = await readJson(DATA_FILE, { updatedAt: null, items: [] });
  const seen = await readJson(SEEN_FILE, { ids: {} });
  const seenIds = new Set([...Object.keys(seen.ids), ...data.items.map((it) => it.id)]);

  const candidates = await fetchCandidates(seenIds);
  console.log(`\n${candidates.length} new candidate(s) after filtering.`);

  if (DRY_RUN) {
    for (const c of candidates) console.log(`  [${c.sourceName}] ${c.published.slice(0, 10)}  ${c.title}`);
    console.log("\nDRY_RUN=1: no API calls, nothing written.");
    return;
  }

  if (!candidates.length) {
    console.log("Nothing to do.");
    return;
  }
  if (!HAS_API_KEY) {
    console.log("ANTHROPIC_API_KEY is not set: using keyword rules and feed excerpts instead of AI summaries.");
  }

  const batch = HAS_API_KEY ? candidates.slice(0, MAX_NEW_PER_RUN) : candidates;
  if (candidates.length > batch.length) {
    console.log(`Processing the newest ${batch.length}; the rest will be picked up on the next run.`);
  }

  const client = HAS_API_KEY ? new Anthropic() : null;
  const recentHeadlines = data.items.slice(0, 40).map((it) => it.headline);
  const nowIso = new Date().toISOString();
  const accepted = [];
  let dropped = 0;
  let failed = 0;

  await mapWithConcurrency(batch, CONCURRENCY, async (candidate) => {
    try {
      const a = client ? await analyze(client, candidate, recentHeadlines) : analyzeHeuristic(candidate);
      seen.ids[candidate.id] = nowIso;
      if (!a.relevant || a.platform === "Other") {
        dropped++;
        console.log(`  skip   ${candidate.title}`);
        return;
      }
      accepted.push({
        id: candidate.id,
        title: candidate.title,
        link: candidate.link,
        published: candidate.published,
        fetchedAt: nowIso,
        sourceId: candidate.sourceId,
        sourceName: candidate.sourceName,
        sourceType: candidate.sourceType,
        platform: a.platform,
        category: a.category,
        impact: a.impact,
        headline: a.headline,
        summary: a.summary,
        whatChanged: a.what_changed,
        whyItMatters: a.why_it_matters,
        action: a.action,
        products: a.products,
        effectiveDate: a.effective_date,
        followUp: a.duplicate_of_recent,
        aiSummary: Boolean(client),
      });
      console.log(`  keep   [${a.platform} · ${a.category}] ${a.headline}`);
    } catch (err) {
      failed++;
      if (err instanceof Anthropic.AuthenticationError) throw err; // no point continuing
      if (err instanceof Anthropic.RateLimitError) console.warn(`  retry-later (rate limited) ${candidate.title}`);
      else if (err instanceof Anthropic.APIError) console.warn(`  error ${err.status} ${candidate.title}: ${err.message}`);
      else console.warn(`  error ${candidate.title}: ${err.message}`);
    }
  });

  // Merge, newest first, cap size.
  const merged = [...accepted, ...data.items]
    .sort((x, y) => Date.parse(y.published) - Date.parse(x.published))
    .slice(0, MAX_ITEMS_KEPT);

  // Forget seen-ids older than 120 days so the state file stays small.
  const pruneBefore = Date.now() - 120 * 86400_000;
  for (const [id, when] of Object.entries(seen.ids)) {
    if (Date.parse(when) < pruneBefore) delete seen.ids[id];
  }

  await writeJson(DATA_FILE, { updatedAt: nowIso, model: HAS_API_KEY ? MODEL : null, count: merged.length, items: merged });
  await writeJson(SEEN_FILE, seen);
  await fs.writeFile(FEED_FILE, buildFeedXml(merged), "utf8");

  console.log(`\nDone: ${accepted.length} added, ${dropped} not relevant, ${failed} failed. ${merged.length} items on the site.`);

  await postWebhooks(accepted.filter((it) => !it.followUp).sort((x, y) => Date.parse(y.published) - Date.parse(x.published)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
