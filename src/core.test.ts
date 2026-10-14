import {
  ownViolations, agentOf, parseIp, inNets, identity, addressIn, parseRobots, allowed, rulesFor, lintRobots, parseLine, judge,
  analyse, robotsAddition, nginxBlock, cloudflareRule, htaccess, AGENTS, RANGES,
} from "./core";
import { sampleLog, SAMPLE_ROBOTS } from "./sample";

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean) => { if (c) pass++; else fails.push(n); };
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const eq = (n: string, a: unknown, b: unknown) => ok(`${n} (got ${J(a)}, want ${J(b)})`, J(a) === J(b));

/* ── user agents, as the operators document them ────────────────────────── */
const UAS: [string, string][] = [
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ChatGPT-User"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "OAI-SearchBot"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot"],
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot"],
  ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "bingbot"],
  ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "meta-externalagent"],
  ["Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)", "Bytespider"],
  ["Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)", "Amazonbot"],
  ["CCBot/2.0 (https://commoncrawl.org/faq/)", "CCBot"],
  ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "facebookexternalhit"],
  ["curl/8.7.1", "curl/"],
  ["python-requests/2.32.3", "python-requests"],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36", "HeadlessChrome"],
];
for (const [ua, want] of UAS) eq(`UA → ${want}`, agentOf(ua)?.token, want);
for (const ua of [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:143.0) Gecko/20100101 Firefox/143.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
]) ok(`a real browser is not a bot (${ua.slice(13, 60)}… → ${agentOf(ua)?.token})`, agentOf(ua) === null);
ok("Amazonbot is not mistaken for “nbot”", agentOf("Mozilla/5.0 (compatible; Amazonbot/0.1)")?.token === "Amazonbot");
ok("robots-only tokens never match a request", AGENTS.filter((a) => a.controlOnly).every((a) => agentOf(`Mozilla/5.0 (compatible; ${a.token}/1.0)`)?.token !== a.token));
ok("an empty or dash UA is nobody", agentOf("") === null && agentOf("-") === null);

/* ── IP addresses and published ranges ──────────────────────────────────── */
eq("IPv4", parseIp("192.0.2.1")?.n, 3221225985n);
eq("IPv6 with ::", parseIp("2001:db8::1")?.n, (0x20010db8n << 96n) + 1n);
eq("IPv4-mapped IPv6 is IPv4", parseIp("::ffff:192.0.2.1")?.v6, false);
ok("garbage is not an address", parseIp("999.1.1.1") === null && parseIp("hello") === null && parseIp("1:2:3") === null);
for (const list of Object.keys(RANGES)) {
  ok(`${list}: published ranges loaded (${RANGES[list].prefixes.length})`, RANGES[list].prefixes.length > 0);
  if (RANGES[list].prefixes.some((p) => !p.includes(":"))) ok(`${list}: an address in its own range verifies`, inNets(addressIn(list), [list]));
}
const gpt = AGENTS.find((a) => a.token === "GPTBot")!, claude = AGENTS.find((a) => a.token === "ClaudeBot")!;
eq("GPTBot from OpenAI's range is verified", identity(gpt, addressIn("openai-gptbot")), "verified");
eq("GPTBot from a documentation address is an impostor", identity(gpt, "192.0.2.66"), "impostor");
eq("ClaudeBot cannot be checked: no published ranges", identity(claude, "192.0.2.40"), "unverifiable");
const g6 = RANGES["google-googlebot"].prefixes.find((p) => p.includes(":"))!;
ok(`Googlebot over IPv6 verifies (${g6})`, inNets(g6.split("/")[0].replace(/::$/, "::1"), ["google-googlebot"]));

