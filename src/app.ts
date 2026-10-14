import {
  AGENTS, KIND_LABEL, CLASS_LABEL, ownViolations, parseRobots, lintRobots, robotsAddition, nginxBlock, cloudflareRule, htaccess, ipBlock,
  type Result, type Suspect, type Class,
} from "./core";
import { sampleLog, SAMPLE_ROBOTS } from "./sample";
import DATA from "./data.json";

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean | ((e: Event) => void) | undefined> = {}, ...kids: Kid[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
const $ = <T extends Element>(s: string) => document.querySelector(s) as T;
/** replaceChildren, skipping the nulls that conditional content produces. */
const fill = (el: Element, ...kids: Kid[]) => el.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false));
const n = (x: number) => x.toLocaleString("en-US");
function size(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}
const money = (x: number) => (x >= 100 ? `$${Math.round(x).toLocaleString("en-US")}` : x >= 1 ? `$${x.toFixed(2)}` : x > 0 ? `$${x.toFixed(3)}` : "$0");
const when = (t: number | null) => (t === null ? "?" : new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC");

const state = { result: null as Result | null, robots: "", perGb: 0.09, picked: null as string | null, source: "" };

/* ── the lineup ───────────────────────────────────────────────────────────── */
function lineupWorthy(s: Suspect) {
  return s.ai || s.impostor > 0 || s.violations > 0 || s.requests >= 20;
}
function rank(s: Suspect) {
  return (ownViolations(s) ? 4e9 : 0) + (s.impostor ? 2e9 : 0) + (s.ai ? 1e9 : 0) + s.requests;
}

function lineup(r: Result) {
  const wall = $("#wall") as HTMLElement;
  const cast = r.suspects.filter(lineupWorthy).sort((a, b) => rank(b) - rank(a)).slice(0, 14);
  if (!cast.length) {
    wall.replaceChildren(h("p", { class: "empty" }, "No known bots in this log. Everyone here is either a person, an unidentified client, or a probe — see below."));
    return;
  }
  const max = Math.max(...cast.map((s) => s.requests));
  const top = Math.max(2, Math.ceil(Math.log10(max + 1)));
  const marks = Array.from({ length: top + 1 }, (_, i) => i);
  const H = (count: number) => (Math.log10(count + 1) / top) * 100;
  const grid = h("div", { class: "marks" }, ...marks.map((m) => h("div", { class: "mark", style: `bottom:${(m / top) * 100}%` }, h("span", {}, m === 0 ? "0" : n(10 ** m)))));
  const people = cast.map((s, i) => {
    const flags: string[] = [];
    if (s.impostor) flags.push("impostor");
    if (ownViolations(s)) flags.push("violator");
    const id = s.impostor && !s.verified ? "IMPOSTOR" : s.impostor ? "PART IMPOSTOR" : s.verified ? "VERIFIED" : s.unverifiable ? "UNVERIFIABLE" : "";
    // Unitless: it multiplies a length in calc(), and a percentage times a percentage is invalid CSS.
    const label = s.token.replace(/\/$/, "");
    const fs = Math.max(10, Math.min(15, Math.floor(15 * 11 / Math.max(11, label.length))));
    return h("button", { class: `suspect ${flags.join(" ")} ${state.picked === s.token ? "on" : ""}`, style: `--h:${H(s.requests).toFixed(2)};--fs:${fs}px`, onclick: () => { state.picked = s.token; render(); $("#file").scrollIntoView({ behavior: "smooth", block: "start" }); }, "aria-label": `${s.token}: ${n(s.requests)} requests` },
      h("span", { class: "body" }),
      h("span", { class: "placard" },
        h("span", { class: "no" }, `No. ${String(i + 1).padStart(2, "0")}`),
        h("span", { class: "name" }, label.replace(/-/g, "-\u200b")),
        h("span", { class: "op" }, s.operator === "unknown" ? KIND_LABEL[s.kind] : s.operator),
        h("span", { class: "count" }, n(s.requests)),
        id ? h("span", { class: `id id-${id.split(" ")[0].toLowerCase()}` }, id) : null),
      ownViolations(s) ? h("span", { class: "stamp" }, "IGNORED ROBOTS.TXT") : null);
  });
  wall.replaceChildren(grid, h("div", { class: "row" }, ...people));
}

/* ── one suspect's file ───────────────────────────────────────────────────── */
function file(r: Result) {
  const box = $("#file") as HTMLElement;
  const s = r.suspects.find((x) => x.token === state.picked) ?? r.suspects.filter(lineupWorthy).sort((a, b) => rank(b) - rank(a))[0];
  if (!s) { box.replaceChildren(); return; }
  state.picked = s.token;
  const agent = AGENTS.find((a) => a.token === s.token);
  const verifiable = !!agent?.verify;
  const facts: [string, Kid][] = [
    ["Operator", s.operator],
    ["What it is", `${KIND_LABEL[s.kind]}${s.purpose ? ` — ${s.purpose}` : ""}`],
    ["Requests", `${n(s.requests)} from ${n(s.ips)} address${s.ips === 1 ? "" : "es"}`],
    ["Data sent to it", r.bytesKnown ? `${size(s.bytes)} · ${money((s.bytes / 1e9) * state.perGb)} at $${state.perGb}/GB` : "not in this log format"],
    ["Seen", `${when(s.first)} → ${when(s.last)}`],
    ["Read robots.txt", s.robotsFetched ? `yes, ${n(s.robotsFetched)} time${s.robotsFetched === 1 ? "" : "s"}` : "never"],
    ["Says it respects robots.txt", s.respect === "yes" ? "yes" : s.respect === "no" ? "no" : s.respect === "n/a" ? "not applicable — it is a script, not a crawler" : "unclear"],
  ];
  const identity = verifiable
    ? h("div", { class: "verdict-row" },
      h("span", { class: "pill ok" }, `${n(s.verified)} verified`),
      s.impostor ? h("span", { class: "pill bad" }, `${n(s.impostor)} from outside ${s.operator}’s published addresses`) : null)
    : h("p", { class: "muted" }, `${s.operator === "unknown" ? "This client" : s.operator} publishes no list of crawler addresses, so these ${n(s.requests)} requests can’t be checked against it — anyone can put “${s.token.replace(/\/$/, "")}” in a User-Agent.`);
  const assistantNote = s.kind === "assistant" && s.violations
    ? h("p", { class: "note" }, "These are fetches made because a person asked an AI about a page, not crawling. The operators’ position is that robots.txt governs automated crawlers, not user-requested fetches — so treat these as visits, and block the agent at the server if you don’t want them.")
    : null;
  fill(box,
    h("div", { class: "file-head" },
      h("span", { class: "tab" }, "FILE"),
      h("h2", {}, s.token.replace(/\/$/, "")),
      s.impostor && !s.verified ? h("span", { class: "big-stamp red" }, "IMPOSTOR") : ownViolations(s) ? h("span", { class: "big-stamp" }, "TRESPASS") : null),
    h("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    h("h3", {}, "Is it really " + s.token.replace(/\/$/, "") + "?"),
    identity,
    s.impostor ? h("div", { class: "evidence" }, h("p", { class: "muted" }, "Addresses using the name without being in the published list:"),
      h("ul", { class: "mono" }, ...Object.entries(s.impostorIps).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ip, c]) => h("li", {}, `${ip} — ${n(c)} request${c === 1 ? "" : "s"}`)))) : null,
    h("h3", {}, "Did it stay out?"),
    !state.robots.trim()
      ? h("p", { class: "muted" }, "Paste your robots.txt above to check.")
      : s.violations
        ? h("div", {},
          ownViolations(s)
            ? h("p", { class: "charge" }, `${n(s.violations)} request${s.violations === 1 ? "" : "s"} to paths your robots.txt closes to it${s.violationsBy.impostor ? ` — ${n(s.violationsBy.impostor)} of them from impostor addresses, ${n(ownViolations(s))} from ${s.violationsBy.verified ? `${s.operator}’s own published addresses` : "addresses that can’t be checked"}` : ""}.`)
            : h("p", { class: "clean" }, s.verified
              ? `${s.operator}’s own ${s.token} stayed out. All ${n(s.violations)} request${s.violations === 1 ? "" : "s"} to closed paths came from addresses that aren’t ${s.operator}’s — the impostor, not the crawler.`
              : `None of this came from ${s.operator}: every request using the name was from outside its published addresses. The ${n(s.violations)} request${s.violations === 1 ? "" : "s"} to closed paths are the impostor’s.`),
          h("ul", { class: "rules" }, ...Object.entries(s.violationPaths).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, c]) => h("li", {}, h("code", {}, `Disallow: ${p}`), ` — ${n(c)}`))),
          assistantNote,
          h("p", { class: "muted" }, "From your log, exactly as written:"),
          h("pre", { class: "lines" }, s.examples.join("\n")),
          null)
        : h("p", { class: "clean" }, "Yes — every request was to a path your robots.txt allows it."),
  );
}

