/**
 * Who came to your site, whether they are who they say, and whether they kept
 * out of where you asked them to.
 *
 * Everything here is a pure function over log lines, so the same code runs in
 * the page's worker and in the tests — and nothing about your traffic leaves
 * the browser.
 */
import DATA from "./data.json";

/* ── agents ───────────────────────────────────────────────────────────────── */

export type Kind = "training" | "ai-search" | "assistant" | "search" | "preview" | "seo" | "monitor" | "archive" | "automation" | "library";
export type Agent = { token: string; operator: string; kind: Kind; respect: string; purpose: string; controlOnly: boolean; ai: boolean; verify: string[] | null };

export const AGENTS = DATA.agents as Agent[];
export const RANGES = DATA.ranges as Record<string, { url: string; created: string | null; prefixes: string[] }>;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/* Longest token first, so "Amazonbot" is found before "nbot" can claim it, and
   whole-token boundaries so "Code" does not match inside an unrelated word. */
const MATCHERS = AGENTS.filter((a) => !a.controlOnly)
  .sort((a, b) => b.token.length - a.token.length)
  .map((a) => {
    const open = /[/_]$/.test(a.token) ? "" : "(?=$|[\\s/;),.:+_-]|\\d)";
    return { a, re: new RegExp(`(?:^|[\\s;(,+"'])${esc(a.token)}${open}`, "i") };
  });

export function agentOf(ua: string): Agent | null {
  if (!ua || ua === "-") return null;
  for (const m of MATCHERS) if (m.re.test(ua)) return m.a;
  return null;
}

export const KIND_LABEL: Record<Kind, string> = {
  training: "AI training crawler", "ai-search": "AI search crawler", assistant: "AI fetch for a user",
  search: "search engine", preview: "link preview", seo: "SEO crawler", monitor: "uptime monitor",
  archive: "web archive", automation: "headless browser", library: "script / HTTP library",
};

/* ── IP ranges ────────────────────────────────────────────────────────────── */

type Net = { v6: boolean; base: bigint; bits: number };

export function parseIp(s: string): { v6: boolean; n: bigint } | null {
  s = s.trim().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const p = s.split(".").map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v6: false, n: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) };
  }
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return null;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is an IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) return parseIp(mapped[1]);
  let head = s, tail = "";
  if (s.includes("::")) { [head, tail] = s.split("::"); }
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  if (s.includes("::") ? h.length + t.length > 7 : h.length !== 8) return null;
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return { v6: true, n };
}

function parseNet(cidr: string): Net | null {
  const [ip, len] = cidr.split("/");
  const p = parseIp(ip);
  if (!p) return null;
  const bits = len === undefined ? (p.v6 ? 128 : 32) : Number(len);
  const width = p.v6 ? 128 : 32;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return { v6: p.v6, base: p.n & mask, bits };
}

const NETS: Record<string, Net[]> = Object.fromEntries(Object.entries(RANGES).map(([k, r]) => [k, r.prefixes.map(parseNet).filter((x): x is Net => !!x)]));

export function inNets(ip: string, lists: string[]): boolean {
  const p = parseIp(ip);
  if (!p) return false;
  const width = p.v6 ? 128 : 32;
  for (const l of lists) for (const n of NETS[l] ?? []) {
    if (n.v6 !== p.v6) continue;
    const mask = n.bits === 0 ? 0n : ((1n << BigInt(n.bits)) - 1n) << BigInt(width - n.bits);
    if ((p.n & mask) === n.base) return true;
  }
  return false;
}

export type Identity = "verified" | "impostor" | "unverifiable";
export function identity(a: Agent, ip: string): Identity {
  if (!a.verify) return "unverifiable";
  return inNets(ip, a.verify) ? "verified" : "impostor";
}

/** An address in a published range, for building examples that verify. */
export function addressIn(list: string, k = 7): string {
  const n = NETS[list].find((x) => !x.v6);
  if (!n) throw new Error(`${list} has no IPv4 ranges`);
  // Some operators publish single addresses (/32): stay inside the prefix.
  const size = 1n << BigInt(32 - n.bits);
  const v = n.base + (BigInt(k) % size);
  return [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 255n)).join(".");
}

/* ── robots.txt (RFC 9309) ────────────────────────────────────────────────── */

