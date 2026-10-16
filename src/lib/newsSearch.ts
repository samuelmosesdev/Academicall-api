/**
 * News search that understands what readers mean, not just what they type.
 *
 *  - Ranks stories by where the words hit (headline > tags > category > standfirst > body) and how recent they are.
 *  - Knows the words Nigerian students use for the same thing (JAMB = UTME, bursary = scholarship, ASUU = strike…).
 *  - Forgives typos ("admision", "scholaship") and completes half-typed words as the reader types.
 *  - Optional quiet assist: when GEMINI_API_KEY is set and the local index finds little, a language model
 *    suggests related keywords in the background. Readers only ever see better results; nothing is labelled.
 *
 * The index is built in memory from the most recent published stories and refreshed every minute
 * (or straight away after a story is published, edited or taken down).
 */
import { prisma } from "./prisma";

type Doc = {
  id: string; slug: string; title: string; excerpt: string; category: string; tags: string[]; author: string; publishedAt: Date;
  titleT: Set<string>; tagT: Set<string>; catT: Set<string>; exT: Set<string>; bodyT: Set<string>; titleRaw: string;
};

const SYNONYMS: string[][] = [
  ["jamb", "utme"],
  ["postutme", "post-utme", "screening", "aptitude"],
  ["admission", "admissions", "admitted", "admit", "merit", "caps"],
  ["scholarship", "scholarships", "bursary", "grant", "award", "funding"],
  ["strike", "asuu", "ssanu", "industrial"],
  ["exam", "exams", "examination", "examinations", "test", "cbt"],
  ["result", "results", "score", "scores", "grade", "grades", "cgpa", "gpa"],
  ["fees", "fee", "tuition", "levy", "charges"],
  ["hostel", "hostels", "accommodation", "lodge"],
  ["resumption", "resume", "resumes", "calendar", "session", "semester"],
  ["nysc", "corps", "youth"],
  ["convocation", "graduation", "graduates", "matriculation"],
  ["sport", "sports", "football", "nugames"],
  ["tech", "technology", "ict", "coding", "ai"],
  ["loan", "loans", "nelfund", "studentloan"],
  ["waec", "neco", "ssce", "olevel"],
  ["cutoff", "cut-off", "mark", "marks"],
];
const STOP = new Set("a an and are as at be by for from has have in is it its of on or that the to was were will with this these those your you our we how what when who why".split(" "));

const syn = new Map<string, string[]>();
for (const group of SYNONYMS) for (const w of group) syn.set(normWord(w), group.map(normWord));

function normWord(w: string) {
  return w.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}
function stem(w: string) {
  if (w.length <= 4) return w;
  return w.replace(/(ings|ing|edly|ed|ies|es|s)$/u, (m) => (m === "ies" ? "y" : "")) || w;
}
export function tokens(text: string) {
  return (text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/post[\s-]+utme/g, "postutme")
    .replace(/cut[\s-]+off/g, "cutoff")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOP.has(t));
}
const tset = (text: string) => new Set(tokens(text).flatMap((t) => [t, stem(t)]));

let docs: Doc[] = [];
let vocab = new Map<string, number>(); // word -> frequency (titles + tags weigh more)
let builtAt = 0;
let building: Promise<void> | null = null;

export function invalidateNewsIndex() {
  builtAt = 0;
}

async function build() {
  const rows = await prisma.newsPost.findMany({
    where: { status: "published" },
    orderBy: { publishedAt: "desc" },
    take: 3000,
    select: { id: true, slug: true, title: true, excerpt: true, body: true, category: true, tags: true, publishedAt: true, author: { select: { name: true } } },
  });
  const v = new Map<string, number>();
  const bump = (w: string, n: number) => w.length > 1 && v.set(w, (v.get(w) || 0) + n);
  docs = rows.map((r) => {
    const titleT = tset(r.title);
    const tagT = tset((r.tags || []).join(" "));
    tokens(r.title).forEach((w) => bump(w, 3));
    (r.tags || []).forEach((t) => tokens(t).forEach((w) => bump(w, 3)));
    tokens(r.excerpt || "").forEach((w) => bump(w, 1));
    return {
      id: r.id, slug: r.slug, title: r.title, titleRaw: r.title.toLowerCase(), excerpt: r.excerpt || "", category: r.category, tags: r.tags || [], author: r.author?.name || "",
      publishedAt: r.publishedAt || new Date(0),
      titleT, tagT, catT: tset(r.category), exT: tset(r.excerpt || ""), bodyT: tset((r.body || "").slice(0, 4000)),
    };
  });
  vocab = v;
  builtAt = Date.now();
}

async function ensureIndex() {
  if (Date.now() - builtAt < 60_000 && docs.length) return;
  if (!building) building = build().finally(() => { building = null; });
  await building;
}

function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let rowMin = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      rowMin = Math.min(rowMin, prev[j]);
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

/** Closest known word for a typo, or null. */
function correct(word: string) {
  if (vocab.has(word) || word.length < 4) return null;
  const max = word.length > 6 ? 2 : 1;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [w, f] of vocab) {
    if (Math.abs(w.length - word.length) > max) continue;
    const d = editDistance(word, w, max);
    if (d <= max) {
      const score = d * 100 - f;
      if (score < bestScore) { bestScore = score; best = w; }
    }
  }
  return best;
}

type Term = { word: string; weight: number; prefix?: boolean };

