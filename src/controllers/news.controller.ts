/**
 * Academicall News — public campus news written by News Agents.
 *
 *  - Anyone (signed in or not) can browse headlines and read a preview.
 *  - Signed-in users read the full story, react, and comment.
 *  - People with the News duty (staffTags "news", given by an admin or Alpha Agent) and admins write,
 *    publish, edit and remove stories, and can moderate comments.
 */
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { canWriteNews, isNewsChief } from "../lib/access";
import { audit } from "../lib/audit";
import { notifyMany } from "../lib/notify";
import { publishToUsers } from "../lib/realtime";
import { invalidateNewsIndex, searchNews, suggestNews } from "../lib/newsSearch";

export const NEWS_CATEGORIES = ["Campus", "Admissions", "Exams", "Scholarships", "Sports", "Tech", "Opinion", "Events"] as const;
export const REACTIONS = ["like", "love", "fire", "clap", "wow"] as const;
const GUEST_PREVIEW_CHARS = 650;

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message || "Invalid input" });
    console.error("[news]", err);
    return res.status(500).json({ error: "Something went wrong loading the news" });
  }
};

/** Attach req.user when a valid bearer token is present; never rejects. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET || "dev-secret") as { sub: string };
      const user = await prisma.user.findUnique({ where: { id: decoded.sub }, select: { id: true, email: true, role: true, status: true, staffTags: true, name: true } });
      if (user && user.status === "active") req.user = { id: user.id, email: user.email, role: user.role, staffTags: user.staffTags, name: user.name } as any;
    } catch { /* treat as guest */ }
  }
  next();
}

export function requireNewsDesk(req: Request, res: Response, next: NextFunction) {
  if (!canWriteNews(req.user)) return res.status(403).json({ error: "Only News Agents can do that" });
  next();
}

const authorSelect = { id: true, name: true, nickname: true, photoUrl: true, avatarUrl: true, role: true, staffTags: true } as const;
function authorOut(a: any) {
  if (!a) return { name: "Academicall News", photoUrl: null };
  return { id: a.id, name: a.name || a.nickname || "Academicall News", photoUrl: a.photoUrl || a.avatarUrl || null, role: a.role, newsTeam: canWriteNews(a), chief: (a.staffTags || []).includes("newsChief") };
}
const words = (s: string) => (s.trim().match(/\S+/g) || []).length;
const readMinutes = (body: string) => Math.max(1, Math.round(words(body) / 220));
function excerptOf(body: string) {
  const plain = body.replace(/^#+\s*/gm, "").replace(/^>\s*/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 180 ? `${plain.slice(0, 177).replace(/\s+\S*$/, "")}…` : plain;
}
/** First few paragraphs, about GUEST_PREVIEW_CHARS long, always cut on a paragraph boundary. */
export function previewOf(body: string) {
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return "";
  const out: string[] = [];
  let len = 0;
  const limit = blocks.length === 1
    ? Math.min(GUEST_PREVIEW_CHARS, Math.max(60, Math.floor(blocks[0].length * 0.65)))
    : GUEST_PREVIEW_CHARS;
  for (const b of blocks) {
    if (out.length >= 1 && len + b.length > GUEST_PREVIEW_CHARS) break;
    if (!out.length && b.length > limit) {
      const slice = b.slice(0, limit);
      out.push(`${slice.slice(0, slice.lastIndexOf(" ") > 0 ? slice.lastIndexOf(" ") : slice.length).trimEnd()}…`);
      break;
    }
    out.push(b);
    len += b.length;
    if (out.length >= 3) break;
  }
  if (out.length >= blocks.length && blocks.length > 1) out.pop(); // never give the whole story away
  return out.join("\n\n");
}
function slugify(title: string) {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 70).replace(/-+$/, "");
  return `${base || "story"}-${randomBytes(3).toString("hex")}`;
}

async function reactionSummary(postIds: string[], userId?: string) {
  if (!postIds.length) return { counts: new Map<string, Record<string, number>>(), mine: new Map<string, string>() };
  const grouped = await prisma.newsReaction.groupBy({ by: ["postId", "type"], where: { postId: { in: postIds } }, _count: true });
  const counts = new Map<string, Record<string, number>>();
  for (const g of grouped) {
    const c = counts.get(g.postId) || {};
    c[g.type] = g._count;
    counts.set(g.postId, c);
  }
  const mine = new Map<string, string>();
  if (userId) {
    const rows = await prisma.newsReaction.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true, type: true } });
    rows.forEach((r) => mine.set(r.postId, r.type));
  }
  return { counts, mine };
}