type Rule = { allow: boolean; path: string; re: RegExp; len: number };
export type Robots = { groups: { agents: string[]; names: string[]; rules: Rule[]; line: number }[]; raw: string };

function ruleRe(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).split("*").map(esc).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(raw: string): Robots {
  const groups: Robots["groups"] = [];
  let cur: Robots["groups"][number] | null = null, lastWasAgent = false;
  raw.split(/\r?\n/).forEach((line, i) => {
    const l = line.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(l);
    if (!m) return;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], names: [], rules: [], line: i + 1 }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      cur.names.push(val);
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (key === "disallow" && val === "") return; // "Disallow:" with nothing allows everything
      cur.rules.push({ allow: key === "allow", path: val, re: ruleRe(val), len: val.replace(/\*/g, "").length });
    } else lastWasAgent = false;
  });
  return { groups, raw };
}

/**
 * The rules that apply to a crawler: every group naming its product token
 * (merged), otherwise the "*" group. A named group *replaces* "*" — it does not
 * add to it — which is the most common robots.txt surprise there is.
 */
export function rulesFor(r: Robots, token: string): { rules: Rule[]; named: boolean } {
  const t = token.toLowerCase();
  const named = r.groups.filter((g) => g.agents.some((a) => a !== "*" && (t === a || t.startsWith(a))));
  if (named.length) return { rules: named.flatMap((g) => g.rules), named: true };
  return { rules: r.groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules), named: false };
}

/** Longest matching rule wins; on a tie, allow wins. /robots.txt itself is always allowed. */
export function allowed(r: Robots, token: string, path: string): { ok: boolean; rule: Rule | null } {
  if (path === "/robots.txt") return { ok: true, rule: null };
  let p = path;
  try { p = decodeURI(path); } catch { /* keep as is */ }
  let best: Rule | null = null;
  for (const rule of rulesFor(r, token).rules) {
    if (!rule.path) continue;
    if (rule.re.test(p) || rule.re.test(path)) {
      if (!best || rule.len > best.len || (rule.len === best.len && rule.allow && !best.allow)) best = rule;
    }
  }
  return { ok: !best || best.allow, rule: best };
}

/** robots.txt mistakes worth knowing about before reading any results. */
export function lintRobots(r: Robots): string[] {
  const out: string[] = [];
  const star = r.groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules).filter((x) => !x.allow);
  for (const g of r.groups) {
    const names = g.names.filter((a) => a !== "*");
    if (!names.length || !star.length) continue;
    const own = new Set(g.rules.map((x) => x.path));
    const escaped = star.filter((x) => !own.has(x.path) && !g.rules.some((y) => !y.allow && (y.path === "/" || x.path.startsWith(y.path))));
    if (escaped.length) {
      out.push(`The group for ${names.join(", ")} (line ${g.line}) replaces the “*” group instead of adding to it, so ${names.length > 1 ? "they are" : "it is"} no longer kept out of ${escaped.map((x) => x.path).join(", ")}. Repeat those lines in that group if you meant them to apply.`);
    }
  }
  if (!r.groups.length) out.push("No groups found. A robots.txt needs “User-agent:” lines followed by “Disallow:” or “Allow:”.");
  return out;
}

/* ── log lines ────────────────────────────────────────────────────────────── */

export type Hit = { ip: string; t: number | null; method: string; path: string; status: number; bytes: number | null; ref: string; ua: string };

const MON: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function clfTime(s: string): number | null {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m || !(m[2] in MON)) return null;
  const off = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5], +m[6]) - off * 60000;
}
function anyTime(v: unknown): number | null {
  if (typeof v === "number") return v > 1e17 ? v / 1e6 : v > 1e14 ? v / 1e3 : v > 1e11 ? v : v * 1000; // ns, µs, ms, s
  if (typeof v === "string") {
    if (/^\d+(\.\d+)?$/.test(v)) return anyTime(Number(v));
    const c = clfTime(v); if (c !== null) return c;
    const d = Date.parse(v); return Number.isNaN(d) ? null : d;
  }
  return null;
}

// combined and common log format, with or without a leading virtual host
const CLF = /^(?:\S+:\d+\s+)?(\S+) \S+ \S+ \[([^\]]+)\] "(?:(\S+) (\S+)(?: [^"]*)?|-)" (\d{3}) (\d+|-)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?/;