/* ── everyone else ────────────────────────────────────────────────────────── */
const CLASS_ORDER: Class[] = ["people", "ai", "search", "otherbots", "stealth", "probes", "unknown"];
function summary(r: Result) {
  const total = Object.values(r.byClass).reduce((a, c) => a + c.requests, 0) || 1;
  const bytes = Object.values(r.byClass).reduce((a, c) => a + c.bytes, 0);
  const notPeople = total - r.byClass.people.requests;
  ($("#summary") as HTMLElement).replaceChildren(
    h("p", { class: "headline" },
      h("strong", {}, `${Math.round((notPeople / total) * 100)}%`), " of requests were not people",
      r.bytesKnown ? h("span", {}, ` — ${size(bytes - r.byClass.people.bytes)} of data, ${money(((bytes - r.byClass.people.bytes) / 1e9) * state.perGb)} at $${state.perGb}/GB`) : null, "."),
    h("div", { class: "bar" }, ...CLASS_ORDER.filter((c) => r.byClass[c].requests).map((c) =>
      h("span", { class: `seg c-${c}`, style: `flex:${r.byClass[c].requests}`, title: `${CLASS_LABEL[c]}: ${n(r.byClass[c].requests)}` }))),
    h("div", { class: "legend" }, ...CLASS_ORDER.filter((c) => r.byClass[c].requests).map((c) =>
      h("span", {}, h("i", { class: `c-${c}` }), `${CLASS_LABEL[c]} `, h("b", {}, n(r.byClass[c].requests)), r.bytesKnown ? ` · ${size(r.byClass[c].bytes)}` : ""))),
    h("p", { class: "muted small" }, `${n(r.parsed)} of ${n(r.lines)} lines read (${Object.entries(r.formats).map(([f, c]) => `${f} ${n(c)}`).join(", ")}) · ${when(r.start)} → ${when(r.end)} · ${state.source}`),
  );

  const max = Math.max(1, ...r.hourly.map(([, v]) => Object.values(v).reduce((a, b) => a + b, 0)));
  ($("#timeline") as HTMLElement).replaceChildren(...r.hourly.map(([hr, v]) =>
    h("div", { class: "col", title: `${hr}:00 UTC` }, ...[...CLASS_ORDER].reverse().filter((c) => v[c]).map((c) =>
      h("span", { class: `c-${c}`, style: `height:${(v[c] / max) * 100}%` })))));
  ($("#timeline-label") as HTMLElement).textContent = r.hourly.length ? `${r.hourly[0][0].replace("T", " ")}:00 → ${r.hourly[r.hourly.length - 1][0].replace("T", " ")}:00 UTC, by hour` : "";
}