function cardOut(p: any, r: { counts: Map<string, Record<string, number>>; mine: Map<string, string> }) {
  const reactions = r.counts.get(p.id) || {};
  return {
    id: p.id, slug: p.slug, title: p.title, excerpt: p.excerpt || excerptOf(p.body), coverUrl: p.coverUrl, category: p.category,
    status: p.status, publishedAt: p.publishedAt, updatedAt: p.updatedAt, readMinutes: readMinutes(p.body),
    tags: p.tags || [], audience: p.audience || null, moderationNote: p.moderationNote || null,
    commentCount: p.commentCount, viewCount: p.viewCount,
    reactions, reactionTotal: Object.values(reactions).reduce((a, b) => a + b, 0), myReaction: r.mine.get(p.id) || null,
    author: authorOut(p.author),
  };
}

// ── public ────────────────────────────────────────────────────────────────────
export const listNews = handle(async (req, res) => {
  const category = typeof req.query.category === "string" && req.query.category !== "All" ? req.query.category : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const take = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
  const cursor = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
  if (q) {
    // Ranked, typo-tolerant search over the in-memory index; pages by offset.
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { ids, corrected } = await searchNews(q, { category });
    const slice = ids.slice(offset, offset + take);
    const rows = slice.length ? await prisma.newsPost.findMany({ where: { id: { in: slice }, status: "published" }, include: { author: { select: authorSelect } } }) : [];
    const order = new Map(slice.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const r = await reactionSummary(rows.map((p) => p.id), req.user?.id);
    return res.json({
      posts: rows.map((p) => cardOut(p, r)), total: ids.length, corrected,
      nextBefore: null, nextOffset: offset + take < ids.length ? offset + take : null,
      categories: NEWS_CATEGORIES, viewer: { signedIn: !!req.user, canWrite: canWriteNews(req.user) },
    });
  }
  const posts = await prisma.newsPost.findMany({
    where: {
      status: "published",
      ...(category ? { category } : {}),
      ...(cursor && !isNaN(+cursor) ? { publishedAt: { lt: cursor } } : {}),
    },
    orderBy: { publishedAt: "desc" },
    take: take + 1,
    include: { author: { select: authorSelect } },
  });
  const page = posts.slice(0, take);
  const r = await reactionSummary(page.map((p) => p.id), req.user?.id);
  res.json({
    posts: page.map((p) => cardOut(p, r)),
    nextBefore: posts.length > take ? page[page.length - 1].publishedAt : null,
    categories: NEWS_CATEGORIES,
    viewer: { signedIn: !!req.user, canWrite: canWriteNews(req.user), chief: isNewsChief(req.user) },
  });
});

export const getNews = handle(async (req, res) => {
  const post = await prisma.newsPost.findUnique({ where: { slug: String(req.params.slug) }, include: { author: { select: authorSelect } } });
  const staffView = post && (isNewsChief(req.user) || (canWriteNews(req.user) && post.authorId === req.user?.id));
  if (!post || (post.status !== "published" && !staffView)) throw new HttpError(404, "This story isn't available");
  if (post.status === "published") prisma.newsPost.update({ where: { id: post.id }, data: { viewCount: { increment: 1 } } }).catch(() => {});
  const r = await reactionSummary([post.id], req.user?.id);
  const signedIn = !!req.user;
  const related = await prisma.newsPost.findMany({
    where: { status: "published", id: { not: post.id }, category: post.category },
    orderBy: { publishedAt: "desc" }, take: 3, include: { author: { select: authorSelect } },
  });
  const rr = await reactionSummary(related.map((p) => p.id));
  res.json({
    post: { ...cardOut(post, r), body: signedIn ? post.body : previewOf(post.body), gated: !signedIn },
    related: related.map((p) => cardOut(p, rr)),
    viewer: { signedIn, canWrite: canWriteNews(req.user), canModerate: canWriteNews(req.user) },
  });
});

export const listComments = handle(async (req, res) => {
  const post = await prisma.newsPost.findFirst({ where: { id: String(req.params.id), status: "published" }, select: { id: true, commentCount: true } });
  if (!post) throw new HttpError(404, "This story isn't available");
  const signedIn = !!req.user;
  const rows = await prisma.newsComment.findMany({
    where: { postId: post.id, deletedAt: null },
    orderBy: { createdAt: signedIn ? "asc" : "desc" },
    take: signedIn ? 200 : 2,
    include: { user: { select: authorSelect } },
  });
  const list = signedIn ? rows : rows.reverse();
  res.json({
    total: post.commentCount,
    gated: !signedIn,
    comments: list.map((c) => ({
      id: c.id, body: c.body, createdAt: c.createdAt, author: authorOut(c.user),
      mine: c.userId === req.user?.id, canDelete: c.userId === req.user?.id || canWriteNews(req.user),
    })),
  });
});

// ── signed-in readers ────────────────────────────────────────────────────────
const recentComments = new Map<string, number[]>();
function commentRateLimited(userId: string) {
  const now = Date.now();
  const hits = (recentComments.get(userId) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  recentComments.set(userId, hits);
  return hits.length > 6;
}

export const addComment = handle(async (req, res) => {
  const body = z.object({ body: z.string().trim().min(1, "Write something first").max(1000, "Keep comments under 1,000 characters") }).parse(req.body || {});
  const post = await prisma.newsPost.findFirst({ where: { id: String(req.params.id), status: "published" }, select: { id: true } });
  if (!post) throw new HttpError(404, "This story isn't available");
  if (commentRateLimited(req.user!.id)) throw new HttpError(429, "You're commenting too fast. Take a breath and try again.");
  const [comment] = await prisma.$transaction([
    prisma.newsComment.create({ data: { postId: post.id, userId: req.user!.id, body: body.body }, include: { user: { select: authorSelect } } }),
    prisma.newsPost.update({ where: { id: post.id }, data: { commentCount: { increment: 1 } } }),
  ]);
  res.status(201).json({ comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt, author: authorOut(comment.user), mine: true, canDelete: true } });
});

export const deleteComment = handle(async (req, res) => {
  const c = await prisma.newsComment.findUnique({ where: { id: String(req.params.commentId) } });
  if (!c || c.deletedAt) throw new HttpError(404, "Comment not found");
  if (c.userId !== req.user!.id && !canWriteNews(req.user)) throw new HttpError(403, "You can only delete your own comments");
  await prisma.$transaction([
    prisma.newsComment.update({ where: { id: c.id }, data: { deletedAt: new Date() } }),
    prisma.newsPost.update({ where: { id: c.postId }, data: { commentCount: { decrement: 1 } } }),
  ]);
  res.json({ ok: true });
});

export const react = handle(async (req, res) => {
  const { type } = z.object({ type: z.enum(REACTIONS).nullable() }).parse(req.body || {});
  const post = await prisma.newsPost.findFirst({ where: { id: String(req.params.id), status: "published" }, select: { id: true } });
  if (!post) throw new HttpError(404, "This story isn't available");
  const key = { postId_userId: { postId: post.id, userId: req.user!.id } };
  if (!type) await prisma.newsReaction.deleteMany({ where: { postId: post.id, userId: req.user!.id } });
  else await prisma.newsReaction.upsert({ where: key, create: { postId: post.id, userId: req.user!.id, type }, update: { type } });
  const r = await reactionSummary([post.id], req.user!.id);
  const reactions = r.counts.get(post.id) || {};
  res.json({ reactions, reactionTotal: Object.values(reactions).reduce((a, b) => a + b, 0), myReaction: r.mine.get(post.id) || null });
});

// ── news desk ─────────────────────────────────────────────────────────────────
const postSchema = z.object({
  title: z.string().trim().min(8, "Headlines need at least 8 characters").max(140, "Keep the headline under 140 characters"),
  body: z.string().trim().min(80, "The story needs at least a short paragraph (80+ characters)").max(40_000),
  excerpt: z.string().trim().max(240).optional().nullable(),
  coverUrl: z.string().trim().url("Cover image must be a link").refine((u) => /^https:\/\//.test(u) || process.env.NODE_ENV !== "production", "Cover image must be https").optional().nullable(),
  category: z.enum(NEWS_CATEGORIES).default("Campus"),
  status: z.enum(["draft", "published"]).default("draft"),
  tags: z.array(z.string().trim().toLowerCase().min(2).max(30)).max(8).optional(),
  audience: z.object({
    groups: z.array(z.enum(["students", "aspirants", "staff"])).max(3).optional(),
    institutionIds: z.array(z.string()).max(20).optional(),
    levels: z.array(z.string().max(20)).max(8).optional(),
  }).nullable().optional(),
});

/** Restricted News Agents' stories go to the Chief for approval; suspended ones can't post. */
async function deskStanding(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { newsStatus: true, newsStatusReason: true, staffTags: true, role: true } });
  if (!u) throw new HttpError(401, "Sign in again");
  if (u.role !== "admin" && !(u.staffTags || []).includes("newsChief")) {
    if (u.newsStatus === "suspended") throw new HttpError(403, `Your News desk access is suspended${u.newsStatusReason ? `: ${u.newsStatusReason}` : ""}. Contact the Chief News Agent.`, "news_suspended");
    return u.newsStatus === "restricted" ? "restricted" : "active";
  }
  return "active";
}
const cleanAudience = (a: any) => {
  if (!a) return null;
  const out = { groups: a.groups?.length ? a.groups : undefined, institutionIds: a.institutionIds?.length ? a.institutionIds : undefined, levels: a.levels?.length ? a.levels : undefined };
  return out.groups || out.institutionIds || out.levels ? out : null;
};