function dig(o: Record<string, unknown>, path: string): unknown {
  let cur: unknown = o;
  for (const k of path.split(".")) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return Array.isArray(cur) ? cur[0] : cur;
}
function first(o: Record<string, unknown>, paths: string[]): unknown {
  for (const p of paths) { const v = dig(o, p); if (v !== undefined && v !== null && v !== "") return v; }
  return undefined;
}

export type Format = "combined" | "common" | "json";

/** One log line → one request, or null if the line is not a request we can read. */
export function parseLine(line: string): { hit: Hit; format: Format } | null {
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(s); } catch { return null; }
    const ip = first(o, ["ClientIP", "client_ip", "clientIp", "remote_ip", "remote_addr", "ip", "request.remote_ip", "request.client_ip", "proxy.clientIp", "c-ip", "httpRequest.remoteIp"]);
    const path = first(o, ["ClientRequestURI", "ClientRequestPath", "request_uri", "uri", "path", "url", "request.uri", "proxy.path", "cs-uri-stem", "httpRequest.requestUrl"]);
    if (typeof ip !== "string" || typeof path !== "string") return null;
    let p = path;
    if (/^https?:\/\//i.test(p)) { try { const u = new URL(p); p = u.pathname + u.search; } catch { /* keep */ } }
    const status = Number(first(o, ["EdgeResponseStatus", "status", "status_code", "statusCode", "proxy.statusCode", "sc-status", "httpRequest.status"]) ?? 0);
    const b = first(o, ["EdgeResponseBytes", "bytes", "body_bytes_sent", "bytes_sent", "size", "response_size", "sc-bytes", "httpRequest.responseSize"]);
    return {
      format: "json",
      hit: {
        ip, path: p, status,
        t: anyTime(first(o, ["EdgeStartTimestamp", "timestamp", "time", "@timestamp", "ts", "proxy.timestamp", "date"])),
        method: String(first(o, ["ClientRequestMethod", "method", "request.method", "proxy.method", "cs-method", "httpRequest.requestMethod"]) ?? "GET"),
        bytes: b === undefined ? null : Number(b),
        ref: String(first(o, ["ClientRequestReferer", "referer", "referrer", "http_referer", "proxy.referer", "request.headers.Referer", "httpRequest.referer"]) ?? ""),
        ua: String(first(o, ["ClientRequestUserAgent", "user_agent", "userAgent", "http_user_agent", "ua", "request.headers.User-Agent", "proxy.userAgent", "httpRequest.userAgent"]) ?? ""),
      },
    };
  }
  const m = CLF.exec(s);
  if (!m) return null;
  return {
    format: m[8] !== undefined ? "combined" : "common",
    hit: {
      ip: m[1], t: clfTime(m[2]), method: m[3] ?? "-", path: m[4] ?? "-", status: Number(m[5]),
      bytes: m[6] === "-" ? 0 : Number(m[6]), ref: (m[7] ?? "").replace(/\\"/g, '"'), ua: (m[8] ?? "").replace(/\\"/g, '"'),
    },
  };
}

/* ── what kind of request ─────────────────────────────────────────────────── */

const ASSET = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|map|json|xml|txt|wasm)(\?|$)/i;
const PROBE = /(wp-login\.php|wp-admin|xmlrpc\.php|wp-content\/.*\.php|\/\.env|\/\.git\/|phpinfo|phpmyadmin|\/cgi-bin\/|\.aspx?$|\/admin\.php|\/setup\.php|\/vendor\/phpunit|\/\.aws\/|\/\.ssh\/|\/actuator|\/server-status|\/config\.(php|json|yml)|\/\.DS_Store|\/boaform|\/HNAP1|\/shell|\/eval-stdin)/i;
const BROWSER = /Mozilla\/5\.0 .*(Chrome|Firefox|Safari|Edg)\//;

export const isAsset = (p: string) => ASSET.test(p);
export const isProbe = (p: string) => PROBE.test(p);

/* ── the analysis ─────────────────────────────────────────────────────────── */