/* ── robots.txt, by RFC 9309 ────────────────────────────────────────────── */
{
  const r = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nDisallow: /tmp*\n\nUser-agent: FooBot\nDisallow: /foo\n");
  ok("unlisted bots get the * group", !allowed(r, "BarBot", "/private/x").ok);
  ok("longest match wins: Allow /private/public beats Disallow /private", allowed(r, "BarBot", "/private/public/y").ok);
  ok("$ anchors the end", !allowed(r, "BarBot", "/a/b.pdf").ok && allowed(r, "BarBot", "/a/b.pdf?x=1").ok);
  ok("* matches anything", !allowed(r, "BarBot", "/tmpfiles").ok);
  ok("a named group replaces * entirely", allowed(r, "FooBot", "/private/x").ok && !allowed(r, "FooBot", "/foo/bar").ok);
  ok("matching is case-insensitive on the agent", !allowed(r, "foobot", "/foo").ok);
  ok("robots.txt itself is always fetchable", allowed(r, "BarBot", "/robots.txt").ok);
  const tie = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page\n");
  ok("on an equal-length tie, Allow wins", allowed(tie, "X", "/page").ok);
  ok("an empty Disallow allows everything", allowed(parseRobots("User-agent: *\nDisallow:\n"), "X", "/anything").ok);
  const multi = parseRobots("User-agent: A\nUser-agent: B\nDisallow: /\n");
  ok("one group can name several agents", !allowed(multi, "A", "/x").ok && !allowed(multi, "B", "/x").ok && allowed(multi, "C", "/x").ok);
  eq("rulesFor reports whether a named group applied", rulesFor(r, "FooBot").named, true);
  const lint = lintRobots(parseRobots(SAMPLE_ROBOTS));
  ok(`lint: the GPTBot group escapes /drafts/ and /search (${lint[0]})`, lint.length >= 1 && /GPTBot/.test(lint[0]) && /\/drafts\//.test(lint[0]) && /\/search/.test(lint[0]));
  ok("lint: a group that already blocks everything escapes nothing", !lint.some((l) => /Bytespider/.test(l)));
}

/* ── log formats ────────────────────────────────────────────────────────── */
{
  const c = parseLine(`203.0.113.9 - - [13/Oct/2026:09:15:02 +0000] "GET /posts/a?x=1 HTTP/1.1" 200 5123 "https://news.ycombinator.com/" "Mozilla/5.0 (compatible; GPTBot/1.2)"`)!;
  eq("combined: format", c.format, "combined");
  eq("combined: fields", [c.hit.ip, c.hit.method, c.hit.path, c.hit.status, c.hit.bytes, c.hit.ref], ["203.0.113.9", "GET", "/posts/a?x=1", 200, 5123, "https://news.ycombinator.com/"]);
  eq("combined: time in UTC", new Date(c.hit.t!).toISOString(), "2026-10-13T09:15:02.000Z");
  eq("a timezone offset is applied", new Date(parseLine(`1.2.3.4 - - [13/Oct/2026:14:45:02 +0530] "GET / HTTP/1.1" 200 1 "-" "x"`)!.hit.t!).toISOString(), "2026-10-13T09:15:02.000Z");
  eq("common log format (no UA)", parseLine(`198.51.100.4 - frank [10/Oct/2026:13:55:36 -0700] "GET /a.gif HTTP/1.0" 200 2326`)!.format, "common");
  eq("a leading virtual host", parseLine(`blog.example:443 198.51.100.4 - - [10/Oct/2026:13:55:36 +0000] "GET / HTTP/2.0" 200 9 "-" "curl/8.0"`)!.hit.ip, "198.51.100.4");
  eq("IPv6 client", parseLine(`2001:db8::7 - - [10/Oct/2026:13:55:36 +0000] "GET / HTTP/2.0" 304 - "-" "x"`)!.hit.ip, "2001:db8::7");
  eq("a bytes of “-” is 0", parseLine(`2001:db8::7 - - [10/Oct/2026:13:55:36 +0000] "GET / HTTP/2.0" 304 - "-" "x"`)!.hit.bytes, 0);
  const cf = parseLine(JSON.stringify({ ClientIP: "198.51.100.8", ClientRequestURI: "/x", ClientRequestUserAgent: "ClaudeBot/1.0", EdgeResponseStatus: 200, EdgeResponseBytes: 900, EdgeStartTimestamp: 1791883702000000000 }))!;
  eq("Cloudflare Logpush", [cf.format, cf.hit.ip, cf.hit.path, cf.hit.ua, cf.hit.bytes], ["json", "198.51.100.8", "/x", "ClaudeBot/1.0", 900]);
  eq("Cloudflare nanosecond timestamps", new Date(cf.hit.t!).getUTCFullYear(), 2026);
  const caddy = parseLine(JSON.stringify({ ts: 1791883702.5, request: { remote_ip: "198.51.100.9", method: "GET", uri: "/y", headers: { "User-Agent": ["GPTBot/1.2"] } }, status: 200, size: 77 }))!;
  eq("Caddy JSON", [caddy.hit.ip, caddy.hit.path, caddy.hit.ua, caddy.hit.bytes], ["198.51.100.9", "/y", "GPTBot/1.2", 77]);
  const vercel = parseLine(JSON.stringify({ type: "request", proxy: { clientIp: "198.51.100.10", path: "/z", userAgent: ["Bytespider"], statusCode: 200, method: "GET", timestamp: 1791883702000 } }))!;
  eq("Vercel log drain", [vercel.hit.ip, vercel.hit.path, vercel.hit.ua, vercel.hit.bytes], ["198.51.100.10", "/z", "Bytespider", null]);
  ok("a full URL is reduced to its path", parseLine(JSON.stringify({ ip: "198.51.100.1", url: "https://blog.example/p?q=1", ua: "x" }))!.hit.path === "/p?q=1");
  ok("junk lines are skipped, not guessed at", parseLine("hello world") === null && parseLine("{not json") === null);
}

/* ── the sample day, end to end ─────────────────────────────────────────── */
{
  const r = analyse(sampleLog(), SAMPLE_ROBOTS);
  const s = (t: string) => r.suspects.find((x) => x.token === t)!;
  ok(`every line of the sample parses (${r.parsed}/${r.lines})`, r.parsed === r.lines && r.lines > 5000);
  ok("GPTBot: mostly verified", s("GPTBot").verified >= 160);
  eq("GPTBot: the 90 requests from 192.0.2.66 are an impostor", [s("GPTBot").impostor, Object.keys(s("GPTBot").impostorIps)], [90, ["192.0.2.66"]]);
  ok("GPTBot read robots.txt", s("GPTBot").robotsFetched >= 1);
  eq("GPTBot's trespass is all the impostor's: the real one stayed out", [s("GPTBot").violationsBy.verified, s("GPTBot").violationsBy.impostor > 0], [0, true]);
  eq("Bytespider's trespass is its own (unverifiable, but it is the name it uses)", s("Bytespider").violationsBy.unverifiable, s("Bytespider").violations);
  ok(`Bytespider ignored a Disallow: / on every request (${s("Bytespider").violations}/${s("Bytespider").requests})`, s("Bytespider").violations === s("Bytespider").requests);
  eq("Bytespider never read robots.txt", s("Bytespider").robotsFetched, 0);
  eq("ClaudeBot stayed out and can't be verified", [s("ClaudeBot").violations, s("ClaudeBot").unverifiable > 0, s("ClaudeBot").verified], [0, true, 0]);
  ok(`meta-externalagent went into disallowed paths (${s("meta-externalagent").violations})`, s("meta-externalagent").violations > 0);
  eq("CCBot read robots.txt and left", [s("CCBot").requests, s("CCBot").violations], [1, 0]);
  eq("Googlebot verified, no violations", [s("Googlebot").impostor, s("Googlebot").violations], [0, 0]);
  eq("PerplexityBot verified", s("PerplexityBot").impostor, 0);
  ok("ChatGPT-User fetched a page on a user's behalf", s("ChatGPT-User").requests === 2 && s("ChatGPT-User").kind === "assistant");
  eq("the browser-shaped scraper is found", r.stealth.map((x) => x.block), ["203.0.113.0/24"]);
  ok(`…for the right reasons (${r.stealth[0]?.reasons.join("; ")})`, /no images/.test(r.stealth[0]?.reasons.join(" ") ?? "") && /referrer/.test(r.stealth[0]?.reasons.join(" ") ?? ""));
  ok("people are counted as people", r.byClass.people.requests > 2000);
  eq("own violations exclude the impostor's", ownViolations(s("GPTBot")), 0);
  eq("probes are counted", r.probes.requests, 160);
  ok("bytes are known", r.bytesKnown && r.byClass.ai.bytes > 0);
  ok("hourly buckets cover the day", r.hourly.length >= 22);
  ok("people are not mistaken for scrapers", !r.stealth.some((x) => x.block.startsWith("198.51.100")));
}
{
  const r = analyse(sampleLog(), null);
  ok("without a robots.txt nothing is called a violation", r.suspects.every((s) => s.violations === 0));
}

/* ── the stealth heuristic on its own ───────────────────────────────────── */
{
  const person = { ua: "", requests: 60, html: 10, assets: 50, bytes: 0, refs: 50, paths: new Set(["/a"]), robots: 0, minutes: { "1": 10 }, probes: 0, first: null, last: null };
  eq("someone who loads assets is a person", judge(person), []);
  const scraper = { ...person, requests: 500, html: 500, assets: 0, refs: 0, paths: new Set(Array.from({ length: 480 }, (_, i) => `/p${i}`)), minutes: { "1": 120 } };
  ok("500 pages, no assets, no referrers is a crawler", judge(scraper).length >= 3);
  const fewPages = { ...scraper, requests: 12, html: 12, paths: new Set(["/a", "/b"]), minutes: { "1": 3 } };
  eq("a handful of page views with no assets is not enough to accuse anyone", judge(fewPages), []);
}

/* ── the fixes ──────────────────────────────────────────────────────────── */
eq("robots.txt addition", robotsAddition(["Bytespider", "meta-externalagent"]), "User-agent: Bytespider\nUser-agent: meta-externalagent\nDisallow: /\n");
ok("nginx map escapes regex characters", /"~\*ChatGPT\\\\sAgent" 1;/.test(nginxBlock(["ChatGPT Agent"])) && /iaskspider\\\\\/2\\\\.0|iaskspider\/2\\\\.0/.test(nginxBlock(["iaskspider/2.0"])));
eq("Cloudflare expression", cloudflareRule(["Bytespider", "GPTBot"]), `(http.user_agent contains "Bytespider") or (http.user_agent contains "GPTBot")`);
ok(".htaccess", /RewriteCond %\{HTTP_USER_AGENT\} \(Bytespider\|GPTBot\) \[NC\]/.test(htaccess(["Bytespider", "GPTBot"])));
ok("nothing to block produces nothing", robotsAddition([]) === "" && nginxBlock([]) === "");

console.log(fails.length ? `✗ ${fails.length} failed of ${pass + fails.length}` : `✓ ${pass} assertions pass`);
for (const f of fails) console.log("  ✗", f);
process.exit(fails.length ? 1 : 0);