export const deskList = handle(async (req, res) => {
  const mineOnly = !isNewsChief(req.user) || req.query.mine === "1";
  const posts = await prisma.newsPost.findMany({
    where: mineOnly ? { authorId: req.user!.id } : {},
    orderBy: { updatedAt: "desc" }, take: 100, include: { author: { select: authorSelect } },
  });
  const r = await reactionSummary(posts.map((p) => p.id));
  const me = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { newsStatus: true, newsStatusReason: true } });
  res.json({ posts: posts.map((p) => ({ ...cardOut(p, r), body: p.body, excerpt: p.excerpt })), categories: NEWS_CATEGORIES, standing: me, chief: isNewsChief(req.user) });
});

export const createPost = handle(async (req, res) => {
  const standing = await deskStanding(req.user!.id);
  const body = postSchema.parse(req.body || {});
  const status = body.status === "published" && standing === "restricted" ? "review" : body.status;
  const post = await prisma.newsPost.create({
    data: {
      ...body, status, audience: cleanAudience(body.audience) ?? undefined, tags: [...new Set(body.tags || [])],
      excerpt: body.excerpt || null, coverUrl: body.coverUrl || null, slug: slugify(body.title), authorId: req.user!.id, publishedAt: status === "published" ? new Date() : null,
    },
    include: { author: { select: authorSelect } },
  });
  if (status === "published") await afterPublish(post);
  if (status === "review") await askChiefs(post, req.user!.name);
  res.status(201).json({ post: { ...cardOut(post, { counts: new Map(), mine: new Map() }), body: post.body }, review: status === "review" });
});