function others(r: Result) {
  const box = $("#others") as HTMLElement;
  const kids: Kid[] = [];
  kids.push(h("article", { class: "card" },
    h("h3", {}, "Dressed as a browser"),
    r.stealth.length
      ? h("div", {}, h("p", { class: "muted" }, "These say they are an ordinary browser but don’t behave like one. Grouped by address block, because scrapers rotate addresses."),
        ...r.stealth.slice(0, 6).map((s) => h("div", { class: "stealth" },
          h("p", {}, h("code", {}, s.block), ` — ${n(s.requests)} requests${state.result?.bytesKnown ? `, ${size(s.bytes)}` : ""}`),
          h("ul", {}, ...s.reasons.map((x) => h("li", {}, x))))))
      : h("p", { class: "muted" }, "Nothing browser-shaped behaved like a crawler. (It looks for many pages with no images, scripts or styles and no referrers.)")));
  kids.push(h("article", { class: "card" },
    h("h3", {}, "Trying the doors"),
    r.probes.requests
      ? h("div", {}, h("p", { class: "muted" }, `${n(r.probes.requests)} requests from ${n(r.probes.ips)} addresses for things a blog doesn’t have — WordPress logins, .env files, git configs. Routine background noise on the internet; they only matter if one returns 200.`),
        h("ul", { class: "mono" }, ...r.probes.paths.slice(0, 8).map(([p, c]) => h("li", {}, `${p} — ${n(c)}`))))
      : h("p", { class: "muted" }, "No vulnerability probes.")));
  const minor = r.suspects.filter((s) => !lineupWorthy(s));
  if (minor.length) kids.push(h("article", { class: "card" }, h("h3", {}, "Also seen"),
    h("ul", {}, ...minor.map((s) => h("li", {}, `${s.token.replace(/\/$/, "")} (${KIND_LABEL[s.kind]}) — ${n(s.requests)}`)))));
  fill(box, ...kids);
}

