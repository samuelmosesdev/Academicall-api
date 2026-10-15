/**
 * Link previews (Open Graph / Twitter cards).
 *
 * When someone pastes an Academicall link into WhatsApp, X, Facebook,
 * LinkedIn, Telegram or Slack, the app fetches the page and reads its
 * <meta> tags. The frontend is a single-page app, so the Firebase Hosting
 * function `ogPage` asks this API what a path is about and writes those
 * tags into the HTML before it's sent.
 *
 *   GET /og/meta?path=/news/<slug>     → { title, description, image, url, ... }
 *   GET /og/image/news/<slug>.png      → 1200×630 branded card (cover, headline, excerpt)
 *   GET /og/image/study/<code>.png     → study-group invite card
 *   GET /og/image/default.png          → Academicall card
 *
 * Everything here is public and shows only what a guest could already see.
 */
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma";

const SITE = (process.env.PUBLIC_SITE_URL || "https://academicall.site").replace(/\/$/, "");
const SITE_NAME = "Academicall";
const DEFAULT_TITLE = "Academicall — your semester, in one place";
const DEFAULT_DESC = "Materials, timetables, study groups, CBT practice and campus news for Nigerian university students.";
const W = 1200;
const H = 630;

// ── assets ──────────────────────────────────────────────────────────────────
const ASSET_DIR = [path.join(__dirname, "../../assets/og"), path.join(process.cwd(), "assets/og")].find((d) => fs.existsSync(d)) || "";
const asset = (f: string) => fs.readFileSync(path.join(ASSET_DIR, f));
let fontsCache: any[] | null = null;
function fonts() {
  if (!fontsCache) {
    fontsCache = [
      { name: "Fraunces", data: asset("fraunces-latin-500-normal.woff"), weight: 500, style: "normal" },
      { name: "Geist", data: asset("geist-sans-latin-500-normal.woff"), weight: 500, style: "normal" },
      { name: "Geist", data: asset("geist-sans-latin-700-normal.woff"), weight: 700, style: "normal" },
    ];
  }
  return fontsCache;
}
let logoUri: string | null = null;
const logo = () => (logoUri ??= `data:image/png;base64,${asset("logo.png").toString("base64")}`);