async function editable(req: Request) {
  const post = await prisma.newsPost.findUnique({ where: { id: String(req.params.id) } });
  if (!post) throw new HttpError(404, "Story not found");
  if (!isNewsChief(req.user) && post.authorId !== req.user!.id) throw new HttpError(403, "You can only edit stories you wrote");
  if (post.status === "hidden" && !isNewsChief(req.user)) throw new HttpError(403, "The Chief News Agent took this story down. Ask them to restore it.");
  return post;
}

export const updatePost = handle(async (req, res) => {
  const post = await editable(req);
  const standing = await deskStanding(req.user!.id);
  const body = postSchema.partial().parse(req.body || {});
  let status: string | undefined = body.status;
  if (status === "published" && standing === "restricted" && post.status !== "published") status = "review";
  const publishing = status === "published" && post.status !== "published";
  const firstTime = publishing && !post.publishedAt;
  const { audience, tags, ...rest } = body;
  const updated = await prisma.newsPost.update({
    where: { id: post.id },
    data: {
      ...rest, ...(status ? { status } : {}),
      ...(audience !== undefined ? { audience: cleanAudience(audience) ?? Prisma.JsonNull } : {}),
      ...(tags ? { tags: [...new Set(tags)] } : {}),
      ...(publishing ? { publishedAt: new Date() } : {}), ...(status === "draft" || status === "review" ? { publishedAt: null } : {}),
    },
    include: { author: { select: authorSelect } },
  });
  if (publishing && firstTime) await afterPublish(updated); else invalidateNewsIndex();
  if (status === "review" && post.status !== "review") await askChiefs(updated, req.user!.name);
  const r = await reactionSummary([updated.id]);
  res.json({ post: { ...cardOut(updated, r), body: updated.body }, review: status === "review" });
});

export const deletePost = handle(async (req, res) => {
  const post = await editable(req);
  await prisma.newsPost.delete({ where: { id: post.id } });
  invalidateNewsIndex();
  res.json({ ok: true });
});

// ── delivery: subscribers + the audience the publisher picked ────────────────
type Audience = { groups?: string[]; institutionIds?: string[]; levels?: string[] } | null;
const GROUP_ROLES: Record<string, string[]> = { students: ["user", "courseRep", "newsAgent"], aspirants: ["aspirant"], staff: ["admin", "alphaAgent", "agent"] };

function audienceWhere(a: Audience): Prisma.UserWhereInput | null {
  if (!a || (!a.groups?.length && !a.institutionIds?.length && !a.levels?.length)) return null;
  const and: Prisma.UserWhereInput[] = [];
  if (a.groups?.length) and.push({ role: { in: a.groups.flatMap((g) => GROUP_ROLES[g] || []) as any } });
  if (a.institutionIds?.length) and.push({ OR: [{ institutionId: { in: a.institutionIds } }, { aspirations: { some: { institutionId: { in: a.institutionIds } } } }] });
  if (a.levels?.length) and.push({ level: { in: a.levels } });
  return { AND: and };
}

