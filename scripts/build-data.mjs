/**
 * Builds src/data.json from two kinds of public source.
 *
 *   Who a bot is    ai-robots-txt/ai.robots.txt (MIT): 180+ AI agents with
 *                   operator, purpose and whether they say they respect
 *                   robots.txt. Plus a short list here of search engines,
 *                   link previewers, SEO crawlers, monitors and HTTP
 *                   libraries, which that list does not cover.
 *   Whether it is   The IP ranges operators publish for their own crawlers.
 *   really that bot A request claiming to be GPTBot from outside OpenAI's
 *                   published ranges did not come from OpenAI's GPTBot.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".cache");
fs.mkdirSync(path.join(cache, "ranges"), { recursive: true });

const RANGES = {
  "openai-gptbot": "https://openai.com/gptbot.json",
  "openai-searchbot": "https://openai.com/searchbot.json",
  "openai-chatgpt-user": "https://openai.com/chatgpt-user.json",
  "google-googlebot": "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
  "google-special": "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json",
  "google-user": "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json",
  "bing-bingbot": "https://www.bing.com/toolbox/bingbot.json",
  "perplexity-bot": "https://www.perplexity.ai/perplexitybot.json",
  "perplexity-user": "https://www.perplexity.ai/perplexity-user.json",
  "apple-applebot": "https://search.developer.apple.com/applebot.json",
  "commoncrawl-ccbot": "https://index.commoncrawl.org/ccbot.json",
  "duckduckgo-bot": "https://duckduckgo.com/duckduckbot.json",
};

async function cached(file, url) {
  if (!fs.existsSync(file)) {
    const r = await fetch(url, { headers: { "user-agent": "TRESPASS data build (https://github.com/nickzsche21/trespass)" } });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    fs.writeFileSync(file, await r.text());
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const ranges = {};
for (const [id, url] of Object.entries(RANGES)) {
  const d = await cached(path.join(cache, "ranges", `${id}.json`), url);
  ranges[id] = {
    url,
    created: d.creationTime ?? null,
    prefixes: (d.prefixes ?? []).map((p) => p.ipv4Prefix ?? p.ipv6Prefix).filter(Boolean),
  };
}

// Which published list proves which agent.
const VERIFY = {
  GPTBot: ["openai-gptbot"], "OAI-SearchBot": ["openai-searchbot"], "ChatGPT-User": ["openai-chatgpt-user"],
  Googlebot: ["google-googlebot", "google-special", "google-user"], GoogleOther: ["google-special", "google-googlebot"],
  "Google-CloudVertexBot": ["google-special"], "Google-InspectionTool": ["google-googlebot", "google-special"],
  bingbot: ["bing-bingbot"], PerplexityBot: ["perplexity-bot"], "Perplexity-User": ["perplexity-user"],
  Applebot: ["apple-applebot"], CCBot: ["commoncrawl-ccbot"], DuckDuckBot: ["duckduckgo-bot"], DuckAssistBot: ["duckduckgo-bot"],
};

const clean = (s) => String(s ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
const respectOf = (s) => { const t = clean(s).toLowerCase(); return t.startsWith("yes") ? "yes" : t.startsWith("no") ? "no" : "unclear"; };

/**
 * What an AI agent is for. The list's "function" field is mostly a category —
 * "AI Assistants", "AI Search Crawlers", "AI Data Scrapers" — so that decides;
 * free-text descriptions only break ties, because nearly all of them mention
 * "AI agents" somewhere.
 */
function kindOf(token, fn, desc) {
  const f = fn.toLowerCase(), t = token.toLowerCase();
  if (/-user$|user$/.test(t) || /\bassistants?\b|\bagents?\b|on behalf of|user[- ]initiated/.test(f)) return "assistant";
  if (/search|answer|retriev/.test(f)) return "ai-search";
  if (/train|llm|data|scrap|dataset|model/.test(f)) return "training";
  const d = desc.toLowerCase();
  if (/on behalf of|when a user|user request/.test(d)) return "assistant";
  if (/search/.test(d)) return "ai-search";
  return "training";
}
/* Where the list's category does not match what the agent does on a site. */
const OVERRIDE = { facebookexternalhit: "preview", Scrapy: "library", Applebot: "search", GoogleOther: "search", "GoogleOther-Image": "search", "GoogleOther-Video": "search" };

const robots = JSON.parse(fs.readFileSync(path.join(cache, "robots.json"), "utf8"));
const agents = [];
for (const [token, v] of Object.entries(robots)) {
  // Robots-only control tokens never appear in a request; keep them for robots.txt advice.
  const controlOnly = /^(Google-Extended|Applebot-Extended|Webzio-Extended)$/i.test(token);
  agents.push({
    token, operator: clean(v.operator) || "unknown", kind: OVERRIDE[token] ?? kindOf(token, clean(v.function), clean(v.description)),
    respect: respectOf(v.respect), purpose: clean(v.function), controlOnly, ai: true, verify: VERIFY[token] ?? null,
  });
}