/* ── locking the doors ────────────────────────────────────────────────────── */
const chosen = new Set<string>();
let chosenFor = "";
function fixes(r: Result) {
  const box = $("#fixes") as HTMLElement;
  const candidates = r.suspects.filter((s) => s.ai || s.violations || s.kind === "automation" || s.kind === "library").sort((a, b) => rank(b) - rank(a));
  const key = candidates.map((c) => c.token).join("|");
  if (chosenFor !== key) {
    chosen.clear();
    for (const s of candidates) if (ownViolations(s) || s.kind === "training") chosen.add(s.token);
    chosenFor = key;
  }
  const impostorIps = [...new Set(r.suspects.flatMap((s) => Object.keys(s.impostorIps)))];
  const draw = () => {
    const tokens = [...chosen].map((t) => t.replace(/\/$/, ""));
    const respectful = [...chosen].filter((t) => AGENTS.find((a) => a.token === t)?.respect === "yes");
    const blocks: [string, string, string][] = [
      ["robots.txt — add to yours", "Works on bots that honour it. Ask nicely first; it costs nothing.", robotsAddition(respectful.map((t) => t.replace(/\/$/, "")))],
      ["nginx", "For the ones that don’t listen. Matches the User-Agent and refuses with 403.", nginxBlock(tokens)],
      ["Cloudflare — custom WAF rule, action Block", "Paste as the rule’s expression.", cloudflareRule(tokens)],
      ["Apache .htaccess", "", htaccess(tokens)],
      ["Impostor addresses — nginx", "A User-Agent block can’t stop an impostor who changes its name; block the addresses. Blocking the name alone would also shut out the real crawler.", ipBlock(impostorIps)],
    ];
    ($("#fix-out") as HTMLElement).replaceChildren(...blocks.filter(([, , code]) => code.trim()).map(([title, note, code]) => {
      const pre = h("pre", { class: "code" }, code);
      return h("div", { class: "fix" },
        h("div", { class: "fix-head" }, h("strong", {}, title),
          h("button", { class: "copy", onclick: async (e) => { const b = e.currentTarget as HTMLElement; try { await navigator.clipboard.writeText(code); b.textContent = "copied"; } catch { b.textContent = "select & copy"; } setTimeout(() => (b.textContent = "copy"), 1500); } }, "copy")),
        note ? h("p", { class: "muted" }, note) : null, pre);
    }));
  };
  box.replaceChildren(
    h("p", { class: "muted" }, "Pre-ticked: anything that ignored your robots.txt itself, and crawlers that collect training data. Untick what you want to keep — AI search and user fetches are how AI answers link back to you. Impostors are handled by address, below, so blocking a name never shuts out the real crawler by accident."),
    h("div", { class: "choices" }, ...candidates.map((s) => {
      const cb = h("input", { type: "checkbox", checked: chosen.has(s.token) || undefined }) as HTMLInputElement;
      cb.addEventListener("change", () => { if (cb.checked) chosen.add(s.token); else chosen.delete(s.token); draw(); });
      return h("label", { class: "choice" }, cb, h("span", {}, s.token.replace(/\/$/, ""), h("small", {}, ` ${KIND_LABEL[s.kind]}${ownViolations(s) ? " · ignored robots.txt" : ""}${s.impostor ? " · has impostors" : ""}`)));
    })),
    h("div", { id: "fix-out" }),
  );
  draw();
}

