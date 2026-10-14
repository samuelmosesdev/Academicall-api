/**
 * Academicall News — public campus news written by News Agents.
 *
 *  - Anyone (signed in or not) can browse headlines and read a preview.
 *  - Signed-in users read the full story, react, and comment.
 *  - News Agents (role `newsAgent`, assigned by an admin) and admins write,
 *    publish, edit and remove stories, and can moderate comments.
 */
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";

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
      const user = await prisma.user.findUnique({ where: { id: decoded.sub }, select: { id: true, email: true, role: true, status: true } });
      if (user && user.status === "active") req.user = { id: user.id, email: user.email, role: user.role };
    } catch { /* treat as guest */ }
  }
  next();
}

export const canWriteNews = (role?: string) => role === "newsAgent" || role === "admin";
export function requireNewsDesk(req: Request, res: Response, next: NextFunction) {
  if (!canWriteNews(req.user?.role)) return res.status(403).json({ error: "Only News Agents can do that" });
  next();
}

const authorSelect = { id: true, name: true, nickname: true, photoUrl: true, avatarUrl: true, role: true } as const;
function authorOut(a: any) {
  if (!a) return { name: "Academicall News", photoUrl: null };
  return { id: a.id, name: a.name || a.nickname || "Academicall News", photoUrl: a.photoUrl || a.avatarUrl || null, role: a.role };
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
  const posts = await prisma.newsPost.findMany({
    where: {
      status: "published",
      ...(category ? { category } : {}),
      ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { body: { contains: q, mode: "insensitive" } }] } : {}),
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
    viewer: { signedIn: !!req.user, canWrite: canWriteNews(req.user?.role) },
  });
});

export const getNews = handle(async (req, res) => {
  const post = await prisma.newsPost.findUnique({ where: { slug: String(req.params.slug) }, include: { author: { select: authorSelect } } });
  const staffView = post && canWriteNews(req.user?.role);
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
    viewer: { signedIn, canWrite: canWriteNews(req.user?.role), canModerate: canWriteNews(req.user?.role) },
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
      mine: c.userId === req.user?.id, canDelete: c.userId === req.user?.id || canWriteNews(req.user?.role),
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
  if (c.userId !== req.user!.id && !canWriteNews(req.user!.role)) throw new HttpError(403, "You can only delete your own comments");
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
});

export const deskList = handle(async (req, res) => {
  const mineOnly = req.user!.role !== "admin" || req.query.mine === "1";
  const posts = await prisma.newsPost.findMany({
    where: mineOnly ? { authorId: req.user!.id } : {},
    orderBy: { updatedAt: "desc" }, take: 100, include: { author: { select: authorSelect } },
  });
  const r = await reactionSummary(posts.map((p) => p.id));
  res.json({ posts: posts.map((p) => ({ ...cardOut(p, r), body: p.body, excerpt: p.excerpt })), categories: NEWS_CATEGORIES });
});

export const createPost = handle(async (req, res) => {
  const body = postSchema.parse(req.body || {});
  const post = await prisma.newsPost.create({
    data: { ...body, excerpt: body.excerpt || null, coverUrl: body.coverUrl || null, slug: slugify(body.title), authorId: req.user!.id, publishedAt: body.status === "published" ? new Date() : null },
    include: { author: { select: authorSelect } },
  });
  res.status(201).json({ post: { ...cardOut(post, { counts: new Map(), mine: new Map() }), body: post.body } });
});

async function editable(req: Request) {
  const post = await prisma.newsPost.findUnique({ where: { id: String(req.params.id) } });
  if (!post) throw new HttpError(404, "Story not found");
  if (req.user!.role !== "admin" && post.authorId !== req.user!.id) throw new HttpError(403, "You can only edit stories you wrote");
  return post;
}

export const updatePost = handle(async (req, res) => {
  const post = await editable(req);
  const body = postSchema.partial().parse(req.body || {});
  const publishing = body.status === "published" && post.status !== "published";
  const updated = await prisma.newsPost.update({
    where: { id: post.id },
    data: { ...body, ...(publishing ? { publishedAt: new Date() } : {}), ...(body.status === "draft" ? { publishedAt: null } : {}) },
    include: { author: { select: authorSelect } },
  });
  const r = await reactionSummary([updated.id]);
  res.json({ post: { ...cardOut(updated, r), body: updated.body } });
});

export const deletePost = handle(async (req, res) => {
  const post = await editable(req);
  await prisma.newsPost.delete({ where: { id: post.id } });
  res.json({ ok: true });
});