// ── helpers ─────────────────────────────────────────────────────────────────
const clip = (s: string, n: number) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t;
};
const plain = (md: string) => md.replace(/^#+\s*/gm, "").replace(/^>\s*/gm, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
const stamp = (d?: Date | null) => (d ? d.getTime().toString(36) : "0");

/** Fetch a cover image as a data URI (Cloudinary covers are resized/converted on the fly). */
async function imageData(url?: string | null, opts: { square?: boolean } = {}): Promise<string | null> {
  if (!url || !/^https?:\/\//.test(url)) return null;
  let src = url;
  if (/res\.cloudinary\.com\/.+\/image\/upload\//.test(src) && !/\/upload\/[a-z]_/.test(src)) {
    src = src.replace("/image/upload/", "/image/upload/f_jpg,q_80,w_900,h_900,c_limit/");
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(src, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return null;
    // Normalise any format (WebP, AVIF, PNG, huge JPEGs) to a small JPEG cropped to the card's photo slot.
    const sharp = require("sharp");
    const jpg: Buffer = await sharp(buf, { failOn: "none" }).rotate().resize(opts.square ? 240 : 800, opts.square ? 240 : 1036, { fit: "cover", position: "attention" }).jpeg({ quality: 82 }).toBuffer();
    return `data:image/jpeg;base64,${jpg.toString("base64")}`;
  } catch {
    return null;
  }
}

// tiny element builder for satori
type El = { type: string; props: Record<string, any> };
const h = (type: string, style: Record<string, any>, ...children: any[]): El => ({ type, props: { style: { display: "flex", ...style }, children: children.flat().filter((c) => c !== null && c !== false && c !== undefined) } });
const img = (src: string, style: Record<string, any>): El => ({ type: "img", props: { src, style } });

function frame(body: (El | null)[], { cover, footer }: { cover?: string | null; footer: string }): El {
  return h("div", { width: W, height: H, background: "#0F0326", fontFamily: "Geist", color: "#fff", position: "relative", overflow: "hidden" },
    // glow
    h("div", { position: "absolute", right: -220, top: -260, width: 760, height: 760, borderRadius: 760, background: "radial-gradient(circle, rgba(69,74,222,0.75) 0%, rgba(69,74,222,0) 68%)" }),
    h("div", { position: "absolute", left: -160, bottom: -300, width: 620, height: 620, borderRadius: 620, background: "radial-gradient(circle, rgba(68,255,209,0.22) 0%, rgba(68,255,209,0) 70%)" }),
    h("div", { position: "absolute", left: 0, top: 0, bottom: 0, width: 14, background: "#F8F32B" }),
    h("div", { flexDirection: "column", justifyContent: "space-between", padding: "60px 64px 52px 78px", width: cover ? 720 : W, height: H },
      h("div", { flexDirection: "column" }, ...body.filter(Boolean)),
      h("div", { alignItems: "center", justifyContent: "space-between", width: "100%" },
        img(logo(), { height: 34, width: 177 }),
        h("div", { fontSize: 22, color: "rgba(255,255,255,0.6)" }, footer),
      ),
    ),
    cover ? h("div", { position: "absolute", right: 56, top: 56, width: 400, height: 518, borderRadius: 28, overflow: "hidden", border: "6px solid rgba(255,255,255,0.08)" },
      img(cover, { width: 400, height: 518, objectFit: "cover" }),
    ) : null,
  );
}

const chip = (text: string, bg = "#F8F32B", fg = "#0F0326") => h("div", { alignSelf: "flex-start", background: bg, color: fg, fontSize: 22, fontWeight: 700, padding: "8px 18px", borderRadius: 999, letterSpacing: 0.5 }, text);

async function render(tree: El) {
  const satori = require("satori").default as (el: any, o: any) => Promise<string>;
  const { Resvg } = require("@resvg/resvg-js");
  const svg = await satori(tree, { width: W, height: H, fonts: fonts() });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng() as Buffer;
  // WhatsApp drops previews over ~300 KB; a 1200×630 JPEG at q82 is ~90–180 KB.
  const sharp = require("sharp");
  return (await sharp(png).jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer()) as Buffer;
}

// small in-memory cache: cards are re-requested by every app that unfurls a link
const cache = new Map<string, { png: Buffer; at: number }>();
async function cached(key: string, make: () => Promise<Buffer>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.png;
  const png = await make();
  cache.set(key, { png, at: Date.now() });
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return png;
}
function sendPng(res: Response, png: Buffer) {
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.end(png);
}

// ── data lookups (guest-visible only) ───────────────────────────────────────
async function newsPost(slug: string) {
  return prisma.newsPost.findFirst({
    where: { slug, status: "published" },
    select: { slug: true, title: true, excerpt: true, body: true, coverUrl: true, category: true, publishedAt: true, updatedAt: true, author: { select: { name: true, nickname: true } } },
  });
}
async function studyGroup(code: string) {
  return prisma.studyGroup.findFirst({
    where: { code, archived: false },
    select: { code: true, name: true, description: true, iconUrl: true, scopeType: true, memberCount: true, courseCode: true, level: true, official: true, updatedAt: true },
  });
}

// ── images ──────────────────────────────────────────────────────────────────
function defaultCard(kind: "site" | "news") {
  return frame([
    chip(kind === "news" ? "ACADEMICALL NEWS" : "FOR STUDENTS"),
    h("div", { marginTop: 34, fontFamily: "Fraunces", fontSize: 76, lineHeight: 1.04, letterSpacing: -1.5, maxWidth: 980 }, kind === "news" ? "Campus news, as it happens." : "Your semester, in one place."),
    h("div", { marginTop: 26, fontSize: 30, lineHeight: 1.35, color: "rgba(255,255,255,0.72)", maxWidth: 900 },
      kind === "news" ? "Exams, admissions, scholarships and events from Nigerian campuses." : "Materials, timetables, study groups, CBT practice and campus news."),
  ], { footer: kind === "news" ? "academicall.site/news" : "academicall.site" });
}

export async function defaultImage(req: Request, res: Response) {
  const kind = req.params.kind === "news" ? "news" : "site";
  try { sendPng(res, await cached(`default:${kind}`, () => render(defaultCard(kind)))); } catch (e) { console.error("[og]", e); res.status(500).end(); }
}

type NewsCardInput = { title: string; excerpt?: string | null; body: string; coverUrl?: string | null; category: string; publishedAt?: Date | null; author?: { name?: string | null; nickname?: string | null } | null };
/** Render the 1200×630 card for one story (exported for tests and previews). */
export async function newsCard(post: NewsCardInput) {
  const cover = await imageData(post.coverUrl);
  const title = clip(post.title, cover ? 92 : 120);
  const size = title.length > 70 ? (cover ? 46 : 56) : title.length > 42 ? (cover ? 54 : 66) : cover ? 62 : 76;
  const by = post.author?.name || post.author?.nickname;
  const date = post.publishedAt ? post.publishedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
  return render(frame([
    h("div", { alignItems: "center", gap: 14 },
      chip(post.category.toUpperCase()),
      h("div", { fontSize: 22, color: "rgba(255,255,255,0.6)" }, [by, date].filter(Boolean).join("  ·  ")),
    ),
    h("div", { marginTop: 30, fontFamily: "Fraunces", fontSize: size, lineHeight: 1.08, letterSpacing: -1, maxWidth: cover ? 600 : 1000 }, title),
    h("div", { marginTop: 22, fontSize: 25, lineHeight: 1.4, color: "#BFFBEA", maxWidth: cover ? 590 : 960 }, clip(post.excerpt || plain(post.body), cover ? 120 : 170)),
  ], { cover, footer: "academicall.site/news" }));
}

type StudyCardInput = { name: string; memberCount: number; courseCode?: string | null; level?: string | null; official?: boolean; iconUrl?: string | null };
export async function studyCard(g: StudyCardInput) {
  const icon = await imageData(g.iconUrl, { square: true });
  return render(frame([
    icon ? img(icon, { width: 96, height: 96, borderRadius: 24, marginBottom: 26 }) : null,
    chip(g.official ? "OFFICIAL STUDY GROUP" : "STUDY GROUP INVITE", "#44FFD1"),
    h("div", { marginTop: 34, fontSize: 30, color: "rgba(255,255,255,0.72)" }, "You're invited to join"),
    h("div", { marginTop: 10, fontFamily: "Fraunces", fontSize: g.name.length > 34 ? 62 : 78, lineHeight: 1.05, letterSpacing: -1.5, maxWidth: 1000 }, clip(g.name, 60)),
    h("div", { marginTop: 26, gap: 14 },
      h("div", { fontSize: 26, padding: "10px 20px", borderRadius: 16, background: "rgba(255,255,255,0.08)" }, `${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`),
      g.courseCode ? h("div", { fontSize: 26, padding: "10px 20px", borderRadius: 16, background: "rgba(255,255,255,0.08)" }, g.courseCode) : null,
      g.level ? h("div", { fontSize: 26, padding: "10px 20px", borderRadius: 16, background: "rgba(255,255,255,0.08)" }, g.level) : null,
    ),
  ], { footer: "Join on academicall.site" }));
}
export const defaultCardPng = (kind: "site" | "news") => render(defaultCard(kind));

export async function newsImage(req: Request, res: Response) {
  const slug = String(req.params.slug).replace(/\.(png|jpe?g)$/i, "");
  try {
    const post = await newsPost(slug);
    if (!post) return sendPng(res, await cached("default:news", () => render(defaultCard("news"))));
    const png = await cached(`news:${slug}:${stamp(post.updatedAt)}`, () => newsCard(post));
    sendPng(res, png);
  } catch (e) {
    console.error("[og] news image", e);
    res.status(500).end();
  }
}

export async function studyImage(req: Request, res: Response) {
  const code = String(req.params.code).replace(/\.(png|jpe?g)$/i, "");
  try {
    const g = await studyGroup(code);
    if (!g) return sendPng(res, await cached("default:site", () => render(defaultCard("site"))));
    const png = await cached(`study:${code}:${stamp(g.updatedAt)}`, () => studyCard(g));
    sendPng(res, png);
  } catch (e) {
    console.error("[og] study image", e);
    res.status(500).end();
  }
}

// ── meta ────────────────────────────────────────────────────────────────────
export type OgMeta = { title: string; description: string; image: string; imageAlt: string; url: string; type: string; siteName: string; publishedTime?: string; author?: string; section?: string };

export async function metaFor(rawPath: string): Promise<OgMeta> {
  const p = ("/" + String(rawPath || "/").split("?")[0].replace(/^\/+/, "")).replace(/\/+$/, "") || "/";
  const base: OgMeta = { title: DEFAULT_TITLE, description: DEFAULT_DESC, image: `${SITE}/og/default.jpg`, imageAlt: "Academicall", url: SITE + (p === "/" ? "/" : p), type: "website", siteName: SITE_NAME };

  let m = /^\/news\/([^/]+)$/.exec(p);
  if (m && m[1] !== "desk") {
    const post = await newsPost(decodeURIComponent(m[1]));
    if (post) {
      return {
        ...base,
        title: `${post.title} · Academicall News`,
        description: clip(post.excerpt || plain(post.body), 200),
        image: `${SITE}/og/news/${encodeURIComponent(post.slug)}.jpg?v=${stamp(post.updatedAt)}`,
        imageAlt: post.title,
        type: "article",
        publishedTime: post.publishedAt?.toISOString(),
        author: post.author?.name || post.author?.nickname || undefined,
        section: post.category,
      };
    }
  }
  if (p === "/news" || p.startsWith("/news/")) {
    return { ...base, title: "Academicall News — campus news, as it happens", description: "Exams, admissions, scholarships and events from Nigerian campuses. Read free; sign in to comment and react.", image: `${SITE}/og/default-news.jpg`, imageAlt: "Academicall News", url: `${SITE}/news` };
  }
  m = /^\/(?:study|dashboard\/groups\/join)\/([A-Za-z0-9]{6,12})$/.exec(p);
  if (m) {
    const g = await studyGroup(m[1]);
    if (g) {
      // Invite links are made to be shared: name, size and icon are public. The description is
      // only shown for open groups; department/course-scoped groups get a neutral line instead.
      const members = `${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`;
      const desc = g.scopeType === "open" && g.description
        ? clip(g.description, 200)
        : `A study group on Academicall with ${members}${g.courseCode ? ` for ${g.courseCode}` : ""}. Tap to ask to join.`;
      return {
        ...base,
        title: `Join “${g.name}” on Academicall`,
        description: desc,
        image: `${SITE}/og/study/${g.code}.jpg?v=${stamp(g.updatedAt)}`,
        imageAlt: `Invitation to ${g.name}`,
        url: `${SITE}/study/${g.code}`,
      };
    }
    return { ...base, title: "Study group invite · Academicall", description: "This invite link is no longer active.", url: `${SITE}/study/${m[1]}` };
  }
  // Group conversations are members-only: never describe them publicly.
  if (/^\/dashboard\/groups(\/|$)/.test(p)) {
    return { ...base, title: "Study groups · Academicall", description: "Sign in to open this study group conversation.", url: `${SITE}/dashboard/groups` };
  }
  const STATIC: Record<string, [string, string]> = {
    "/": [DEFAULT_TITLE, DEFAULT_DESC],
    "/signup": ["Create your Academicall account", "Join free with your school email. Courses, materials, study groups and CBT practice for your programme."],
    "/login": ["Sign in · Academicall", DEFAULT_DESC],
    "/privacy": ["Privacy policy · Academicall", "How Academicall collects, uses and protects your information."],
  };
  if (STATIC[p]) return { ...base, title: STATIC[p][0], description: STATIC[p][1] };
  if (p.startsWith("/dashboard") || p.startsWith("/admin") || p.startsWith("/agent") || p.startsWith("/secretariat")) {
    return { ...base, title: "Academicall", description: "Sign in to continue.", url: SITE + "/" };
  }
  return base;
}

export async function meta(req: Request, res: Response) {
  try {
    const out = await metaFor(String(req.query.path || "/"));
    res.setHeader("Cache-Control", "public, max-age=120, s-maxage=600");
    res.json(out);
  } catch (e) {
    console.error("[og] meta", e);
    res.status(500).json({ error: "meta failed" });
  }
}