function viewerMatches(a: Audience, v: { role: string; institutionId?: string | null; level?: string | null; aspirationIds: string[] }) {
  if (!a) return false;
  if (a.groups?.length && !a.groups.some((g) => (GROUP_ROLES[g] || []).includes(v.role))) return false;
  if (a.institutionIds?.length && !a.institutionIds.some((id) => id === v.institutionId || v.aspirationIds.includes(id))) return false;
  if (a.levels?.length && !a.levels.includes(String(v.level || ""))) return false;
  return !!(a.groups?.length || a.institutionIds?.length || a.levels?.length);
}

/** Who gets a new story the moment it drops. */
async function recipientsFor(post: { id: string; title: string; category: string; tags: string[]; authorId: string | null; audience: any }) {
  const audience = post.audience as Audience;
  const haystack = ` ${tokensLower(post.title)} ${post.tags.join(" ")} `;
  const topicValues = (await prisma.newsSubscription.groupBy({ by: ["value"], where: { kind: "topic" } })).map((t) => t.value).filter((v) => haystack.includes(` ${v} `) || post.tags.includes(v));
  const subs = await prisma.newsSubscription.findMany({
    where: {
      OR: [
        { kind: "category", value: post.category },
        ...(topicValues.length ? [{ kind: "topic", value: { in: topicValues } }] : []),
        ...(post.authorId ? [{ kind: "author", value: post.authorId }] : []),
        ...(audience?.institutionIds?.length ? [{ kind: "institution", value: { in: audience.institutionIds } }] : []),
      ],
      user: { status: "active" },
    },
    select: { userId: true },
    take: 20_000,
  });
  const ids = new Set(subs.map((s) => s.userId));
  const subscribed = new Set(ids);
  const where = audienceWhere(audience);
  if (where) {
    const people = await prisma.user.findMany({ where: { ...where, status: "active", newsAlerts: true }, select: { id: true }, take: 5000 });
    people.forEach((p) => ids.add(p.id));
  }
  if (post.authorId) ids.delete(post.authorId);
  return { all: [...ids], subscribed };
}
const tokensLower = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function afterPublish(post: any) {
  invalidateNewsIndex();
  try {
    const { all } = await recipientsFor(post);
    if (!all.length) return;
    await notifyMany(all, {
      type: "news",
      title: `${post.category}: ${post.title}`,
      body: post.excerpt || excerptOf(post.body),
      data: { postId: post.id, slug: post.slug, link: `/news/${post.slug}` },
      createdById: post.authorId,
    });
    publishToUsers(all, { type: "news.new", data: { id: post.id, slug: post.slug, title: post.title, category: post.category } });
  } catch (err) {
    console.error("[news] delivery failed", err);
  }
}

async function chiefIds() {
  const rows = await prisma.user.findMany({ where: { status: "active", OR: [{ staffTags: { has: "newsChief" } }, { role: "admin" }] }, select: { id: true }, take: 50 });
  return rows.map((r) => r.id);
}
async function askChiefs(post: any, authorName?: string | null) {
  await notifyMany(await chiefIds(), { type: "news", title: "A story is waiting for your approval", body: `${authorName || "A News Agent"}: ${post.title}`, data: { postId: post.id, link: "/news/desk?tab=review" }, createdById: post.authorId });
}

// ── search suggestions, For you, subscriptions ───────────────────────────────
/** GET /news/suggest?q= — as-you-type suggestions. */
export const suggest = handle(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 80) : "";
  res.json(await suggestNews(q));
});

const SUB_KINDS = ["category", "topic", "author", "institution"] as const;

async function viewerFacts(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, institutionId: true, level: true, newsAlerts: true, aspirations: { select: { institutionId: true } } } });
  return { role: u?.role || "user", institutionId: u?.institutionId, level: u?.level, newsAlerts: u?.newsAlerts ?? true, aspirationIds: (u?.aspirations || []).map((a) => a.institutionId) };
}

