/**
 * Programme hub (StudentDepartment page): feed posts, class events, comments and
 * reactions — scoped by institution + programme, and pushed live over SSE.
 *
 * Comments and reactions are appended on the server inside a row lock, so two
 * students commenting at the same moment no longer overwrite each other (the old
 * client sent the whole array back).
 */
import { Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { publishToScope } from "../lib/realtime";
import {
  displayName, institutionOf, isStaffRole, loadScopedUser, norm, normLevel,
  programmeScope, programmeScopeKey, ScopedUser,
} from "../lib/scope";

const REACTION_TYPES = ["like", "haha", "love"] as const;

type Target = "feed" | "classEvent";

function table(target: Target) {
  return target === "feed" ? "feed_posts" : "class_events";
}

async function findRow(tx: any, target: Target, id: string) {
  return target === "feed" ? tx.feedPost.findUnique({ where: { id } }) : tx.classEvent.findUnique({ where: { id } });
}

async function saveRow(tx: any, target: Target, id: string, data: any) {
  return target === "feed" ? tx.feedPost.update({ where: { id }, data }) : tx.classEvent.update({ where: { id }, data });
}

export function canSeeScoped(user: ScopedUser, row: { institutionId?: string | null; department?: string | null; level?: string | null }) {
  if (user.role === "admin" || user.role === "alphaAgent") return true;
  if ((row.institutionId || "uofa") !== institutionOf(user)) return false;
  if (user.role === "agent") return true;
  if (row.department && norm(row.department) !== norm(programmeScope(user))) return false;
  const meta = (user.courseRepMeta || {}) as Record<string, unknown>;
  const userLevel = String(meta.level || user.level || "");
  return !row.level || normLevel(row.level) === normLevel(userLevel);
}

/** Push the fresh row to everyone viewing that programme. */
export function broadcastProgramme(target: Target, row: any, action: "created" | "updated" | "deleted") {
  if (!row?.department) return;
  publishToScope(programmeScopeKey(row.institutionId, row.department), {
    type: target === "feed" ? "programme.post" : "programme.class",
    data: { action, item: action === "deleted" ? { id: row.id } : row, level: row.level ? normLevel(row.level) : null },
  });
}

async function mutateSocial(
  req: Request,
  res: Response,
  target: Target,
  mutate: (row: any, user: ScopedUser) => any | { error: string; status: number },
) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const user = await loadScopedUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const id = String(req.params.id);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "${table(target)}" WHERE "id" = $1 FOR UPDATE`, id);
      const row = await findRow(tx, target, id);
      if (!row) throw Object.assign(new Error("Not found"), { status: 404 });
      if (!canSeeScoped(user, row)) throw Object.assign(new Error("This post belongs to another programme"), { status: 403 });
      const data = mutate(row, user);
      if (data?.error) throw Object.assign(new Error(data.error), { status: data.status || 400 });
      return saveRow(tx, target, id, data);
    });
    broadcastProgramme(target, updated, "updated");
    return res.json(target === "feed" ? { post: updated } : { event: updated });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: "Could not save" });
  }
}

const commentSchema = z.object({ text: z.string().trim().min(1).max(2000), anonymous: z.boolean().optional() });
const reactionSchema = z.object({ type: z.enum(REACTION_TYPES) });

function toggle(list: any[], user: ScopedUser, type: string) {
  const reactions = Array.isArray(list) ? [...list] : [];
  const i = reactions.findIndex((r) => r?.uid === user.id);
  const entry = { uid: user.id, type, name: displayName(user) };
  if (i >= 0) {
    if (reactions[i].type === type) reactions.splice(i, 1);
    else reactions[i] = entry;
  } else reactions.push(entry);
  return reactions;
}

function handlers(target: Target) {
  return {
    addComment: (req: Request, res: Response) => {
      const parsed = commentSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Write a comment first (up to 2,000 characters)." });
      return mutateSocial(req, res, target, (row, user) => {
        const comments = Array.isArray(row.comments) ? [...row.comments] : [];
        if (comments.length >= 1000) return { error: "This thread is full.", status: 400 };
        comments.push({
          id: randomUUID(),
          text: parsed.data.text,
          authorUid: user.id,
          authorName: displayName(user),
          authorPhoto: user.photoUrl || user.avatarUrl || null,
          authorRole: user.role,
          createdAt: new Date().toISOString(),
          reactions: [],
        });
        return { comments };
      });
    },
    deleteComment: (req: Request, res: Response) =>
      mutateSocial(req, res, target, (row, user) => {
        const comments = Array.isArray(row.comments) ? [...row.comments] : [];
        const i = comments.findIndex((c) => c?.id === req.params.commentId);
        if (i < 0) return { error: "Comment not found", status: 404 };
        const isRepHere = user.role === "courseRep";
        if (comments[i].authorUid !== user.id && !isStaffRole(user.role) && !isRepHere) return { error: "You can only delete your own comments", status: 403 };
        comments.splice(i, 1);
        return { comments };
      }),
    react: (req: Request, res: Response) => {
      const parsed = reactionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Unknown reaction" });
      return mutateSocial(req, res, target, (row, user) => ({ reactions: toggle(row.reactions, user, parsed.data.type) }));
    },
    reactComment: (req: Request, res: Response) => {
      const parsed = reactionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Unknown reaction" });
      return mutateSocial(req, res, target, (row, user) => {
        const comments = Array.isArray(row.comments) ? [...row.comments] : [];
        const i = comments.findIndex((c) => c?.id === req.params.commentId);
        if (i < 0) return { error: "Comment not found", status: 404 };
        comments[i] = { ...comments[i], reactions: toggle(comments[i].reactions, user, parsed.data.type) };
        return { comments };
      });
    },
  };
}

export const feedSocial = handlers("feed");
export const classSocial = handlers("classEvent");

// ─── Class events: edit (the old client called PATCH, which was missing) ─────

const classPatchSchema = z.object({
  title: z.string().min(1).optional(),
  courseCode: z.string().nullable().optional(),
  venue: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, "An update is required");

export async function updateClassEvent(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const user = await loadScopedUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const existing = await prisma.classEvent.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Class not found" });
  const parsed = classPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors });
  const body = parsed.data;
  if (!canSeeScoped(user, existing)) return res.status(403).json({ error: "This class belongs to another programme" });
  if (existing.createdBy !== user.id && !isStaffRole(user.role)) return res.status(403).json({ error: "Only the course rep who scheduled this class can edit it" });
  const event = await prisma.classEvent.update({ where: { id: existing.id }, data: body });
  broadcastProgramme("classEvent", event, "updated");
  res.json({ event });
}
