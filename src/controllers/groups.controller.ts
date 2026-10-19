/**
 * Study groups.
 *
 * Roles (per group, enforced here — never trusted from the client):
 *   creator    full control: settings, roles, membership, history, delete, transfer
 *   moderator  up to 3 per group: approve/reject joins + history requests, remove
 *              members, delete other members' messages
 *   member     read/send messages, share files, save materials, request history, leave
 *
 * Platform roles grant nothing inside a group. A course rep is a normal creator
 * of the groups they make; "official" only means the group is tied to their
 * institution/programme scope and they can invite that scope.
 */
import { Request, Response } from "express";
import { mutedMessage } from "../lib/moderation";
import { z } from "zod";
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { publishToGroup, publishToUsers } from "../lib/realtime";
import {
  AttachmentError, HISTORY_ATTACHMENT_LIMIT, LIMITS, MAX_VIDEO_SECONDS, verifyAttachment,
} from "../lib/attachments";
import {
  displayName, institutionOf, isStaffRole, loadScopedUser, norm, normLevel, programmeScope, ScopedUser,
} from "../lib/scope";

export const MAX_MEMBERS = 200;
export const MAX_MODERATORS = 3;
const PAGE_DEFAULT = 40;
const PAGE_MAX = 80;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

type Role = "creator" | "moderator" | "member";

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

function send(res: Response, err: unknown) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof AttachmentError) return res.status(422).json({ error: err.message, code: "invalid_attachment" });
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors.map((e) => e.message).join(", ") });
  console.error(err);
  return res.status(500).json({ error: "Something went wrong" });
}

/** 8-character base62 code with rejection sampling (no modulo bias). */
export function generateGroupCode(length = 8) {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248) out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

function publicAppUrl() {
  return (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || "https://academicall.site").replace(/\/$/, "");
}

export function inviteLink(code: string) {
  return `${publicAppUrl()}/study/${code}`;
}

async function me(req: Request) {
  if (!req.user) throw new HttpError(401, "Unauthenticated");
  const user = await loadScopedUser(req.user.id);
  if (!user) throw new HttpError(401, "Unauthenticated");
  return user;
}

async function loadGroup(id: string) {
  const group = await prisma.studyGroup.findUnique({ where: { id } });
  if (!group || group.archived) throw new HttpError(404, "Group not found");
  return group;
}

async function membership(groupId: string, userId: string) {
  return prisma.studyGroupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
}

/** Active membership with at least `min` role, or 403/404. */
async function requireRole(groupId: string, userId: string, min: Role = "member") {
  const group = await loadGroup(groupId);
  const m = await membership(groupId, userId);
  if (!m || m.status !== "active") throw new HttpError(403, "You are not a member of this group", "not_member");
  const rank: Record<string, number> = { member: 1, moderator: 2, creator: 3 };
  if ((rank[m.role] || 0) < rank[min]) throw new HttpError(403, min === "creator" ? "Only the group creator can do that" : "Only the creator or a moderator can do that", "forbidden");
  return { group, member: m };
}

async function refreshMemberCount(groupId: string) {
  const memberCount = await prisma.studyGroupMember.count({ where: { groupId, status: "active" } });
  await prisma.studyGroup.update({ where: { id: groupId }, data: { memberCount } });
  return memberCount;
}