function expand(q: string, extra: string[] = []): { terms: Term[][]; corrected: string | null } {
  const words = tokens(q);
  let changed = false;
  const corrected: string[] = [];
  const groups: Term[][] = words.map((w, i) => {
    const isLast = i === words.length - 1 && !/\s$/.test(q);
    const fix = correct(w);
    const base = fix && !(isLast && [...vocab.keys()].some((v) => v.startsWith(w))) ? fix : w;
    if (base !== w) changed = true;
    corrected.push(base);
    const out: Term[] = [{ word: base, weight: 1, prefix: isLast }, { word: stem(base), weight: 0.95 }];
    for (const s of syn.get(base) || syn.get(stem(base)) || []) if (s !== base) out.push({ word: s, weight: 0.8 });
    return out;
  });
  if (extra.length) groups.push(extra.flatMap((e) => tokens(e)).slice(0, 8).map((word) => ({ word, weight: 0.45 })));
  return { terms: groups, corrected: changed ? corrected.join(" ") : null };
}

function hit(set: Set<string>, t: Term) {
  if (set.has(t.word)) return 1;
  if (t.prefix && t.word.length >= 2) for (const w of set) if (w.startsWith(t.word)) return 0.85;
  return 0;
}

function scoreDoc(d: Doc, groups: Term[][], phrase: string) {
  let total = 0;
  let matchedGroups = 0;
  for (const group of groups) {
    let best = 0;
    for (const t of group) {
      const s = t.weight * Math.max(5 * hit(d.titleT, t), 4 * hit(d.tagT, t), 3 * hit(d.catT, t), 2 * hit(d.exT, t), 1 * hit(d.bodyT, t));
      if (s > best) best = s;
    }
    if (best > 0) matchedGroups++;
    total += best;
  }
  if (!total) return 0;
  const coverage = matchedGroups / groups.length;
  if (groups.length > 1 && coverage < 0.5) return 0;
  const ageDays = (Date.now() - d.publishedAt.getTime()) / 864e5;
  const recency = 1 + 0.6 * Math.exp(-ageDays / 21);
  const phraseBoost = phrase.length > 3 && d.titleRaw.includes(phrase) ? 4 : 0;
  return (total * coverage + phraseBoost) * recency;
}

// ── quiet assist (optional) ──────────────────────────────────────────────────
const assistCache = new Map<string, { at: number; terms: string[] }>();
async function assistTerms(q: string): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || q.length < 3) return [];
  const k = q.toLowerCase().trim();
  const cached = assistCache.get(k);
  if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.terms;
  const model = process.env.NEWS_ASSIST_MODEL || "gemini-2.0-flash";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `A Nigerian student is searching campus news for: "${q}". Reply with only a JSON array of up to 6 short search keywords (single words, lowercase) that news headlines about this would use. No prose.` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 60 },
      }),
    });
    const j: any = await r.json();
    const text: string = j?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const terms = (JSON.parse(text.replace(/```json|```/g, "").trim()) as unknown[]).map(String).map((s) => s.toLowerCase().slice(0, 30)).slice(0, 6);
    assistCache.set(k, { at: Date.now(), terms });
    if (assistCache.size > 2000) assistCache.delete(assistCache.keys().next().value as string);
    return terms;
  } catch {
    assistCache.set(k, { at: Date.now(), terms: [] });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Ranked story ids for a query (all matches, best first). */
export async function searchNews(q: string, opts: { category?: string } = {}) {
  await ensureIndex();
  const phrase = q.toLowerCase().trim();
  const pool = opts.category ? docs.filter((d) => d.category === opts.category) : docs;
  let { terms, corrected } = expand(q);
  if (!terms.length) return { ids: [] as string[], corrected: null };
  let ranked = pool.map((d) => ({ d, s: scoreDoc(d, terms, phrase) })).filter((x) => x.s > 0);
  if (ranked.length < 3) {
    const extra = await assistTerms(q);
    if (extra.length) {
      ({ terms } = expand(q, extra));
      const more = pool.map((d) => ({ d, s: scoreDoc(d, terms.slice(-1), phrase) * 0.6 })).filter((x) => x.s > 0);
      const seen = new Set(ranked.map((x) => x.d.id));
      ranked = [...ranked, ...more.filter((x) => !seen.has(x.d.id))];
    }
  }
  ranked.sort((a, b) => b.s - a.s || +b.d.publishedAt - +a.d.publishedAt);
  return { ids: ranked.map((x) => x.d.id), corrected };
}

const DISPLAY: Record<string, string> = { postutme: "post-utme", cutoff: "cut-off" };
const show = (w: string) => w.split(" ").map((x) => DISPLAY[x] || x).join(" ");

/** As-you-type suggestions: matching headlines, word completions and a typo fix. */
export async function suggestNews(q: string) {
  await ensureIndex();
  const query = q.trim();
  if (!query) {
    const popular = [...vocab.entries()].filter(([w]) => w.length > 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => show(w));
    return { stories: [], terms: popular, corrected: null };
  }
  const { ids, corrected } = await searchNews(query);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const stories = ids.slice(0, 6).map((id) => byId.get(id)!).map((d) => ({ id: d.id, slug: d.slug, title: d.title, category: d.category, publishedAt: d.publishedAt }));
  const words = tokens(query);
  const last = words[words.length - 1] || "";
  const head = words.slice(0, -1).join(" ");
  const completions = last.length >= 1
    ? [...vocab.entries()].filter(([w]) => w.startsWith(last) && w !== last).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => show(head ? `${head} ${w}` : w))
    : [];
  return { stories, terms: completions, corrected: corrected && corrected !== words.join(" ") ? show(corrected) : null };
}