/* ── robots.txt notes ─────────────────────────────────────────────────────── */
function robotsNotes() {
  const box = $("#robots-notes") as HTMLElement;
  if (!state.robots.trim()) { box.replaceChildren(h("p", { class: "muted" }, "Without your robots.txt, TRESPASS can say who came — not who came in where they were told not to.")); return; }
  const r = parseRobots(state.robots);
  const lint = lintRobots(r);
  box.replaceChildren(
    h("p", { class: "muted" }, `${r.groups.length} group${r.groups.length === 1 ? "" : "s"} read. Checked against today’s rules — if your robots.txt changed during the log, older requests may have been allowed at the time.`),
    ...lint.map((l) => h("p", { class: "warn" }, l)));
}

function render() {
  const r = state.result;
  robotsNotes();
  if (!r) return;
  $("#results").removeAttribute("hidden");
  summary(r); lineup(r); file(r); others(r); fixes(r);
}

/* ── input ────────────────────────────────────────────────────────────────── */
let worker: Worker | null = null;
function run(input: { file?: File; text?: string }, source: string) {
  worker?.terminate();
  worker = new Worker("worker.js");
  const status = $("#status") as HTMLElement;
  status.textContent = "Reading…";
  state.source = source;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.progress) {
      const p = m.progress;
      status.textContent = `Reading… ${n(p.lines)} lines${p.total ? ` · ${Math.min(100, Math.round((p.chars / p.total) * 100))}%` : ""}`;
    } else if (m.result) {
      state.result = m.result; state.picked = null;
      status.textContent = m.result.parsed ? "" : "None of those lines looked like an access log. TRESPASS reads nginx/Apache combined or common format, and JSON lines from Cloudflare, Caddy and Vercel.";
      render();
      if (m.result.parsed) $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (m.error) status.textContent = `Couldn’t read that: ${m.error}`;
  };
  worker.postMessage({ ...input, robots: state.robots });
}

function boot() {
  const robotsBox = $("#robots") as HTMLTextAreaElement;
  const perGb = $("#pergb") as HTMLInputElement;
  robotsBox.addEventListener("input", () => { state.robots = robotsBox.value; robotsNotes(); });
  robotsBox.addEventListener("change", () => { if (lastInput) run(lastInput.input, lastInput.source); });
  perGb.addEventListener("input", () => { const v = parseFloat(perGb.value); if (v >= 0) { state.perGb = v; if (state.result) render(); } });
  let lastInput: { input: { file?: File; text?: string }; source: string } | null = null;
  const go = (input: { file?: File; text?: string }, source: string) => { lastInput = { input, source }; run(input, source); };

  const drop = $("#drop") as HTMLElement, picker = $("#picker") as HTMLInputElement;
  picker.addEventListener("change", () => { const f = picker.files?.[0]; if (f) go({ file: f }, f.name); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) go({ file: f }, f.name); });
  $("#paste-go").addEventListener("click", () => { const t = ($("#paste") as HTMLTextAreaElement).value; if (t.trim()) go({ text: t }, "pasted lines"); });
  $("#sample").addEventListener("click", () => {
    robotsBox.value = SAMPLE_ROBOTS; state.robots = SAMPLE_ROBOTS;
    go({ text: sampleLog() }, "the sample day (made up: real crawlers on their published addresses, everyone else on RFC 5737 documentation addresses)");
  });
  ($("#credits") as HTMLElement).textContent = `Agent list: ${DATA.sources.agents.name} (MIT), ${AGENTS.filter((a) => a.ai).length} AI agents. Published crawler addresses from ${Object.keys(DATA.ranges).length} lists — OpenAI, Google, Microsoft, Perplexity, Apple, Common Crawl, DuckDuckGo — ${Object.values(DATA.ranges).reduce((a, r) => a + r.prefixes.length, 0).toLocaleString("en-US")} prefixes, fetched ${DATA.built}.`;
  robotsNotes();
  ($("#sample") as HTMLElement).click();
}
boot();