export type Class = "people" | "ai" | "search" | "otherbots" | "probes" | "stealth" | "unknown";
export const CLASS_LABEL: Record<Class, string> = {
  people: "people", ai: "AI agents", search: "search engines", otherbots: "other bots and scripts",
  probes: "vulnerability probes", stealth: "browser-shaped crawlers", unknown: "unidentified",
};

export type Suspect = {
  token: string; operator: string; kind: Kind; ai: boolean; respect: string; purpose: string;
  requests: number; bytes: number; ips: number; verified: number; impostor: number; unverifiable: number;
  robotsFetched: number; violations: number; violationPaths: Record<string, number>; examples: string[];
  /** Who did the trespassing: the real crawler, someone using its name, or a crawler that can't be checked. */
  violationsBy: Record<Identity, number>;
  impostorIps: Record<string, number>; first: number | null; last: number | null; statuses: Record<string, number>;
};

type Agg = {
  lines: number; parsed: number; formats: Record<string, number>; bytesKnown: boolean;
  start: number | null; end: number | null;
  byClass: Record<Class, { requests: number; bytes: number }>;
  hourly: Record<string, Record<Class, number>>;
  suspects: Record<string, Suspect>;
  groups: Record<string, { ua: string; requests: number; html: number; assets: number; bytes: number; refs: number; paths: Set<string> | string[]; robots: number; minutes: Record<string, number>; probes: number; first: number | null; last: number | null }>;
  probes: { requests: number; paths: Record<string, number>; ips: Record<string, number> };
};

const emptyClass = (): Record<Class, { requests: number; bytes: number }> =>
  ({ people: { requests: 0, bytes: 0 }, ai: { requests: 0, bytes: 0 }, search: { requests: 0, bytes: 0 }, otherbots: { requests: 0, bytes: 0 }, probes: { requests: 0, bytes: 0 }, stealth: { requests: 0, bytes: 0 }, unknown: { requests: 0, bytes: 0 } });

export function newAgg(): Agg {
  return { lines: 0, parsed: 0, formats: {}, bytesKnown: false, start: null, end: null, byClass: emptyClass(), hourly: {}, suspects: {}, groups: {}, probes: { requests: 0, paths: {}, ips: {} } };
}

const groupKey = (ip: string) => {
  const p = parseIp(ip);
  if (!p) return ip;
  // Scrapers rotate addresses within a block: group IPv4 by /24 and IPv6 by /48.
  if (!p.v6) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  return (p.n >> 80n).toString(16).padStart(12, "0").replace(/(.{4})(.{4})(.{4})/, "$1:$2:$3") + "::/48";
};

/** Trespass by the agent itself — not by someone borrowing its name. */
export const ownViolations = (s: Suspect) => s.violationsBy.verified + s.violationsBy.unverifiable;