/** GET /news/for-you — stories from what you follow, plus stories aimed at people like you. */
export const forYou = handle(async (req, res) => {
  const userId = req.user!.id;
  const [subs, v] = await Promise.all([prisma.newsSubscription.findMany({ where: { userId } }), viewerFacts(userId)]);
  const or: Prisma.NewsPostWhereInput[] = [];
  const cats = subs.filter((s) => s.kind === "category").map((s) => s.value);
  const topics = subs.filter((s) => s.kind === "topic").map((s) => s.value);
  const authors = subs.filter((s) => s.kind === "author").map((s) => s.value);
  const insts = subs.filter((s) => s.kind === "institution").map((s) => s.value);
  if (cats.length) or.push({ category: { in: cats } });
  if (topics.length) { or.push({ tags: { hasSome: topics } }); topics.forEach((t) => or.push({ title: { contains: t, mode: "insensitive" } })); }
  if (authors.length) or.push({ authorId: { in: authors } });
  insts.forEach((id) => or.push({ audience: { path: ["institutionIds"], array_contains: [id] } }));
  const since = new Date(Date.now() - 60 * 864e5);
  const [followed, aimed] = await Promise.all([
    or.length ? prisma.newsPost.findMany({ where: { status: "published", publishedAt: { gte: since }, OR: or }, orderBy: { publishedAt: "desc" }, take: 24, include: { author: { select: authorSelect } } }) : Promise.resolve([] as any[]),
    prisma.newsPost.findMany({ where: { status: "published", publishedAt: { gte: since }, audience: { not: Prisma.DbNull } }, orderBy: { publishedAt: "desc" }, take: 120, include: { author: { select: authorSelect } } }),
  ]);
  const reasons = new Map<string, string>();
  for (const p of followed) {
    reasons.set(p.id,
      cats.includes(p.category) ? `You follow ${p.category}` :
        authors.includes(p.authorId || "") ? `You follow ${p.author?.name || "this writer"}` :
          topics.find((t) => p.tags.includes(t) || p.title.toLowerCase().includes(t)) ? `You follow “${topics.find((t) => p.tags.includes(t) || p.title.toLowerCase().includes(t))}”` : "From what you follow");
  }
  for (const p of aimed) if (!reasons.has(p.id) && viewerMatches(p.audience as Audience, v)) reasons.set(p.id, v.role === "aspirant" ? "Picked for aspirants like you" : "Picked for you");
  const all = [...followed, ...aimed.filter((p) => reasons.has(p.id) && !followed.some((f: any) => f.id === p.id))]
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt)).slice(0, 12);
  const r = await reactionSummary(all.map((p) => p.id), userId);
  res.json({ posts: all.map((p) => ({ ...cardOut(p, r), reason: reasons.get(p.id) })), following: subs.length });
});

/** GET /news/subscriptions */
export const listSubscriptions = handle(async (req, res) => {
  const [subs, v, topTags] = await Promise.all([
    prisma.newsSubscription.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "asc" } }),
    viewerFacts(req.user!.id),
    prisma.$queryRaw<{ tag: string; n: bigint }[]>`SELECT unnest(tags) AS tag, count(*) AS n FROM news_posts WHERE status = 'published' GROUP BY 1 ORDER BY 2 DESC LIMIT 14`,
  ]);
  const writers = await prisma.user.findMany({ where: { status: "active", newsPosts: { some: { status: "published" } } }, select: { id: true, name: true, photoUrl: true }, take: 12 });
  res.json({
    subscriptions: subs,
    newsAlerts: v.newsAlerts,
    suggestions: { categories: NEWS_CATEGORIES, topics: topTags.map((t) => t.tag), writers },
  });
});