/* Non-AI crawlers and clients the AI list does not cover. Tokens are matched as substrings of the User-Agent. */
const EXTRA = [
  ["Googlebot", "Google", "search", "Google Search crawler."],
  ["GoogleOther", "Google", "search", "Google's generic crawler for research and one-off fetches."],
  ["Google-InspectionTool", "Google", "search", "Search Console's URL inspection."],
  ["AdsBot-Google", "Google", "search", "Checks ad landing pages."],
  ["Mediapartners-Google", "Google", "search", "AdSense."],
  ["bingbot", "Microsoft", "search", "Bing search crawler."],
  ["DuckDuckBot", "DuckDuckGo", "search", "DuckDuckGo search crawler."],
  ["YandexBot", "Yandex", "search", "Yandex search crawler."],
  ["Baiduspider", "Baidu", "search", "Baidu search crawler."],
  ["SeznamBot", "Seznam", "search", "Seznam search crawler."],
  ["Qwantbot", "Qwant", "search", "Qwant search crawler."],
  ["MojeekBot", "Mojeek", "search", "Mojeek search crawler."],
  ["Yeti", "Naver", "search", "Naver search crawler."],
  ["facebookexternalhit", "Meta", "preview", "Builds link previews when a URL is shared."],
  ["Twitterbot", "X", "preview", "Builds link previews."],
  ["LinkedInBot", "LinkedIn", "preview", "Builds link previews."],
  ["Slackbot", "Slack", "preview", "Builds link previews."],
  ["Discordbot", "Discord", "preview", "Builds link previews."],
  ["TelegramBot", "Telegram", "preview", "Builds link previews."],
  ["WhatsApp", "Meta", "preview", "Builds link previews."],
  ["redditbot", "Reddit", "preview", "Builds link previews."],
  ["AhrefsBot", "Ahrefs", "seo", "SEO backlink crawler."],
  ["SemrushBot", "Semrush", "seo", "SEO crawler."],
  ["MJ12bot", "Majestic", "seo", "SEO backlink crawler."],
  ["DotBot", "Moz", "seo", "SEO crawler."],
  ["BLEXBot", "WebMeUp", "seo", "SEO backlink crawler."],
  ["DataForSeoBot", "DataForSEO", "seo", "SEO data crawler."],
  ["serpstatbot", "Serpstat", "seo", "SEO crawler."],
  ["UptimeRobot", "UptimeRobot", "monitor", "Uptime checks."],
  ["Pingdom", "SolarWinds", "monitor", "Uptime checks."],
  ["StatusCake", "StatusCake", "monitor", "Uptime checks."],
  ["Better Uptime", "Better Stack", "monitor", "Uptime checks."],
  ["archive.org_bot", "Internet Archive", "archive", "Wayback Machine."],
  ["ia_archiver", "Internet Archive", "archive", "Wayback Machine (older agent)."],
  ["HeadlessChrome", "unknown", "automation", "Chrome without a window: a script driving a browser."],
  ["Lightpanda", "unknown", "automation", "A headless browser built for automation and AI agents."],
  ["PhantomJS", "unknown", "automation", "A headless browser."],
  ["python-requests", "unknown", "library", "Python's requests library."],
  ["python-httpx", "unknown", "library", "Python's httpx library."],
  ["aiohttp", "unknown", "library", "Python's aiohttp library."],
  ["Python-urllib", "unknown", "library", "Python's standard library."],
  ["Scrapy", "unknown", "library", "The Scrapy crawling framework."],
  ["curl/", "unknown", "library", "The curl command-line tool."],
  ["Wget", "unknown", "library", "The wget command-line tool."],
  ["Go-http-client", "unknown", "library", "Go's standard HTTP client."],
  ["axios", "unknown", "library", "The axios JavaScript library."],
  ["node-fetch", "unknown", "library", "The node-fetch library."],
  ["undici", "unknown", "library", "Node's built-in HTTP client."],
  ["okhttp", "unknown", "library", "The OkHttp Java/Kotlin library."],
  ["Java/", "unknown", "library", "Java's built-in HTTP client."],
  ["libwww-perl", "unknown", "library", "Perl's LWP library."],
  ["Ruby", "unknown", "library", "A Ruby HTTP client."],
];
const have = new Set(agents.map((a) => a.token.toLowerCase()));
for (const [token, operator, kind, purpose] of EXTRA) {
  if (have.has(token.toLowerCase())) continue;
  agents.push({ token, operator, kind, respect: kind === "library" || kind === "automation" ? "n/a" : "yes", purpose, controlOnly: false, ai: false, verify: VERIFY[token] ?? null });
}

const out = {
  built: new Date().toISOString().slice(0, 10),
  sources: {
    agents: { name: "ai-robots-txt/ai.robots.txt", license: "MIT", url: "https://github.com/ai-robots-txt/ai.robots.txt" },
  },
  agents,
  ranges,
};
fs.writeFileSync(path.join(root, "src/data.json"), JSON.stringify(out));
const prefixes = Object.values(ranges).reduce((n, r) => n + r.prefixes.length, 0);
console.log(`agents ${agents.length} (${agents.filter((a) => a.ai).length} AI), verifiable ${agents.filter((a) => a.verify).length}; ranges ${Object.keys(ranges).length} lists, ${prefixes} prefixes; ${(fs.statSync(path.join(root, "src/data.json")).size / 1024).toFixed(0)} KB`);
const kinds = {}; for (const a of agents) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1; console.log(kinds);
