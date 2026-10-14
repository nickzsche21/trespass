/**
 * A day of made-up traffic for a small blog, so the page has something to show
 * before you drop in your own log.
 *
 * Real crawlers use addresses from their operators' published ranges, so they
 * verify. Everything else — the people, the impostor, the scraper, the
 * probes — uses the documentation blocks reserved by RFC 5737 (192.0.2.0/24,
 * 198.51.100.0/24, 203.0.113.0/24), so no real address is implicated in
 * anything.
 */
import { addressIn } from "./core";

export const SAMPLE_ROBOTS = `# robots.txt for a small blog
User-agent: *
Disallow: /drafts/
Disallow: /search
Disallow: /admin/

User-agent: GPTBot
Disallow: /premium/

User-agent: Bytespider
User-agent: CCBot
Disallow: /
`;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const UA = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:143.0) Gecko/20100101 Firefox/143.0",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  chatgptUser: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  claudebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  bytespider: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
  meta: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  perplexity: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  ccbot: "CCBot/2.0 (https://commoncrawl.org/faq/)",
  python: "python-requests/2.32.3",
};

const POSTS = Array.from({ length: 180 }, (_, i) => `/posts/${["notes", "essay", "til", "guide", "review"][i % 5]}-${String(i + 1).padStart(3, "0")}`);
const ASSETS = ["/assets/site.css", "/assets/app.js", "/assets/fonts/inter.woff2", "/favicon.ico", "/images/cover.webp", "/images/avatar.png"];
const PRIVATE = ["/drafts/new-post", "/drafts/rough-notes", "/search?q=rust", "/search?q=postgres", "/admin/login"];
const PREMIUM = ["/premium/archive", "/premium/course-1", "/premium/course-2"];
const PROBES = ["/wp-login.php", "/.env", "/xmlrpc.php", "/phpinfo.php", "/.git/config", "/wp-admin/setup-config.php", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php"];

export function sampleLog(day = Date.UTC(2026, 9, 13)): string {
  const r = rng(2026);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const lines: { t: number; s: string }[] = [];
  const clf = (t: number) => {
    const d = new Date(t);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getUTCDate())}/${mon}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
  };
  const hit = (t: number, ip: string, path: string, ua: string, status = 200, bytes?: number, ref = "-") => {
    const b = bytes ?? (path.endsWith(".woff2") ? 48000 : path.includes("/images/") ? 180000 : path.endsWith(".js") ? 92000 : path.endsWith(".css") ? 21000 : path === "/robots.txt" ? 240 : 38000 + Math.floor(r() * 30000));
    lines.push({ t, s: `${ip} - - [${clf(t)}] "GET ${path} HTTP/1.1" ${status} ${b} "${ref}" "${ua}"` });
  };
  const at = (h: number) => day + Math.floor(h * 3600000);

  // People: a page and its assets, with referrers, through the day.
  for (let i = 0; i < 420; i++) {
    const t = at(r() * 24), ip = `198.51.100.${10 + Math.floor(r() * 200)}`, ua = pick([UA.chrome, UA.chrome, UA.safari, UA.firefox]);
    const page = r() < 0.2 ? "/" : pick(POSTS);
    hit(t, ip, page, ua, 200, undefined, pick(["https://news.ycombinator.com/", "https://www.google.com/", "-", "https://example.social/"]));
    for (const a of ASSETS) if (r() < 0.85) hit(t + 300 + Math.floor(r() * 900), ip, a, ua, 200, undefined, `https://blog.example${page}`);
  }

  // GPTBot from OpenAI's own range: reads robots.txt and stays out of /premium/.
  // Its group replaces "*", so /drafts/ and /search are open to it — see the robots.txt notes.
  const gpt = addressIn("openai-gptbot", 9);
  hit(at(1.1), gpt, "/robots.txt", UA.gptbot);
  for (let i = 0; i < 160; i++) hit(at(1.2 + i * 0.02), gpt, i % 40 === 7 ? PRIVATE[i % 2] : pick(POSTS), UA.gptbot);

  // Someone else wearing GPTBot's name.
  for (let i = 0; i < 90; i++) hit(at(3 + i * 0.01), "192.0.2.66", pick([...PREMIUM, ...PRIVATE, ...POSTS]), UA.gptbot);

  // ChatGPT fetching a page because a user asked about it.
  hit(at(14.2), addressIn("openai-chatgpt-user", 3), "/premium/course-1", UA.chatgptUser);
  hit(at(16.9), addressIn("openai-chatgpt-user", 4), "/posts/guide-004", UA.chatgptUser);

  // ClaudeBot: Anthropic publishes no ranges, so it can't be verified either way. Well behaved here.
  hit(at(5.0), "192.0.2.40", "/robots.txt", UA.claudebot);
  for (let i = 0; i < 120; i++) hit(at(5.1 + i * 0.03), "192.0.2.40", pick(POSTS), UA.claudebot);

  // Bytespider: told to stay out of everything, comes in anyway, never reads robots.txt.
  for (let i = 0; i < 1400; i++) hit(at(r() * 24), `192.0.2.${100 + Math.floor(r() * 20)}`, pick([...POSTS, ...PRIVATE, ...PREMIUM, ...POSTS]), UA.bytespider);

  // Meta's crawler: a lot of pages, in bursts.
  hit(at(8), "192.0.2.150", "/robots.txt", UA.meta);
  for (let i = 0; i < 900; i++) hit(at(8 + (i % 300) * 0.005 + Math.floor(i / 300) * 5), `192.0.2.${150 + (i % 4)}`, i % 25 === 3 ? pick(PRIVATE) : pick(POSTS), UA.meta);

  // Googlebot and PerplexityBot from their published ranges.
  const gb = addressIn("google-googlebot", 21);
  hit(at(2), gb, "/robots.txt", UA.googlebot);
  for (let i = 0; i < 70; i++) hit(at(2 + i * 0.25), gb, pick(POSTS), UA.googlebot);
  const px = addressIn("perplexity-bot", 5);
  hit(at(11), px, "/robots.txt", UA.perplexity);
  for (let i = 0; i < 25; i++) hit(at(11 + i * 0.1), px, pick(POSTS), UA.perplexity);

  // CCBot honours the Disallow: / for it: it reads robots.txt and leaves.
  hit(at(20), addressIn("commoncrawl-ccbot", 2), "/robots.txt", UA.ccbot);

  // A scraper dressed as Chrome: every page, no assets, no referrer, fast.
  for (let i = 0; i < 700; i++) hit(at(9 + i * 0.0012), `203.0.113.${77 + (i % 3)}`, POSTS[i % POSTS.length] + (i >= POSTS.length ? `?page=${Math.floor(i / POSTS.length)}` : ""), UA.chrome);

  // Scripts, and the usual vulnerability probes.
  for (let i = 0; i < 40; i++) hit(at(r() * 24), "203.0.113.200", pick(POSTS), UA.python);
  for (let i = 0; i < 160; i++) hit(at(r() * 24), `203.0.113.${210 + Math.floor(r() * 40)}`, pick(PROBES), pick([UA.chrome, "Mozilla/5.0", "-"]), 404, 162);

  return lines.sort((a, b) => a.t - b.t).map((l) => l.s).join("\n") + "\n";
}