/** POST /news/subscriptions { kind, value, label } */
export const subscribe = handle(async (req, res) => {
  const body = z.object({ kind: z.enum(SUB_KINDS), value: z.string().trim().min(1).max(120), label: z.string().trim().max(160).optional().nullable() }).parse(req.body || {});
  const value = body.kind === "topic" ? body.value.toLowerCase().replace(/^#/, "").slice(0, 40) : body.value;
  if (body.kind === "category" && !(NEWS_CATEGORIES as readonly string[]).includes(value)) throw new HttpError(400, "Unknown section");
  const count = await prisma.newsSubscription.count({ where: { userId: req.user!.id } });
  if (count >= 40) throw new HttpError(400, "You're following 40 things already. Unfollow something first.");
  const sub = await prisma.newsSubscription.upsert({
    where: { userId_kind_value: { userId: req.user!.id, kind: body.kind, value } },
    create: { userId: req.user!.id, kind: body.kind, value, label: body.label || null },
    update: { label: body.label || undefined },
  });
  res.status(201).json({ subscription: sub });
});

/** DELETE /news/subscriptions/:id */
export const unsubscribe = handle(async (req, res) => {
  await prisma.newsSubscription.deleteMany({ where: { id: String(req.params.id), userId: req.user!.id } });
  res.json({ ok: true });
});

/** PATCH /news/subscriptions/prefs { newsAlerts } */
export const subscriptionPrefs = handle(async (req, res) => {
  const { newsAlerts } = z.object({ newsAlerts: z.boolean() }).parse(req.body || {});
  await prisma.user.update({ where: { id: req.user!.id }, data: { newsAlerts } });
  res.json({ newsAlerts });
});

// ── Chief News Agent ─────────────────────────────────────────────────────────
export function requireNewsChief(req: Request, res: Response, next: NextFunction) {
  if (!isNewsChief(req.user)) return res.status(403).json({ error: "Only the Chief News Agent can do that" });
  next();
}

/** GET /news/chief/overview */
export const chiefOverview = handle(async (_req, res) => {
  const [byStatus, agents, review, suspended, restricted] = await Promise.all([
    prisma.newsPost.groupBy({ by: ["status"], _count: true }),
    prisma.user.count({ where: { status: "active", staffTags: { has: "news" } } }),
    prisma.newsPost.findMany({ where: { status: "review" }, orderBy: { updatedAt: "asc" }, take: 30, include: { author: { select: authorSelect } } }),
    prisma.user.count({ where: { staffTags: { has: "news" }, newsStatus: "suspended" } }),
    prisma.user.count({ where: { staffTags: { has: "news" }, newsStatus: "restricted" } }),
  ]);
  const r = await reactionSummary([]);
  res.json({
    counts: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
    agents, suspended, restricted,
    review: review.map((p) => ({ ...cardOut(p, r), body: p.body })),
  });
});

/** GET /news/chief/posts?status=&q=&authorId=&page= */
export const chiefPosts = handle(async (req, res) => {
  const status = typeof req.query.status === "string" && ["draft", "review", "published", "hidden"].includes(req.query.status) ? req.query.status : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const authorId = typeof req.query.authorId === "string" && req.query.authorId ? req.query.authorId : undefined;
  const page = Math.max(1, Number(req.query.page) || 1);
  const where: Prisma.NewsPostWhereInput = {
    ...(status ? { status } : {}), ...(authorId ? { authorId } : {}),
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { author: { name: { contains: q, mode: "insensitive" } } }] } : {}),
  };
  const [total, posts] = await Promise.all([
    prisma.newsPost.count({ where }),
    prisma.newsPost.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * 25, take: 25, include: { author: { select: authorSelect } } }),
  ]);
  const r = await reactionSummary(posts.map((p) => p.id));
  res.json({ total, page, pageSize: 25, posts: posts.map((p) => ({ ...cardOut(p, r), body: p.body })) });
});

/** PATCH /news/chief/posts/:id { action: approve | reject | hide | restore | unpublish, note } */
export const chiefModerate = handle(async (req, res) => {
  const { action, note } = z.object({ action: z.enum(["approve", "reject", "hide", "restore", "unpublish"]), note: z.string().trim().max(500).optional().nullable() }).parse(req.body || {});
  const post = await prisma.newsPost.findUnique({ where: { id: String(req.params.id) } });
  if (!post) throw new HttpError(404, "Story not found");
  const next: Record<string, string> = { approve: "published", reject: "draft", hide: "hidden", restore: "published", unpublish: "draft" };
  const allowedFrom: Record<string, string[]> = { approve: ["review"], reject: ["review"], hide: ["published", "review", "draft"], restore: ["hidden"], unpublish: ["published"] };
  if (!allowedFrom[action].includes(post.status)) throw new HttpError(400, `Can't ${action} a story that is ${post.status}`);
  const status = next[action];
  const firstTime = status === "published" && !post.publishedAt;
  const updated = await prisma.newsPost.update({
    where: { id: post.id },
    data: {
      status, moderationNote: note || null, moderatedById: req.user!.id, moderatedAt: new Date(),
      ...(status === "published" && !post.publishedAt ? { publishedAt: new Date() } : {}),
      ...(status === "draft" ? { publishedAt: null } : {}),
    },
    include: { author: { select: authorSelect } },
  });
  if (firstTime) await afterPublish(updated); else invalidateNewsIndex();
  const words: Record<string, string> = { approve: "approved and published", reject: "sent back", hide: "taken down", restore: "restored", unpublish: "unpublished" };
  if (post.authorId && post.authorId !== req.user!.id) {
    await notifyMany([post.authorId], { type: "news", title: `The Chief News Agent ${words[action]} “${post.title}”`, body: note || null, data: { postId: post.id, link: "/news/desk" }, createdById: req.user!.id });
  }
  await audit(req.user, `news.${action}`, { id: post.id, label: post.title }, { note });
  const r = await reactionSummary([updated.id]);
  res.json({ post: { ...cardOut(updated, r), body: updated.body } });
});