/** Feed one line. robots may be null: then nothing is counted as a violation. */
export function add(agg: Agg, line: string, robots: Robots | null) {
  agg.lines++;
  const r = parseLine(line);
  if (!r) return;
  const h = r.hit;
  agg.parsed++;
  agg.formats[r.format] = (agg.formats[r.format] ?? 0) + 1;
  if (h.bytes !== null && h.bytes > 0) agg.bytesKnown = true;
  const bytes = h.bytes ?? 0;
  if (h.t !== null) { agg.start = agg.start === null ? h.t : Math.min(agg.start, h.t); agg.end = agg.end === null ? h.t : Math.max(agg.end, h.t); }
  const hour = h.t === null ? "?" : new Date(Math.floor(h.t / 3600000) * 3600000).toISOString().slice(0, 13);
  const bump = (c: Class) => {
    agg.byClass[c].requests++; agg.byClass[c].bytes += bytes;
    (agg.hourly[hour] ??= { people: 0, ai: 0, search: 0, otherbots: 0, probes: 0, stealth: 0, unknown: 0 })[c]++;
  };

  const a = agentOf(h.ua);
  if (a) {
    const s = (agg.suspects[a.token] ??= {
      token: a.token, operator: a.operator, kind: a.kind, ai: a.ai, respect: a.respect, purpose: a.purpose,
      requests: 0, bytes: 0, ips: 0, verified: 0, impostor: 0, unverifiable: 0, robotsFetched: 0, violations: 0,
      violationPaths: {}, examples: [], impostorIps: {}, first: null, last: null, statuses: {},
      violationsBy: { verified: 0, impostor: 0, unverifiable: 0 },
    });
    s.requests++; s.bytes += bytes;
    const id = identity(a, h.ip);
    s[id]++;
    if (id === "impostor") s.impostorIps[h.ip] = (s.impostorIps[h.ip] ?? 0) + 1;
    if (h.path === "/robots.txt") s.robotsFetched++;
    if (h.t !== null) { s.first = s.first === null ? h.t : Math.min(s.first, h.t); s.last = s.last === null ? h.t : Math.max(s.last, h.t); }
    const st = String(Math.floor(h.status / 100)) + "xx";
    s.statuses[st] = (s.statuses[st] ?? 0) + 1;
    if (robots && h.method !== "OPTIONS") {
      const v = allowed(robots, a.token, h.path.split("#")[0]);
      if (!v.ok) {
        s.violations++;
        s.violationsBy[id]++;
        const key = v.rule?.path ?? h.path;
        s.violationPaths[key] = (s.violationPaths[key] ?? 0) + 1;
        if (s.examples.length < 5) s.examples.push(line.length > 400 ? line.slice(0, 400) + "…" : line);
      }
    }
    (s as Suspect & { _ips?: Set<string> })._ips ??= new Set();
    (s as Suspect & { _ips?: Set<string> })._ips!.add(h.ip);
    const kind = a.kind;
    bump(a.ai && kind !== "search" && kind !== "preview" ? "ai" : kind === "search" ? "search" : "otherbots");
    return;
  }

  if (isProbe(h.path)) {
    agg.probes.requests++;
    agg.probes.paths[h.path] = (agg.probes.paths[h.path] ?? 0) + 1;
    agg.probes.ips[h.ip] = (agg.probes.ips[h.ip] ?? 0) + 1;
    bump("probes");
    return;
  }

  // Everything else is grouped by address block and judged on behaviour at the end.
  const k = groupKey(h.ip);
  const g = (agg.groups[k] ??= { ua: h.ua, requests: 0, html: 0, assets: 0, bytes: 0, refs: 0, paths: new Set<string>(), robots: 0, minutes: {}, probes: 0, first: null, last: null });
  g.requests++; g.bytes += bytes;
  if (isAsset(h.path)) g.assets++; else g.html++;
  if (h.ref && h.ref !== "-") g.refs++;
  if (h.path === "/robots.txt") g.robots++;
  (g.paths as Set<string>).add(h.path.split("?")[0]);
  if (h.t !== null) {
    const m = String(Math.floor(h.t / 60000));
    g.minutes[m] = (g.minutes[m] ?? 0) + 1;
    g.first = g.first === null ? h.t : Math.min(g.first, h.t); g.last = g.last === null ? h.t : Math.max(g.last, h.t);
  }
  if (!BROWSER.test(h.ua)) g.ua = g.ua || h.ua;
  // People and stealth are only known once the whole log is in; count them in finish().
  (g as typeof g & { _hours?: Record<string, number> })._hours ??= {};
  const hh = (g as typeof g & { _hours?: Record<string, number> })._hours!;
  hh[hour] = (hh[hour] ?? 0) + 1;
}

export type Crawlerish = { block: string; ua: string; requests: number; pages: number; assets: number; refs: number; distinct: number; peakPerMinute: number; robots: number; bytes: number; reasons: string[] };

export type Result = {
  lines: number; parsed: number; formats: Record<string, number>; bytesKnown: boolean; start: number | null; end: number | null;
  byClass: Record<Class, { requests: number; bytes: number }>;
  hourly: [string, Record<Class, number>][];
  suspects: Suspect[]; stealth: Crawlerish[];
  probes: { requests: number; paths: [string, number][]; ips: number };
};

/**
 * A browser-shaped visitor that behaves like a crawler: many pages, almost no
 * images, scripts or styles, and no referrers. Real browsers fetch the page's
 * assets; crawlers that pretend to be Chrome usually don't bother.
 */
