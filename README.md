# TRESPASS

**Which bots came in — and which ones you told to stay out.**

Drop your access log. TRESPASS lines up every bot that visited, checks the ones that publish their
addresses *against* those addresses — so a fake GPTBot shows up as a fake — and checks every request
against your robots.txt. You get the exact log lines, the bandwidth, and block rules for exactly the
bots in your log.

**Your log never leaves the browser.** There is no server: parsing runs in a Web Worker in your tab,
gzipped logs included.

**Live:** (deploying)

---

## Why

“I posted to HN, and then my website was flooded with AI bot traffic” made the front page on 13 Oct
2026 with 156 comments: a cloud egress bill because AI bots killed the cache hit rate, Meta’s
crawler ignoring robots.txt until it was effectively DoSing a wiki, “stealth” bots spotted only by
their request pattern — and people pasting their logs into an AI to find out who was who. This does
that job, deterministically, without your logs going anywhere.

## What it finds

- **The lineup** — every known bot as a silhouette against a height chart; height is requests on a
  log scale. A red placard means a crawler’s name used from outside its operator’s published
  addresses. A stamp means it went where your robots.txt says not to.
- **Is it really that bot?** OpenAI (GPTBot, OAI-SearchBot, ChatGPT-User), Google, Microsoft (Bing),
  Perplexity, Apple, Common Crawl and DuckDuckGo publish their crawler addresses — 2,503 prefixes,
  IPv4 and IPv6. A claim from outside them is an impostor. Anthropic, Meta, ByteDance and most
  others publish no list, so their requests are **unverifiable** — not cleared, not accused.
- **Did it stay out?** RFC 9309 matching: the group naming the crawler applies, otherwise `*`; the
  longest rule wins; ties go to Allow; `*` and `$` wildcards. Violations are split by who did them,
  so an impostor’s trespass is never pinned on the real crawler.
- **Dressed as a browser** — Chrome-looking traffic that fetches page after page but no images,
  scripts or styles and no referrers, grouped by /24 (IPv4) or /48 (IPv6) because scrapers rotate.
- **Trying the doors** — WordPress logins, `.env`, `.git/config` and the rest of the background noise.
- **Your robots.txt itself** — a group naming a bot *replaces* the `*` group rather than adding to it,
  the commonest robots.txt surprise. TRESPASS says which paths each named group no longer protects.
- **Lock the doors** — robots.txt additions for bots that honour it; nginx, Cloudflare WAF and
  .htaccess rules for the ones that don’t; and IP denies for impostors, because blocking a name would
  also shut out the real crawler.

## Formats

nginx / Apache combined and common log format (with or without a leading vhost), and JSON lines
from Cloudflare Logpush, Caddy and Vercel log drains. `.gz` is decompressed in the browser.

## Honest limits

- A User-Agent is a claim. Unverifiable bots may be impostors too; there is no way to tell from a log.
- Violations are judged against the robots.txt you paste today; if it changed during the log,
  some requests may have been allowed at the time.
- User-triggered fetchers (ChatGPT-User, Perplexity-User, Claude-User) fetch because a person asked;
  their operators treat robots.txt as a crawler rule. The page says so beside any such violations.
- The browser-shaped crawler test is a heuristic: it needs at least two signals (no assets, no
  referrers, near-unique paths, 30+ requests a minute) before it names anyone.

## Build

```bash
npm install
npm run data    # agent list + published IP ranges → src/data.json
npm test        # 112 assertions: UAs as operators document them, real browsers never matched,
                # every published range, RFC 9309 cases, five log formats, the sample day end to end
npm run build   # → dist/
```

The sample day on the page is made up: real crawlers use addresses from their operators’ published
ranges (so they verify); everyone else uses the RFC 5737 documentation blocks, so no real address is
implicated in anything.

Agent list: [ai-robots-txt/ai.robots.txt](https://github.com/ai-robots-txt/ai.robots.txt) (MIT).
Address lists from each operator’s own published JSON. Code: MIT.