/** DELETE /news/chief/posts/:id { reason } */
export const chiefDelete = handle(async (req, res) => {
  const post = await prisma.newsPost.findUnique({ where: { id: String(req.params.id) } });
  if (!post) throw new HttpError(404, "Story not found");
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
  await prisma.newsPost.delete({ where: { id: post.id } });
  invalidateNewsIndex();
  if (post.authorId && post.authorId !== req.user!.id) {
    await notifyMany([post.authorId], { type: "news", title: `The Chief News Agent deleted “${post.title}”`, body: reason, data: { link: "/news/desk" }, createdById: req.user!.id });
  }
  await audit(req.user, "news.delete", { id: post.id, label: post.title }, { reason, authorId: post.authorId });
  res.json({ ok: true });
});

/** GET /news/chief/agents — every News Agent with their standing and output. */
export const chiefAgents = handle(async (_req, res) => {
  const people = await prisma.user.findMany({
    where: { status: { not: "deleted" }, OR: [{ staffTags: { has: "news" } }, { staffTags: { has: "newsChief" } }] },
    select: { id: true, name: true, email: true, role: true, photoUrl: true, staffTags: true, newsStatus: true, newsStatusReason: true, newsStatusAt: true, lastActiveAt: true },
    orderBy: { name: "asc" }, take: 300,
  });
  const counts = people.length ? await prisma.newsPost.groupBy({ by: ["authorId", "status"], where: { authorId: { in: people.map((p) => p.id) } }, _count: true }) : [];
  const last = people.length ? await prisma.newsPost.groupBy({ by: ["authorId"], where: { authorId: { in: people.map((p) => p.id) }, status: "published" }, _max: { publishedAt: true } }) : [];
  res.json({
    agents: people.map((p) => ({
      ...p,
      chief: (p.staffTags || []).includes("newsChief"),
      posts: Object.fromEntries(counts.filter((c) => c.authorId === p.id).map((c) => [c.status, c._count])),
      lastPublishedAt: last.find((l) => l.authorId === p.id)?._max.publishedAt || null,
    })),
  });
});

async function agentTarget(req: Request) {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!target || !(target.staffTags || []).some((t) => t === "news" || t === "newsChief")) throw new HttpError(404, "News Agent not found");
  if (target.id === req.user!.id) throw new HttpError(400, "You can't change your own standing");
  if (req.user!.role !== "admin" && (target.role === "admin" || (target.staffTags || []).includes("newsChief"))) throw new HttpError(403, "Only an admin can change another chief or an admin");
  return target;
}

/** PATCH /news/chief/agents/:id { newsStatus: active|restricted|suspended, reason } */
export const chiefSetAgent = handle(async (req, res) => {
  const target = await agentTarget(req);
  const { newsStatus, reason } = z.object({ newsStatus: z.enum(["active", "restricted", "suspended"]), reason: z.string().trim().max(300).optional().nullable() }).parse(req.body || {});
  await prisma.user.update({ where: { id: target.id }, data: { newsStatus, newsStatusReason: newsStatus === "active" ? null : reason || null, newsStatusAt: new Date() } });
  if (newsStatus === "suspended") {
    // A suspended agent's drafts waiting for approval go back to drafts.
    await prisma.newsPost.updateMany({ where: { authorId: target.id, status: "review" }, data: { status: "draft" } });
  }
  const msg = newsStatus === "active" ? "Your News desk access is fully restored" : newsStatus === "restricted" ? "Your stories now need the Chief News Agent's approval before they go live" : "Your News desk access is suspended";
  await notifyMany([target.id], { type: "news", title: msg, body: reason || null, data: { link: "/news/desk" }, createdById: req.user!.id });
  await audit(req.user, `news.agent.${newsStatus}`, { id: target.id, label: target.name || target.email }, { reason });
  res.json({ ok: true, newsStatus });
});

/** DELETE /news/chief/agents/:id/duty — remove the News Agent duty. */
export const chiefRemoveDuty = handle(async (req, res) => {
  const target = await agentTarget(req);
  const tags = (target.staffTags || []).filter((t) => t !== "news" && t !== "newsChief");
  await prisma.user.update({ where: { id: target.id }, data: { staffTags: tags, newsStatus: "active", newsStatusReason: null } });
  await prisma.newsPost.updateMany({ where: { authorId: target.id, status: "review" }, data: { status: "draft" } });
  await notifyMany([target.id], { type: "news", title: "You're no longer on the news team", body: "Your published stories stay up. Thanks for writing.", data: { link: "/news" }, createdById: req.user!.id });
  await audit(req.user, "news.agent.remove", { id: target.id, label: target.name || target.email });
  res.json({ ok: true });
});