export function judge(g: Agg["groups"][string]): string[] {
  const reasons: string[] = [];
  const paths = g.paths instanceof Set ? g.paths.size : g.paths.length;
  const peak = Math.max(0, ...Object.values(g.minutes));
  if (g.html >= 40 && g.assets <= g.html * 0.05) reasons.push(`${g.html.toLocaleString("en-US")} pages but ${g.assets ? `only ${g.assets}` : "no"} images, scripts or styles`);
  if (g.html >= 40 && g.refs <= g.requests * 0.05) reasons.push("almost never sends a referrer");
  if (paths >= 40 && paths >= g.html * 0.8) reasons.push(`${paths.toLocaleString("en-US")} different pages, rarely the same one twice`);
  if (peak >= 30) reasons.push(`up to ${peak} requests in a single minute`);
  return reasons.length >= 2 ? reasons : [];
}

export function finish(agg: Agg): Result {
  const stealth: Crawlerish[] = [];
  for (const [block, g] of Object.entries(agg.groups)) {
    const reasons = judge(g);
    const hours = (g as typeof g & { _hours?: Record<string, number> })._hours ?? {};
    const cls: Class = reasons.length ? "stealth" : BROWSER.test(g.ua) || g.assets > 0 ? "people" : "unknown";
    agg.byClass[cls].requests += g.requests; agg.byClass[cls].bytes += g.bytes;
    for (const [hour, n] of Object.entries(hours)) (agg.hourly[hour] ??= { people: 0, ai: 0, search: 0, otherbots: 0, probes: 0, stealth: 0, unknown: 0 })[cls] += n;
    if (reasons.length) {
      stealth.push({ block, ua: g.ua, requests: g.requests, pages: g.html, assets: g.assets, refs: g.refs, distinct: g.paths instanceof Set ? g.paths.size : g.paths.length, peakPerMinute: Math.max(0, ...Object.values(g.minutes)), robots: g.robots, bytes: g.bytes, reasons });
    }
  }
  const suspects = Object.values(agg.suspects).map((s) => {
    const ips = (s as Suspect & { _ips?: Set<string> })._ips;
    const out: Suspect = { ...s, ips: ips ? ips.size : s.ips };
    delete (out as Suspect & { _ips?: Set<string> })._ips;
    return out;
  }).sort((a, b) => b.requests - a.requests);
  return {
    lines: agg.lines, parsed: agg.parsed, formats: agg.formats, bytesKnown: agg.bytesKnown, start: agg.start, end: agg.end,
    byClass: agg.byClass,
    hourly: Object.entries(agg.hourly).filter(([k]) => k !== "?").sort(([a], [b]) => a.localeCompare(b)),
    suspects, stealth: stealth.sort((a, b) => b.requests - a.requests),
    probes: { requests: agg.probes.requests, paths: Object.entries(agg.probes.paths).sort((a, b) => b[1] - a[1]).slice(0, 12), ips: Object.keys(agg.probes.ips).length },
  };
}

export function analyse(text: string, robotsTxt: string | null): Result {
  const agg = newAgg();
  const robots = robotsTxt ? parseRobots(robotsTxt) : null;
  for (const line of text.split(/\r?\n/)) if (line.trim()) add(agg, line, robots);
  return finish(agg);
}

/* ── the fix ──────────────────────────────────────────────────────────────── */

export function robotsAddition(tokens: string[]): string {
  if (!tokens.length) return "";
  return tokens.map((t) => `User-agent: ${t}`).join("\n") + "\nDisallow: /\n";
}
export function nginxBlock(tokens: string[]): string {
  if (!tokens.length) return "";
  return `# in the http {} block
map $http_user_agent $trespass_block {
    default 0;
${tokens.map((t) => `    "~*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&").replace(/ /g, "\\\\s")}" 1;`).join("\n")}
}

# in each server {} block
if ($trespass_block) { return 403; }
`;
}
export function cloudflareRule(tokens: string[]): string {
  if (!tokens.length) return "";
  return tokens.map((t) => `(http.user_agent contains "${t.replace(/"/g, '\\"')}")`).join(" or ");
}
export function htaccess(tokens: string[]): string {
  if (!tokens.length) return "";
  return `RewriteEngine On
RewriteCond %{HTTP_USER_AGENT} (${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\ ")).join("|")}) [NC]
RewriteRule .* - [F,L]
`;
}
export function ipBlock(ips: string[]): string {
  return ips.map((ip) => `deny ${ip};`).join("\n");
}