async function moderatorIds(groupId: string) {
  const rows = await prisma.studyGroupMember.findMany({
    where: { groupId, status: "active", role: { in: ["creator", "moderator"] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

function scopeLabel(g: { scopeType: string; program?: string | null; department?: string | null; faculty?: string | null; courseCode?: string | null; level?: string | null }) {
  const parts: string[] = [];
  if (g.scopeType === "course" && g.courseCode) parts.push(g.courseCode);
  if (["program", "course", "level"].includes(g.scopeType) && g.program) parts.push(g.program);
  if (g.scopeType === "department" && g.department) parts.push(g.department);
  if (g.scopeType === "faculty" && g.faculty) parts.push(g.faculty);
  if (g.level && g.scopeType !== "faculty" && g.scopeType !== "department") parts.push(g.level);
  return parts.join(" · ") || null;
}

/** Whether a student falls inside an official group's academic scope. */
export function eligibleForScope(user: ScopedUser, g: any) {
  if (!g.official) return true;
  if (isStaffRole(user.role)) return true;
  if ((g.institutionId || "uofa") !== institutionOf(user)) return false;
  const levelOk = !g.level || normLevel(g.level) === normLevel(user.level);
  switch (g.scopeType) {
    case "faculty": return norm(g.faculty) === norm(user.faculty);
    case "department": return norm(g.department) === norm(user.department) || norm(g.department) === norm(programmeScope(user));
    case "program":
    case "course":
    case "level": return norm(g.program) === norm(programmeScope(user)) && levelOk;
    default: return true;
  }
}

function groupView(g: any, m: any | null, extras: Record<string, unknown> = {}) {
  const canSeeLast = m && m.status === "active" && (m.historyAccess === "granted" || !g.lastMessageAt || !m.joinedAt || g.lastMessageAt >= m.joinedAt);
  return {
    id: g.id,
    code: g.code,
    link: inviteLink(g.code),
    name: g.name,
    description: g.description,
    iconUrl: g.iconUrl,
    approvalRequired: g.approvalRequired,
    maxMembers: g.maxMembers,
    memberCount: g.memberCount,
    official: g.official,
    scopeType: g.scopeType,
    scopeLabel: scopeLabel(g),
    institutionId: g.institutionId,
    faculty: g.faculty, department: g.department, program: g.program, courseCode: g.courseCode, level: g.level,
    createdById: g.createdById,
    createdAt: g.createdAt,
    lastMessageAt: canSeeLast ? g.lastMessageAt : m?.joinedAt || g.createdAt,
    lastMessagePreview: canSeeLast ? g.lastMessagePreview : null,
    lastMessageSender: canSeeLast ? g.lastMessageSender : null,
    lastMessageType: canSeeLast ? g.lastMessageType : null,
    myRole: m?.status === "active" ? m.role : null,
    myStatus: m?.status || null,
    myHistoryAccess: m?.historyAccess || "none",
    joinedAt: m?.joinedAt || null,
    ...extras,
  };
}

function preview(type: string, text?: string | null, name?: string | null) {
  if (type === "image") return text ? `📷 ${text}` : "📷 Photo";
  if (type === "video") return text ? `🎬 ${text}` : "🎬 Video";
  if (type === "document") return `📄 ${name || "Document"}`;
  return String(text || "").slice(0, 140);
}

const senderSelect = { id: true, name: true, nickname: true, email: true, photoUrl: true, avatarUrl: true, role: true } as const;

/** Shape a message for a given viewer, withholding heavy media from shared history. */
function messageView(msg: any, viewer: { joinedAt: Date | null; historyAccess: string }) {
  const s = msg.sender;
  const fromHistory = viewer.joinedAt && msg.createdAt < viewer.joinedAt;
  const heavy = (msg.attachmentBytes || 0) > HISTORY_ATTACHMENT_LIMIT;
  const withheld = Boolean(fromHistory && heavy && msg.attachmentUrl);
  return {
    id: msg.id,
    groupId: msg.groupId,
    clientId: msg.clientId,
    type: msg.type,
    text: msg.deletedAt ? null : msg.text,
    deleted: Boolean(msg.deletedAt),
    createdAt: msg.createdAt,
    fromHistory: Boolean(fromHistory),
    sender: s ? { id: s.id, name: s.nickname || s.name || (s.email ? s.email.split("@")[0] : "Student"), photoUrl: s.photoUrl || s.avatarUrl || null } : null,
    attachment: msg.deletedAt || !msg.attachmentUrl
      ? null
      : withheld
        ? { withheld: true, name: msg.attachmentName, mime: msg.attachmentMime, bytes: msg.attachmentBytes, kind: msg.type }
        : {
            url: msg.attachmentUrl, name: msg.attachmentName, mime: msg.attachmentMime, bytes: msg.attachmentBytes,
            width: msg.attachmentWidth, height: msg.attachmentHeight, duration: msg.attachmentDuration,
            thumbnailUrl: msg.thumbnailUrl, kind: msg.type,
          },
    withheld,
  };
}

async function systemMessage(groupId: string, text: string) {
  const msg = await prisma.studyGroupMessage.create({ data: { groupId, type: "system", text }, include: { sender: { select: senderSelect } } });
  publishToGroup(groupId, { type: "group.message", data: { groupId, message: messageView(msg, { joinedAt: null, historyAccess: "none" }) } }).catch(() => {});
  return msg;
}

// ─── Groups ───────────────────────────────────────────────────────────────────

const httpsUrl = z.string().url().refine((u) => u.startsWith("https://") || u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost"), "Must be an uploaded image");

const createSchema = z.object({
  name: z.string().trim().min(3, "Group name needs at least 3 characters").max(60, "Group name can be up to 60 characters"),
  description: z.string().trim().max(500, "Description can be up to 500 characters").optional().nullable(),
  iconUrl: httpsUrl.optional().nullable(),
  approvalRequired: z.boolean().optional(),
  official: z.boolean().optional(),
  scopeType: z.enum(["open", "faculty", "department", "program", "course", "level"]).optional(),
  courseCode: z.string().trim().max(20).optional().nullable(),
});

export async function createGroup(req: Request, res: Response) {
  try {
    const user = await me(req);
    const body = createSchema.parse(req.body);
    const owned = await prisma.studyGroup.count({ where: { createdById: user.id, archived: false } });
    if (owned >= 50) throw new HttpError(429, "You've reached the limit of 50 groups you can create");

    let scope: any = { official: false, scopeType: "open", institutionId: institutionOf(user) };
    if (body.official) {
      if (user.role !== "courseRep" && !isStaffRole(user.role)) throw new HttpError(403, "Only course representatives can create departmental groups");
      const meta = (user.courseRepMeta || {}) as Record<string, any>;
      const scopeType = body.scopeType && body.scopeType !== "open" ? body.scopeType : "program";
      // Scope always comes from the rep's own assignment, never from the request.
      scope = {
        official: true,
        scopeType,
        institutionId: institutionOf(user),
        faculty: meta.faculty || user.faculty || null,
        department: meta.department || user.department || null,
        program: programmeScope(user) || null,
        level: ["program", "course", "level"].includes(scopeType) ? meta.level || user.level || null : null,
        courseCode: scopeType === "course" ? (body.courseCode || "").toUpperCase() || null : null,
      };
      if (scopeType === "course" && !scope.courseCode) throw new HttpError(400, "Add the course code for a course group");
      if (["program", "course", "level"].includes(scopeType) && !scope.program) throw new HttpError(400, "Your course rep assignment has no programme yet");
      if (scopeType === "department" && !scope.department) throw new HttpError(400, "Your course rep assignment has no department yet");
      if (scopeType === "faculty" && !scope.faculty) throw new HttpError(400, "Your course rep assignment has no faculty yet");
    }

    let group: any = null;
    for (let attempt = 0; attempt < 6 && !group; attempt += 1) {
      try {
        group = await prisma.$transaction(async (tx) => {
          const g = await tx.studyGroup.create({
            data: {
              code: generateGroupCode(),
              name: body.name,
              description: body.description || null,
              iconUrl: body.iconUrl || null,
              approvalRequired: body.approvalRequired ?? true,
              maxMembers: MAX_MEMBERS,
              memberCount: 1,
              createdById: user.id,
              lastMessageAt: new Date(),
              lastMessagePreview: "Group created",
              lastMessageType: "system",
              ...scope,
            },
          });
          await tx.studyGroupMember.create({
            data: { groupId: g.id, userId: user.id, role: "creator", status: "active", joinedAt: g.createdAt, lastReadAt: g.createdAt, historyAccess: "granted" },
          });
          await tx.studyGroupMessage.create({ data: { groupId: g.id, type: "system", text: `${displayName(user)} created the group`, createdAt: g.createdAt } });
          return g;
        });
      } catch (err: any) {
        if (err?.code === "P2002" && String(err?.meta?.target || "").includes("code")) continue; // code collision: retry
        throw err;
      }
    }
    if (!group) throw new HttpError(500, "Could not create a unique group link. Please try again.");
    const m = await membership(group.id, user.id);
    res.status(201).json({ group: groupView(group, m) });
  } catch (err) {
    send(res, err);
  }
}

export async function listMyGroups(req: Request, res: Response) {
  try {
    const user = await me(req);
    const memberships = await prisma.studyGroupMember.findMany({
      where: { userId: user.id, status: { in: ["active", "pending"] }, group: { archived: false } },
      include: { group: true },
    });
    const unreadRows = await prisma.$queryRaw<{ groupId: string; unread: bigint }[]>`
      SELECT m."groupId", COUNT(*)::bigint AS unread
      FROM "study_group_messages" m
      JOIN "study_group_members" gm ON gm."groupId" = m."groupId" AND gm."userId" = ${user.id} AND gm."status" = 'active'
      WHERE m."createdAt" > COALESCE(gm."lastReadAt", gm."joinedAt", gm."createdAt")
        AND (m."senderId" IS NULL OR m."senderId" <> ${user.id})
        AND m."type" <> 'system'
        AND m."deletedAt" IS NULL
      GROUP BY m."groupId"`;
    const unread = new Map(unreadRows.map((r) => [r.groupId, Number(r.unread)]));
    const groups = memberships
      .map((m) => groupView(m.group, m, { unreadCount: unread.get(m.groupId) || 0 }))
      .sort((a: any, b: any) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime());
    res.json({ groups, totalUnread: groups.reduce((n: number, g: any) => n + (g.unreadCount || 0), 0) });
  } catch (err) {
    send(res, err);
  }
}

/** Official groups for the student's own programme they have not joined yet. */
export async function discoverGroups(req: Request, res: Response) {
  try {
    const user = await me(req);
    const candidates = await prisma.studyGroup.findMany({
      where: {
        archived: false, official: true, institutionId: institutionOf(user),
        members: { none: { userId: user.id, status: { in: ["active", "pending"] } } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 50,
    });
    const groups = candidates.filter((g) => eligibleForScope(user, g)).slice(0, 12).map((g) => ({
      ...groupView(g, null), lastMessagePreview: null, lastMessageSender: null,
    }));
    res.json({ groups });
  } catch (err) {
    send(res, err);
  }
}

/** Invite-link preview. Never includes messages or the member list. */
export async function previewByCode(req: Request, res: Response) {
  try {
    const user = await me(req);
    const group = await prisma.studyGroup.findUnique({ where: { code: String(req.params.code) } });
    if (!group || group.archived) throw new HttpError(404, "This invite link is invalid or the group was deleted");
    const m = await membership(group.id, user.id);
    const creator = await prisma.user.findUnique({ where: { id: group.createdById }, select: { name: true, nickname: true, email: true } });
    res.json({
      group: {
        id: group.id, code: group.code, name: group.name, description: group.description, iconUrl: group.iconUrl,
        memberCount: group.memberCount, maxMembers: group.maxMembers, approvalRequired: group.approvalRequired,
        official: group.official, scopeLabel: scopeLabel(group), createdByName: displayName({ name: creator?.nickname || creator?.name, email: creator?.email }),
        full: group.memberCount >= group.maxMembers,
        eligible: eligibleForScope(user, group),
        myStatus: m?.status || null,
        myRole: m?.status === "active" ? m.role : null,
      },
    });
  } catch (err) {
    send(res, err);
  }
}

export async function joinByCode(req: Request, res: Response) {
  try {
    const user = await me(req);
    const group = await prisma.studyGroup.findUnique({ where: { code: String(req.params.code) } });
    if (!group || group.archived) throw new HttpError(404, "This invite link is invalid or the group was deleted");
    if (!eligibleForScope(user, group)) throw new HttpError(403, `This group is for ${scopeLabel(group) || "a specific programme"} students only`, "not_eligible");
    const existing = await membership(group.id, user.id);
    if (existing?.status === "active") return res.json({ status: "active", group: groupView(group, existing) });
    if (existing?.status === "pending") return res.json({ status: "pending", group: { id: group.id, name: group.name } });

    const needsApproval = group.approvalRequired || existing?.status === "removed";
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "study_groups" WHERE "id" = $1 FOR UPDATE`, group.id);
      const active = await tx.studyGroupMember.count({ where: { groupId: group.id, status: "active" } });
      if (active >= group.maxMembers) throw new HttpError(409, `This group is full (${group.maxMembers} members)`, "group_full");
      const data = needsApproval
        ? { status: "pending", requestedAt: now, role: "member", reviewedAt: null, reviewedById: null }
        : { status: "active", requestedAt: now, joinedAt: now, lastReadAt: now, role: "member", historyAccess: "none", historyRequestedAt: null, historyReviewedAt: null, historyReviewedBy: null };
      const m = await tx.studyGroupMember.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        create: { groupId: group.id, userId: user.id, ...data },
        update: data,
      });
      if (!needsApproval) await tx.studyGroup.update({ where: { id: group.id }, data: { memberCount: active + 1 } });
      return m;
    });

    if (needsApproval) {
      publishToUsers(await moderatorIds(group.id), { type: "group.request", data: { groupId: group.id, kind: "join" } });
      return res.status(202).json({ status: "pending", group: { id: group.id, name: group.name } });
    }
    await systemMessage(group.id, `${displayName(user)} joined`);
    publishToGroup(group.id, { type: "group.member", data: { groupId: group.id, userId: user.id, status: "active" } }).catch(() => {});
    const fresh = await loadGroup(group.id);
    res.status(201).json({ status: "active", group: groupView(fresh, result) });
  } catch (err) {
    send(res, err);
  }
}

export async function cancelJoinRequest(req: Request, res: Response) {
  try {
    const user = await me(req);
    const m = await membership(String(req.params.id), user.id);
    if (!m || m.status !== "pending") throw new HttpError(404, "No pending request");
    await prisma.studyGroupMember.delete({ where: { id: m.id } });
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
}

export async function getGroup(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id);
    const isMod = member.role !== "member";
    const [pendingJoins, pendingHistory, moderators] = await Promise.all([
      isMod ? prisma.studyGroupMember.count({ where: { groupId: group.id, status: "pending" } }) : 0,
      isMod ? prisma.studyGroupMember.count({ where: { groupId: group.id, status: "active", historyAccess: "pending" } }) : 0,
      prisma.studyGroupMember.count({ where: { groupId: group.id, status: "active", role: "moderator" } }),
    ]);
    res.json({
      group: groupView(group, member, {
        pendingJoinCount: pendingJoins, pendingHistoryCount: pendingHistory,
        moderatorCount: moderators, maxModerators: MAX_MODERATORS,
        hasEarlierMessages: member.joinedAt ? member.joinedAt > group.createdAt : false,
        limits: {
          imageMb: Math.round(LIMITS.image / 1048576), videoMb: Math.round(LIMITS.video / 1048576),
          documentMb: Math.round(LIMITS.document / 1048576), videoSeconds: MAX_VIDEO_SECONDS,
          historyAttachmentMb: HISTORY_ATTACHMENT_LIMIT / 1048576,
        },
      }),
    });
  } catch (err) {
    send(res, err);
  }
}

const updateSchema = z.object({
  name: z.string().trim().min(3).max(60).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  iconUrl: httpsUrl.optional().nullable(),
  approvalRequired: z.boolean().optional(),
});

export async function updateGroup(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group } = await requireRole(String(req.params.id), user.id, "creator");
    const body = updateSchema.parse(req.body);
    const updated = await prisma.studyGroup.update({ where: { id: group.id }, data: body });
    const changes = [body.name && body.name !== group.name ? `renamed the group to “${body.name}”` : null, body.iconUrl !== undefined && body.iconUrl !== group.iconUrl ? "changed the group icon" : null].filter(Boolean);
    if (changes.length) await systemMessage(group.id, `${displayName(user)} ${changes.join(" and ")}`);
    publishToGroup(group.id, { type: "group.updated", data: { groupId: group.id } }).catch(() => {});
    const m = await membership(group.id, user.id);
    res.json({ group: groupView(updated, m) });
  } catch (err) {
    send(res, err);
  }
}

export async function deleteGroup(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group } = await requireRole(String(req.params.id), user.id, "creator");
    const memberIds = (await prisma.studyGroupMember.findMany({ where: { groupId: group.id, status: "active" }, select: { userId: true } })).map((r) => r.userId);
    await prisma.studyGroup.update({ where: { id: group.id }, data: { archived: true } });
    publishToUsers(memberIds, { type: "group.removed", data: { groupId: group.id, reason: "deleted" } });
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
}

// ─── Members ──────────────────────────────────────────────────────────────────

export async function listMembers(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id);
    const status = String(req.query.status || "active");
    if (status !== "active" && member.role === "member") throw new HttpError(403, "Only the creator or a moderator can see requests");
    const where: any = { groupId: group.id };
    if (status === "history") Object.assign(where, { status: "active", historyAccess: "pending" });
    else where.status = status === "pending" ? "pending" : "active";
    const rows = await prisma.studyGroupMember.findMany({
      where,
      include: { user: { select: { id: true, name: true, nickname: true, email: true, photoUrl: true, avatarUrl: true, program: true, level: true, uniqueId: true } } },
      orderBy: status === "active" ? [{ joinedAt: "asc" }] : [{ requestedAt: "asc" }],
      take: 250,
    });
    const order: Record<string, number> = { creator: 0, moderator: 1, member: 2 };
    const members = rows
      .map((r) => ({
        userId: r.userId,
        name: r.user.nickname || r.user.name || r.user.email.split("@")[0],
        photoUrl: r.user.photoUrl || r.user.avatarUrl || null,
        program: r.user.program, level: r.user.level,
        // e-mail only for people who manage the group
        email: member.role !== "member" ? r.user.email : undefined,
        uniqueId: r.user.uniqueId,
        role: r.role, status: r.status, joinedAt: r.joinedAt, requestedAt: r.requestedAt,
        historyAccess: r.historyAccess, historyRequestedAt: r.historyRequestedAt,
      }))
      .sort((a, b) => (status === "active" ? order[a.role] - order[b.role] : 0));
    res.json({ members });
  } catch (err) {
    send(res, err);
  }
}

export async function reviewJoin(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group } = await requireRole(String(req.params.id), user.id, "moderator");
    const action = z.enum(["approve", "reject"]).parse(req.body?.action);
    const targetId = String(req.params.userId);
    const target = await membership(group.id, targetId);
    if (!target || target.status !== "pending") throw new HttpError(404, "That request is no longer pending");
    const now = new Date();
    if (action === "reject") {
      await prisma.studyGroupMember.update({ where: { id: target.id }, data: { status: "rejected", reviewedAt: now, reviewedById: user.id } });
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "study_groups" WHERE "id" = $1 FOR UPDATE`, group.id);
        const active = await tx.studyGroupMember.count({ where: { groupId: group.id, status: "active" } });
        if (active >= group.maxMembers) throw new HttpError(409, `The group is full (${group.maxMembers} members)`, "group_full");
        await tx.studyGroupMember.update({
          where: { id: target.id },
          data: { status: "active", role: "member", joinedAt: now, lastReadAt: now, reviewedAt: now, reviewedById: user.id, historyAccess: "none", historyRequestedAt: null, historyReviewedAt: null, historyReviewedBy: null },
        });
        await tx.studyGroup.update({ where: { id: group.id }, data: { memberCount: active + 1 } });
      });
      const joined = await prisma.user.findUnique({ where: { id: targetId }, select: { name: true, nickname: true, email: true } });
      await systemMessage(group.id, `${displayName({ name: joined?.nickname || joined?.name, email: joined?.email })} joined`);
    }
    publishToUsers([targetId], { type: "group.member", data: { groupId: group.id, userId: targetId, status: action === "approve" ? "active" : "rejected" } });
    publishToUsers(await moderatorIds(group.id), { type: "group.request", data: { groupId: group.id, kind: "join" } });
    await prisma.notification.create({
      data: {
        userId: targetId, createdById: user.id, type: "general",
        title: action === "approve" ? `You're in: ${group.name}` : `Request declined: ${group.name}`,
        body: action === "approve" ? "Your request to join the study group was approved." : "Your request to join the study group was declined.",
        data: { kind: "study_group", groupId: group.id, link: action === "approve" ? `/dashboard/groups/${group.id}` : "/dashboard/groups" },
      },
    }).catch(() => {});
    res.json({ ok: true, status: action === "approve" ? "active" : "rejected" });
  } catch (err) {
    send(res, err);
  }
}

export async function setMemberRole(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group } = await requireRole(String(req.params.id), user.id, "creator");
    const role = z.enum(["moderator", "member"]).parse(req.body?.role);
    const targetId = String(req.params.userId);
    if (targetId === user.id) throw new HttpError(400, "You're the creator. Transfer ownership to change your own role.");
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "study_groups" WHERE "id" = $1 FOR UPDATE`, group.id);
      const target = await tx.studyGroupMember.findUnique({ where: { groupId_userId: { groupId: group.id, userId: targetId } } });
      if (!target || target.status !== "active") throw new HttpError(404, "That person isn't an active member");
      if (target.role === role) return target;
      if (role === "moderator") {
        const mods = await tx.studyGroupMember.count({ where: { groupId: group.id, status: "active", role: "moderator" } });
        if (mods >= MAX_MODERATORS) throw new HttpError(409, `A group can have up to ${MAX_MODERATORS} moderators. Remove one first.`, "moderator_limit");
      }
      return tx.studyGroupMember.update({ where: { id: target.id }, data: { role } });
    });
    const u = await prisma.user.findUnique({ where: { id: targetId }, select: { name: true, nickname: true, email: true } });
    await systemMessage(group.id, role === "moderator" ? `${displayName({ name: u?.nickname || u?.name, email: u?.email })} is now a moderator` : `${displayName({ name: u?.nickname || u?.name, email: u?.email })} is no longer a moderator`);
    publishToGroup(group.id, { type: "group.member", data: { groupId: group.id, userId: targetId, role } }).catch(() => {});
    res.json({ ok: true, role: result.role });
  } catch (err) {
    send(res, err);
  }
}

export async function removeMember(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id, "moderator");
    const targetId = String(req.params.userId);
    if (targetId === user.id) throw new HttpError(400, "Use Leave group to leave");
    const target = await membership(group.id, targetId);
    if (!target || target.status !== "active") throw new HttpError(404, "That person isn't an active member");
    if (target.role === "creator") throw new HttpError(403, "The creator can't be removed");
    if (member.role === "moderator" && target.role !== "member") throw new HttpError(403, "Moderators can only remove members");
    await prisma.studyGroupMember.update({ where: { id: target.id }, data: { status: "removed", role: "member", reviewedAt: new Date(), reviewedById: user.id } });
    await refreshMemberCount(group.id);
    const u = await prisma.user.findUnique({ where: { id: targetId }, select: { name: true, nickname: true, email: true } });
    await systemMessage(group.id, `${displayName(user)} removed ${displayName({ name: u?.nickname || u?.name, email: u?.email })}`);
    publishToUsers([targetId], { type: "group.removed", data: { groupId: group.id, reason: "removed" } });
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
}

export async function leaveGroup(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id);
    if (member.role === "creator") {
      const others = await prisma.studyGroupMember.count({ where: { groupId: group.id, status: "active", userId: { not: user.id } } });
      if (others > 0) throw new HttpError(409, "Make someone else the creator before you leave, or delete the group.", "creator_must_transfer");
      await prisma.studyGroup.update({ where: { id: group.id }, data: { archived: true } });
      await prisma.studyGroupMember.update({ where: { id: member.id }, data: { status: "left" } });
      return res.json({ ok: true, archived: true });
    }
    await prisma.studyGroupMember.update({ where: { id: member.id }, data: { status: "left", role: "member" } });
    await refreshMemberCount(group.id);
    await systemMessage(group.id, `${displayName(user)} left`);
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
}

export async function transferOwnership(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id, "creator");
    const targetId = z.string().min(1).parse(req.body?.userId);
    const target = await membership(group.id, targetId);
    if (!target || target.status !== "active") throw new HttpError(404, "Choose an active member");
    await prisma.$transaction([
      prisma.studyGroupMember.update({ where: { id: target.id }, data: { role: "creator", historyAccess: "granted" } }),
      prisma.studyGroupMember.update({ where: { id: member.id }, data: { role: "member" } }),
      prisma.studyGroup.update({ where: { id: group.id }, data: { createdById: targetId } }),
    ]);
    const u = await prisma.user.findUnique({ where: { id: targetId }, select: { name: true, nickname: true, email: true } });
    await systemMessage(group.id, `${displayName({ name: u?.nickname || u?.name, email: u?.email })} is now the group creator`);
    publishToGroup(group.id, { type: "group.updated", data: { groupId: group.id } }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
}

// ─── Older-message access ────────────────────────────────────────────────────

export async function requestHistory(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id);
    if (member.role !== "member" || member.historyAccess === "granted") return res.json({ historyAccess: "granted" });
    if (member.historyAccess === "pending") return res.json({ historyAccess: "pending" });
    if (!member.joinedAt || member.joinedAt <= group.createdAt) throw new HttpError(400, "There are no earlier messages");
    await prisma.studyGroupMember.update({ where: { id: member.id }, data: { historyAccess: "pending", historyRequestedAt: new Date() } });
    publishToUsers(await moderatorIds(group.id), { type: "group.request", data: { groupId: group.id, kind: "history" } });
    res.json({ historyAccess: "pending" });
  } catch (err) {
    send(res, err);
  }
}

export async function reviewHistory(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group } = await requireRole(String(req.params.id), user.id, "moderator");
    const action = z.enum(["approve", "reject"]).parse(req.body?.action);
    const target = await membership(group.id, String(req.params.userId));
    if (!target || target.status !== "active" || target.historyAccess !== "pending") throw new HttpError(404, "That request is no longer pending");
    const historyAccess = action === "approve" ? "granted" : "rejected";
    await prisma.studyGroupMember.update({ where: { id: target.id }, data: { historyAccess, historyReviewedAt: new Date(), historyReviewedBy: user.id } });
    publishToUsers([target.userId], { type: "group.history", data: { groupId: group.id, historyAccess } });
    publishToUsers(await moderatorIds(group.id), { type: "group.request", data: { groupId: group.id, kind: "history" } });
    res.json({ ok: true, historyAccess });
  } catch (err) {
    send(res, err);
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function listMessages(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
    const floor = member.historyAccess === "granted" || member.role !== "member" ? group.createdAt : member.joinedAt || member.createdAt;
    const and: Prisma.StudyGroupMessageWhereInput[] = [{ groupId: group.id }, { createdAt: { gte: floor } }];
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const beforeId = req.query.beforeId ? String(req.query.beforeId) : null;
    const after = req.query.after ? new Date(String(req.query.after)) : null;
    if (before && !isNaN(before.getTime())) {
      and.push(beforeId ? { OR: [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: beforeId } }] } : { createdAt: { lt: before } });
    }
    if (after && !isNaN(after.getTime())) and.push({ createdAt: { gt: after } });
    const rows = await prisma.studyGroupMessage.findMany({
      where: { AND: and },
      include: { sender: { select: senderSelect } },
      orderBy: after ? [{ createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    if (!after) page.reverse();
    const viewer = { joinedAt: member.role === "member" ? member.joinedAt : null, historyAccess: member.historyAccess };
    res.json({
      messages: page.map((m) => messageView(m, viewer)),
      hasMore,
      // tells a later-joining member there is history they can ask for
      historyLocked: member.role === "member" && member.historyAccess !== "granted" && Boolean(member.joinedAt && member.joinedAt > group.createdAt),
      historyAccess: member.historyAccess,
    });
  } catch (err) {
    send(res, err);
  }
}

const attachmentSchema = z.object({
  url: z.string().url(),
  name: z.string().max(180).optional().nullable(),
  kind: z.enum(["image", "video", "document"]),
  duration: z.number().nonnegative().optional().nullable(),
  width: z.number().int().nonnegative().optional().nullable(),
  height: z.number().int().nonnegative().optional().nullable(),
  thumbnailUrl: z.string().url().optional().nullable(),
});

const messageSchema = z.object({
  clientId: z.string().trim().min(6).max(64).optional(),
  text: z.string().max(4000, "Messages can be up to 4,000 characters").optional().nullable(),
  attachment: attachmentSchema.optional().nullable(),
});

const recentSends = new Map<string, number[]>();
function rateLimited(userId: string) {
  const now = Date.now();
  const list = (recentSends.get(userId) || []).filter((t) => now - t < 10_000);
  list.push(now);
  recentSends.set(userId, list);
  return list.length > 20;
}

export async function sendMessage(req: Request, res: Response) {
  try {
    const user = await me(req);
    { const muted = mutedMessage(req); if (muted) throw new HttpError(403, muted, "muted"); }
    const { group, member } = await requireRole(String(req.params.id), user.id);
    const body = messageSchema.parse(req.body);
    const text = (body.text || "").trim();
    if (!text && !body.attachment) throw new HttpError(400, "Type a message or attach a file");
    if (body.clientId) {
      const dup = await prisma.studyGroupMessage.findUnique({ where: { groupId_clientId: { groupId: group.id, clientId: body.clientId } }, include: { sender: { select: senderSelect } } });
      if (dup) return res.status(200).json({ message: messageView(dup, { joinedAt: null, historyAccess: member.historyAccess }) });
    }
    if (rateLimited(user.id)) throw new HttpError(429, "You're sending messages too quickly. Wait a few seconds.");

    let att: Awaited<ReturnType<typeof verifyAttachment>> | null = null;
    if (body.attachment) att = await verifyAttachment(body.attachment);
    const type = att ? att.kind : "text";
    const thumb = body.attachment?.thumbnailUrl && body.attachment.thumbnailUrl.startsWith("https://res.cloudinary.com/") ? body.attachment.thumbnailUrl : null;

    let msg: any;
    try {
      msg = await prisma.studyGroupMessage.create({
        data: {
          groupId: group.id, senderId: user.id, type, text: text || null, clientId: body.clientId || null,
          attachmentUrl: att?.url, attachmentName: att?.name, attachmentMime: att?.mime, attachmentBytes: att?.bytes,
          attachmentWidth: att?.width ?? null, attachmentHeight: att?.height ?? null,
          attachmentDuration: att?.duration ? Math.round(att.duration) : null, thumbnailUrl: thumb,
        },
        include: { sender: { select: senderSelect } },
      });
    } catch (err: any) {
      if (err?.code === "P2002" && body.clientId) {
        const dup = await prisma.studyGroupMessage.findUnique({ where: { groupId_clientId: { groupId: group.id, clientId: body.clientId } }, include: { sender: { select: senderSelect } } });
        if (dup) return res.status(200).json({ message: messageView(dup, { joinedAt: null, historyAccess: "granted" }) });
      }
      throw err;
    }
    await prisma.$transaction([
      prisma.studyGroup.update({
        where: { id: group.id },
        data: { lastMessageAt: msg.createdAt, lastMessagePreview: preview(type, text, att?.name), lastMessageSender: displayName({ name: user.name, email: user.email }), lastMessageType: type },
      }),
      prisma.studyGroupMember.update({ where: { id: member.id }, data: { lastReadAt: msg.createdAt } }),
    ]);
    const view = messageView(msg, { joinedAt: null, historyAccess: "granted" });
    publishToGroup(group.id, { type: "group.message", data: { groupId: group.id, message: view } }).catch(() => {});
    res.status(201).json({ message: view });
  } catch (err) {
    send(res, err);
  }
}

export async function deleteMessage(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id);
    const msg = await prisma.studyGroupMessage.findUnique({ where: { id: String(req.params.messageId) } });
    if (!msg || msg.groupId !== group.id || msg.deletedAt) throw new HttpError(404, "Message not found");
    if (msg.type === "system") throw new HttpError(400, "System messages can't be deleted");
    if (msg.senderId !== user.id && member.role === "member") throw new HttpError(403, "You can only delete your own messages");
    await prisma.studyGroupMessage.update({ where: { id: msg.id }, data: { deletedAt: new Date(), deletedById: user.id, text: null, attachmentUrl: null, thumbnailUrl: null, archive: { text: msg.text, attachmentUrl: msg.attachmentUrl, thumbnailUrl: msg.thumbnailUrl } } });
    publishToGroup(group.id, { type: "group.message.deleted", data: { groupId: group.id, messageId: msg.id } }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
}

export async function markRead(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { member } = await requireRole(String(req.params.id), user.id);
    await prisma.studyGroupMember.update({ where: { id: member.id }, data: { lastReadAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
}

/** Save a shared document to the member's personal Materials page. */
export async function saveMessageMaterial(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group, member } = await requireRole(String(req.params.id), user.id);
    const msg = await prisma.studyGroupMessage.findUnique({ where: { id: String(req.params.messageId) }, include: { sender: { select: senderSelect } } });
    if (!msg || msg.groupId !== group.id || msg.deletedAt || !msg.attachmentUrl) throw new HttpError(404, "File not found");
    const viewer = { joinedAt: member.role === "member" ? member.joinedAt : null, historyAccess: member.historyAccess };
    const floor = member.role !== "member" || member.historyAccess === "granted" ? group.createdAt : member.joinedAt;
    if (floor && msg.createdAt < floor) throw new HttpError(403, "You don't have access to this message");
    if (messageView(msg, viewer).withheld) throw new HttpError(403, "Large files from earlier history aren't shared with new members");
    const materialId = `group-msg-${msg.id}`;
    const id = `${user.id}:${materialId}`;
    const title = (msg.attachmentName || "Group file").replace(/\.[a-z0-9]{2,5}$/i, "");
    const meta = {
      materialId, title, fileName: msg.attachmentName, fileUrl: msg.attachmentUrl, url: msg.attachmentUrl,
      courseCode: group.courseCode || "STUDY GROUPS", courseTitle: group.courseCode ? group.name : "Saved from study groups",
      description: `Shared in ${group.name}${msg.sender ? ` by ${msg.sender.nickname || msg.sender.name || "a member"}` : ""}`,
      source: "study_group", groupId: group.id, groupName: group.name, messageId: msg.id, bytes: msg.attachmentBytes, mime: msg.attachmentMime,
      savedAt: new Date().toISOString(),
    };
    const save = await prisma.materialSave.upsert({
      where: { id },
      create: { id, userId: user.id, materialId, title, url: msg.attachmentUrl, meta },
      update: { title, url: msg.attachmentUrl, meta },
    });
    res.status(201).json({ save });
  } catch (err) {
    send(res, err);
  }
}

// ─── Course reps: invite their scope ─────────────────────────────────────────

export async function inviteScope(req: Request, res: Response) {
  try {
    const user = await me(req);
    const { group } = await requireRole(String(req.params.id), user.id, "moderator");
    if (!group.official) throw new HttpError(400, "Only departmental groups can invite a whole class. Share the link instead.");
    if (user.role !== "courseRep" && !isStaffRole(user.role)) throw new HttpError(403, "Only course representatives can invite their class");
    if (group.lastScopeInviteAt && Date.now() - group.lastScopeInviteAt.getTime() < 6 * 3600_000) {
      throw new HttpError(429, "Your class was invited recently. You can send another invite in a few hours.");
    }
    const where: Prisma.UserWhereInput = {
      status: "active",
      id: { not: user.id },
      studyGroupMemberships: { none: { groupId: group.id, status: { in: ["active", "pending"] } } },
      ...(group.institutionId === "uofa" ? { OR: [{ institutionId: "uofa" }, { institutionId: null }] } : { institutionId: group.institutionId }),
    };
    const candidates = await prisma.user.findMany({
      where,
      select: { id: true, role: true, name: true, email: true, photoUrl: true, avatarUrl: true, institutionId: true, faculty: true, department: true, program: true, level: true, courseRepMeta: true },
      take: 5000,
    });
    const eligible = candidates.filter((c) => !isStaffRole(c.role) && eligibleForScope(c as ScopedUser, group)).slice(0, 1000);
    if (eligible.length) {
      await prisma.notification.createMany({
        data: eligible.map((c) => ({
          userId: c.id, createdById: user.id, type: "general" as const,
          title: `Join ${group.name}`,
          body: `${displayName(user)} invited your class to a study group${scopeLabel(group) ? ` for ${scopeLabel(group)}` : ""}.`,
          data: { kind: "study_group_invite", groupId: group.id, code: group.code, link: `/study/${group.code}` },
        })),
      });
    }
    await prisma.studyGroup.update({ where: { id: group.id }, data: { lastScopeInviteAt: new Date() } });
    publishToUsers(eligible.map((e) => e.id), { type: "notification", data: { kind: "study_group_invite", groupId: group.id } });
    res.json({ ok: true, invited: eligible.length });
  } catch (err) {
    send(res, err);
  }
}
