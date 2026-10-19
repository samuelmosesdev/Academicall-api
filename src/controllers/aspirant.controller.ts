/**
 * Aspirants and Aspirant Houses.
 *
 *  - An aspirant picks one or two institutions of choice (first choice required).
 *  - Each institution has one Aspirant House; choosing an institution makes you a member.
 *  - House Leaders (duty "houseLeader", houses picked by an admin) start threads, pin them,
 *    mention members and manage membership. Members reply.
 *  - Admins (and agents with aspirants.* / houses.manage) see every aspirant and every house.
 */
import { Request, Response } from "express";
import { assertNotMuted } from "../lib/moderation";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { handle, HttpError, pageParams } from "../lib/http";
import { hasCap, isHouseLeader, outranks } from "../lib/access";
import { audit } from "../lib/audit";
import { notifyMany, institutionTitle } from "../lib/notify";
import { publishToUsers } from "../lib/realtime";

const personSelect = { id: true, name: true, nickname: true, photoUrl: true, avatarUrl: true, role: true, staffTags: true } as const;
const instSelect = { id: true, name: true, displayName: true, abbreviation: true, state: true, ownership: true, type: true } as const;
const personOut = (u: any) =>
  u ? { id: u.id, name: u.name || u.nickname || "Member", photoUrl: u.photoUrl || u.avatarUrl || null, role: u.role, leader: (u.staffTags || []).includes("houseLeader") } : { id: null, name: "Former member", photoUrl: null };

const canAdminHouses = (who: any) => hasCap(who, "houses.manage");

// ── memberships ──────────────────────────────────────────────────────────────
export async function ensureHouse(institutionId: string) {
  const existing = await prisma.aspirantHouse.findUnique({ where: { institutionId } });
  if (existing) return existing;
  const inst = await prisma.institution.findUnique({ where: { id: institutionId }, select: instSelect });
  if (!inst) throw new HttpError(400, "That institution isn't on Academicall");
  return prisma.aspirantHouse.upsert({
    where: { institutionId },
    create: { institutionId, name: `${institutionTitle(inst)} House`, motto: "Aspirants helping aspirants get in." },
    update: {},
  });
}

async function refreshMemberCount(houseId: string) {
  const memberCount = await prisma.aspirantHouseMember.count({ where: { houseId, status: { not: "removed" } } });
  await prisma.aspirantHouse.update({ where: { id: houseId }, data: { memberCount } });
}

/** Make the aspirant a member of exactly the houses of their choices. Removed members stay removed. */
export async function syncMemberships(userId: string) {
  const choices = await prisma.aspiration.findMany({ where: { userId }, orderBy: { rank: "asc" } });
  const touched = new Set<string>();
  const keep = new Set<string>();
  for (const c of choices) {
    const house = await ensureHouse(c.institutionId);
    keep.add(house.id);
    touched.add(house.id);
    await prisma.aspirantHouseMember.upsert({
      where: { houseId_userId: { houseId: house.id, userId } },
      create: { houseId: house.id, userId, choiceRank: c.rank },
      update: { choiceRank: c.rank },
    });
  }
  const stale = await prisma.aspirantHouseMember.findMany({ where: { userId, houseId: { notIn: [...keep] } }, select: { id: true, houseId: true, status: true } });
  for (const m of stale) {
    touched.add(m.houseId);
    // Keep the row of someone a leader removed, so re-choosing the institution doesn't undo it.
    if (m.status === "removed") await prisma.aspirantHouseMember.update({ where: { id: m.id }, data: { choiceRank: null } });
    else await prisma.aspirantHouseMember.delete({ where: { id: m.id } });
  }
  for (const id of touched) await refreshMemberCount(id);
}

// ── aspirant self-service ────────────────────────────────────────────────────
const choiceSchema = z.object({
  institutionId: z.string().min(1, "Pick an institution"),
  course: z.string().trim().max(160).optional().nullable(),
  programId: z.string().max(120).optional().nullable(),
});
const metaSchema = z.object({
  utmeYear: z.coerce.number().int().min(2000).max(2100).optional().nullable(),
  utmeScore: z.coerce.number().int().min(0).max(400).optional().nullable(),
  stateOfOrigin: z.string().trim().max(60).optional().nullable(),
  jambRegNo: z.string().trim().max(30).optional().nullable(),
}).partial();
const aspirantSchema = z.object({
  firstChoice: choiceSchema,
  secondChoice: choiceSchema.nullable().optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  photoUrl: z.string().max(2_000_000).optional().nullable(),
  meta: metaSchema.optional(),
});

async function saveChoices(userId: string, body: z.infer<typeof aspirantSchema>) {
  const second = body.secondChoice && body.secondChoice.institutionId ? body.secondChoice : null;
  if (second && second.institutionId === body.firstChoice.institutionId) throw new HttpError(400, "Your second choice must be a different institution");
  const ids = [body.firstChoice.institutionId, ...(second ? [second.institutionId] : [])];
  const found = await prisma.institution.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw new HttpError(400, "Pick institutions from the list");
  await prisma.$transaction([
    prisma.aspiration.deleteMany({ where: { userId } }),
    prisma.aspiration.create({ data: { userId, rank: 1, institutionId: body.firstChoice.institutionId, course: body.firstChoice.course || null, programId: body.firstChoice.programId || null } }),
    ...(second ? [prisma.aspiration.create({ data: { userId, rank: 2, institutionId: second.institutionId, course: second.course || null, programId: second.programId || null } })] : []),
  ]);
  await syncMemberships(userId);
}

async function aspirantView(userId: string) {
  const [user, memberships, leads] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true, photoUrl: true, role: true, aspirantMeta: true, createdAt: true, aspirations: { orderBy: { rank: "asc" }, include: { institution: { select: instSelect } } } },
    }),
    prisma.aspirantHouseMember.findMany({ where: { userId, status: { not: "removed" } }, include: { house: { include: { institution: { select: instSelect } } } }, orderBy: { choiceRank: "asc" } }),
    prisma.aspirantHouseLeader.findMany({ where: { userId }, select: { houseId: true } }),
  ]);
  const houseIds = [...new Set([...memberships.map((m) => m.houseId), ...leads.map((l) => l.houseId)])];
  const pinned = houseIds.length
    ? await prisma.houseThread.findMany({
      where: { houseId: { in: houseIds }, pinned: true, deletedAt: null },
      orderBy: { pinnedAt: "desc" }, take: 12,
      include: { author: { select: personSelect }, house: { select: { id: true, name: true } } },
    })
    : [];
  const unread = await Promise.all(memberships.map((m) => prisma.houseThread.count({ where: { houseId: m.houseId, deletedAt: null, createdAt: { gt: m.lastReadAt || m.joinedAt } } })));
  return {
    profile: user,
    houses: memberships.map((m, i) => ({ ...houseOut(m.house), choiceRank: m.choiceRank, memberStatus: m.status, unread: unread[i] })),
    pinned: pinned.map((t) => ({ ...threadOut(t), house: t.house })),
  };
}

/** GET /aspirant/me */
export const getMe = handle(async (req, res) => {
  if (req.user!.role !== "aspirant") throw new HttpError(403, "This is for aspirants");
  res.json(await aspirantView(req.user!.id));
});

/**
 * PUT /aspirant/me — save institutions of choice (+ details). Also how a brand-new account
 * (a student account that hasn't finished setup, e.g. after Google sign-in) becomes an aspirant.
 */
export const saveMe = handle(async (req, res) => {
  const me = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!me) throw new HttpError(404, "Account not found");
  const becoming = me.role === "user" && !me.profileComplete;
  if (me.role !== "aspirant" && !becoming) throw new HttpError(403, "Only aspirants choose institutions of choice");
  const body = aspirantSchema.parse(req.body || {});
  await saveChoices(me.id, body);
  const meta = { ...((me.aspirantMeta as object) || {}), ...(body.meta || {}) };
  await prisma.user.update({
    where: { id: me.id },
    data: {
      role: "aspirant",
      profileComplete: true,
      aspirantMeta: meta as any,
      ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
      ...(body.photoUrl ? { photoUrl: body.photoUrl } : {}),
    },
  });
  res.json(await aspirantView(me.id));
});

/** POST /aspirant/me/admitted — "I got admission": becomes a student and sets up their programme. */
export const markAdmitted = handle(async (req, res) => {
  if (req.user!.role !== "aspirant") throw new HttpError(403, "This is for aspirants");
  const first = await prisma.aspiration.findFirst({ where: { userId: req.user!.id, rank: 1 } });
  const institutionId = typeof req.body?.institutionId === "string" ? req.body.institutionId : first?.institutionId || null;
  const left = await prisma.aspirantHouseMember.findMany({ where: { userId: req.user!.id }, select: { houseId: true } });
  await prisma.aspirantHouseMember.deleteMany({ where: { userId: req.user!.id } });
  for (const m of left) await refreshMemberCount(m.houseId);
  await prisma.user.update({ where: { id: req.user!.id }, data: { role: "user", profileComplete: false, institutionId } });
  await audit(req.user, "aspirant.admitted", { id: req.user!.id, label: req.user!.name || req.user!.email }, { institutionId });
  res.json({ ok: true });
});

// ── houses (members + leaders) ───────────────────────────────────────────────
function houseOut(h: any) {
  return {
    id: h.id, name: h.name, motto: h.motto, coverUrl: h.coverUrl, rules: h.rules, memberCount: h.memberCount, threadCount: h.threadCount,
    lastThreadAt: h.lastThreadAt, archived: h.archived,
    institution: h.institution ? { ...h.institution, title: institutionTitle(h.institution) } : undefined,
  };
}
function threadOut(t: any) {
  return {
    id: t.id, houseId: t.houseId, title: t.title, body: t.body, imageUrl: t.imageUrl, pinned: t.pinned, pinnedAt: t.pinnedAt, locked: t.locked,
    replyCount: t.replyCount, lastReplyAt: t.lastReplyAt, createdAt: t.createdAt, updatedAt: t.updatedAt, author: personOut(t.author),
  };
}

async function access(req: Request, houseId: string) {
  const house = await prisma.aspirantHouse.findUnique({ where: { id: houseId }, include: { institution: { select: instSelect } } });
  if (!house) throw new HttpError(404, "House not found");
  const userId = req.user!.id;
  const [leader, member] = await Promise.all([
    prisma.aspirantHouseLeader.findUnique({ where: { houseId_userId: { houseId, userId } } }),
    prisma.aspirantHouseMember.findUnique({ where: { houseId_userId: { houseId, userId } } }),
  ]);
  const isLeader = !!leader && isHouseLeader(req.user);
  const isMod = isLeader || canAdminHouses(req.user);
  const status = member?.status || null;
  const canRead = isMod || status === "active" || status === "muted";
  if (!canRead) throw new HttpError(status === "removed" ? 403 : 404, status === "removed" ? "A House Leader removed you from this house" : "House not found");
  if (house.archived && !isMod) throw new HttpError(403, "This house is closed for now");
  return { house, member, isLeader, isMod, canPost: isMod, canReply: isMod || status === "active", userId };
}

/** GET /houses — houses I belong to or lead. */
export const myHouses = handle(async (req, res) => {
  const userId = req.user!.id;
  const [memberships, leads] = await Promise.all([
    prisma.aspirantHouseMember.findMany({ where: { userId, status: { not: "removed" } }, include: { house: { include: { institution: { select: instSelect } } } }, orderBy: { choiceRank: "asc" } }),
    isHouseLeader(req.user)
      ? prisma.aspirantHouseLeader.findMany({ where: { userId }, include: { house: { include: { institution: { select: instSelect } } } } })
      : Promise.resolve([] as any[]),
  ]);
  const unread = await Promise.all(memberships.map((m) => prisma.houseThread.count({ where: { houseId: m.houseId, deletedAt: null, createdAt: { gt: m.lastReadAt || m.joinedAt } } })));
  res.json({
    member: memberships.map((m, i) => ({ ...houseOut(m.house), choiceRank: m.choiceRank, memberStatus: m.status, unread: unread[i] })),
    leading: leads.map((l: any) => houseOut(l.house)),
  });
});

/** GET /houses/:id */
export const getHouse = handle(async (req, res) => {
  const a = await access(req, String(req.params.id));
  const leaders = await prisma.aspirantHouseLeader.findMany({ where: { houseId: a.house.id }, include: { user: { select: personSelect } } });
  res.json({
    house: houseOut(a.house),
    leaders: leaders.map((l) => personOut(l.user)),
    viewer: { isLeader: a.isLeader, canPost: a.canPost, canModerate: a.isMod, canReply: a.canReply, memberStatus: a.member?.status || null, choiceRank: a.member?.choiceRank || null },
  });
});

/** GET /houses/:id/threads?before= — pinned first, then newest. */
export const listThreads = handle(async (req, res) => {
  const a = await access(req, String(req.params.id));
  const before = typeof req.query.before === "string" ? new Date(req.query.before) : null;
  const take = Math.min(30, Math.max(5, Number(req.query.limit) || 20));
  const [pinned, rows] = await Promise.all([
    before ? Promise.resolve([] as any[]) : prisma.houseThread.findMany({ where: { houseId: a.house.id, pinned: true, deletedAt: null }, orderBy: { pinnedAt: "desc" }, include: { author: { select: personSelect } } }),
    prisma.houseThread.findMany({
      where: { houseId: a.house.id, pinned: false, deletedAt: null, ...(before && !isNaN(+before) ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: "desc" }, take: take + 1, include: { author: { select: personSelect } },
    }),
  ]);
  const page = rows.slice(0, take);
  res.json({ pinned: pinned.map(threadOut), threads: page.map(threadOut), nextBefore: rows.length > take ? page[page.length - 1].createdAt : null });
});

// Mentions are written as @[Display Name](user:<uuid>) — only House Leaders' mentions notify.
const MENTION_RX = /@\[([^\]\n]{1,80})\]\(user:([0-9a-f-]{36})\)/gi;
async function mentionedMembers(houseId: string, text: string) {
  const ids = [...new Set([...text.matchAll(MENTION_RX)].map((m) => m[2]))].slice(0, 50);
  if (!ids.length) return [] as string[];
  const rows = await prisma.aspirantHouseMember.findMany({ where: { houseId, userId: { in: ids }, status: { not: "removed" } }, select: { userId: true } });
  const leaders = await prisma.aspirantHouseLeader.findMany({ where: { houseId, userId: { in: ids } }, select: { userId: true } });
  return [...new Set([...rows.map((r) => r.userId), ...leaders.map((l) => l.userId)])];
}
/** Non-leaders can't ping people: their mention tokens are flattened to plain @Name. */
const flattenMentions = (text: string) => text.replace(MENTION_RX, (_m, name) => `@${name}`);
const plain = (text: string) => text.replace(MENTION_RX, (_m, name) => `@${name}`).replace(/\s+/g, " ").trim();

const threadSchema = z.object({
  title: z.string().trim().min(3, "Give the thread a title").max(140),
  body: z.string().trim().min(1, "Write something").max(10_000),
  imageUrl: z.string().trim().url().optional().nullable(),
  pinned: z.boolean().optional(),
});

/** POST /houses/:id/threads — House Leaders only. Every member is notified. */
export const createThread = handle(async (req, res) => {
  assertNotMuted(req);
  const a = await access(req, String(req.params.id));
  if (!a.canPost) throw new HttpError(403, "Only House Leaders start threads. You can reply to any thread.");
  const body = threadSchema.parse(req.body || {});
  const mentions = await mentionedMembers(a.house.id, body.body);
  const now = new Date();
  const thread = await prisma.houseThread.create({
    data: { houseId: a.house.id, authorId: a.userId, title: body.title, body: body.body, imageUrl: body.imageUrl || null, mentions, pinned: !!body.pinned, pinnedAt: body.pinned ? now : null },
    include: { author: { select: personSelect } },
  });
  await prisma.aspirantHouse.update({ where: { id: a.house.id }, data: { threadCount: { increment: 1 }, lastThreadAt: now } });
  const members = await prisma.aspirantHouseMember.findMany({ where: { houseId: a.house.id, status: { in: ["active", "muted"] }, userId: { not: a.userId } }, select: { userId: true } });
  const link = `/dashboard/house/${a.house.id}/t/${thread.id}`;
  const others = members.map((m) => m.userId).filter((id) => !mentions.includes(id));
  await notifyMany(others, { type: "house", title: `${a.house.name}: ${body.title}`, body: plain(body.body).slice(0, 160), data: { houseId: a.house.id, threadId: thread.id, link }, createdById: a.userId });
  await notifyMany(mentions.filter((id) => id !== a.userId), { type: "house", title: `${req.user!.name || "A House Leader"} mentioned you in ${a.house.name}`, body: body.title, data: { houseId: a.house.id, threadId: thread.id, link, mention: true }, createdById: a.userId });
  publishToUsers(members.map((m) => m.userId), { type: "house.thread", data: { houseId: a.house.id, threadId: thread.id } });
  res.status(201).json({ thread: threadOut(thread) });
});

/** GET /houses/:id/threads/:threadId — thread + replies. */
export const getThread = handle(async (req, res) => {
  const a = await access(req, String(req.params.id));
  const thread = await prisma.houseThread.findFirst({ where: { id: String(req.params.threadId), houseId: a.house.id, deletedAt: null }, include: { author: { select: personSelect } } });
  if (!thread) throw new HttpError(404, "Thread not found");
  const replies = await prisma.houseReply.findMany({ where: { threadId: thread.id, deletedAt: null }, orderBy: { createdAt: "asc" }, take: 500, include: { author: { select: personSelect } } });
  res.json({
    thread: threadOut(thread),
    replies: replies.map((r) => ({ id: r.id, body: r.body, imageUrl: r.imageUrl, createdAt: r.createdAt, author: personOut(r.author), mine: r.authorId === a.userId, canDelete: r.authorId === a.userId || a.isMod })),
  });
});

/** PATCH /houses/:id/threads/:threadId — edit, pin/unpin, lock/unlock (leaders). */
export const updateThread = handle(async (req, res) => {
  const a = await access(req, String(req.params.id));
  if (!a.isMod) throw new HttpError(403, "Only House Leaders manage threads");
  const thread = await prisma.houseThread.findFirst({ where: { id: String(req.params.threadId), houseId: a.house.id, deletedAt: null } });
  if (!thread) throw new HttpError(404, "Thread not found");
  const body = threadSchema.partial().extend({ locked: z.boolean().optional() }).parse(req.body || {});
  const data: Prisma.HouseThreadUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.body !== undefined) { data.body = body.body; data.mentions = await mentionedMembers(a.house.id, body.body); }
  if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl || null;
  if (body.locked !== undefined) data.locked = body.locked;
  if (body.pinned !== undefined) { data.pinned = body.pinned; data.pinnedAt = body.pinned ? new Date() : null; }
  const updated = await prisma.houseThread.update({ where: { id: thread.id }, data, include: { author: { select: personSelect } } });
  if (body.pinned && !thread.pinned) {
    const members = await prisma.aspirantHouseMember.findMany({ where: { houseId: a.house.id, status: { in: ["active", "muted"] } }, select: { userId: true } });
    await notifyMany(members.map((m) => m.userId), { type: "house", title: `📌 Pinned in ${a.house.name}`, body: updated.title, data: { houseId: a.house.id, threadId: thread.id, link: `/dashboard/house/${a.house.id}/t/${thread.id}` }, createdById: a.userId });
  }
  const memberIds = (await prisma.aspirantHouseMember.findMany({ where: { houseId: a.house.id, status: { not: "removed" } }, select: { userId: true } })).map((m) => m.userId);
  publishToUsers(memberIds, { type: "house.thread", data: { houseId: a.house.id, threadId: thread.id } });
  res.json({ thread: threadOut(updated) });
});

/** DELETE /houses/:id/threads/:threadId */
export const deleteThread = handle(async (req, res) => {
  const a = await access(req, String(req.params.id));
  if (!a.isMod) throw new HttpError(403, "Only House Leaders remove threads");
  const thread = await prisma.houseThread.findFirst({ where: { id: String(req.params.threadId), houseId: a.house.id, deletedAt: null } });
  if (!thread) throw new HttpError(404, "Thread not found");
  await prisma.$transaction([
    prisma.houseThread.update({ where: { id: thread.id }, data: { deletedAt: new Date(), pinned: false } }),
    prisma.aspirantHouse.update({ where: { id: a.house.id }, data: { threadCount: { decrement: 1 } } }),
  ]);
  await audit(req.user, "house.thread.delete", { id: thread.id, label: thread.title }, { houseId: a.house.id });
  res.json({ ok: true });
});

const replySchema = z.object({ body: z.string().trim().min(1, "Write a reply").max(4000), imageUrl: z.string().trim().url().optional().nullable() });
const recentReplies = new Map<string, number[]>();

/** POST /houses/:id/threads/:threadId/replies */
export const addReply = handle(async (req, res) => {
  assertNotMuted(req);
  const a = await access(req, String(req.params.id));
  if (!a.canReply) throw new HttpError(403, a.member?.status === "muted" ? "A House Leader has muted you here. You can still read." : "You can't reply in this house");
  const thread = await prisma.houseThread.findFirst({ where: { id: String(req.params.threadId), houseId: a.house.id, deletedAt: null } });
  if (!thread) throw new HttpError(404, "Thread not found");
  if (thread.locked && !a.isMod) throw new HttpError(403, "This thread is closed for replies");
  const now = Date.now();
  const hits = (recentReplies.get(a.userId) || []).filter((t) => now - t < 60_000);
  hits.push(now); recentReplies.set(a.userId, hits);
  if (hits.length > 8 && !a.isMod) throw new HttpError(429, "You're replying very fast. Give it a minute.");
  const parsed = replySchema.parse(req.body || {});
  const text = a.isMod ? parsed.body : flattenMentions(parsed.body);
  const mentions = a.isMod ? await mentionedMembers(a.house.id, text) : [];
  const [reply] = await prisma.$transaction([
    prisma.houseReply.create({ data: { threadId: thread.id, authorId: a.userId, body: text, imageUrl: parsed.imageUrl || null, mentions }, include: { author: { select: personSelect } } }),
    prisma.houseThread.update({ where: { id: thread.id }, data: { replyCount: { increment: 1 }, lastReplyAt: new Date() } }),
  ]);
  const link = `/dashboard/house/${a.house.id}/t/${thread.id}`;
  if (mentions.length) await notifyMany(mentions.filter((id) => id !== a.userId), { type: "house", title: `${req.user!.name || "A House Leader"} mentioned you in ${a.house.name}`, body: plain(text).slice(0, 160), data: { houseId: a.house.id, threadId: thread.id, link, mention: true }, createdById: a.userId });
  if (thread.authorId && thread.authorId !== a.userId && !mentions.includes(thread.authorId)) {
    await notifyMany([thread.authorId], { type: "house", title: `New reply on “${thread.title}”`, body: plain(text).slice(0, 160), data: { houseId: a.house.id, threadId: thread.id, link }, createdById: a.userId });
  }
  const memberIds = (await prisma.aspirantHouseMember.findMany({ where: { houseId: a.house.id, status: { not: "removed" } }, select: { userId: true } })).map((m) => m.userId);
  const leaderIds = (await prisma.aspirantHouseLeader.findMany({ where: { houseId: a.house.id }, select: { userId: true } })).map((l) => l.userId);
  publishToUsers([...memberIds, ...leaderIds], { type: "house.reply", data: { houseId: a.house.id, threadId: thread.id, replyId: reply.id } });
  res.status(201).json({ reply: { id: reply.id, body: reply.body, imageUrl: reply.imageUrl, createdAt: reply.createdAt, author: personOut(reply.author), mine: true, canDelete: true } });
});

/** DELETE /houses/:id/replies/:replyId — your own, or any as a leader. */
export const deleteReply = handle(async (req, res) => {
  const a = await access(req, String(req.params.id));
  const reply = await prisma.houseReply.findUnique({ where: { id: String(req.params.replyId) }, include: { thread: { select: { houseId: true, id: true } } } });
  if (!reply || reply.deletedAt || reply.thread.houseId !== a.house.id) throw new HttpError(404, "Reply not found");
  if (reply.authorId !== a.userId && !a.isMod) throw new HttpError(403, "You can only delete your own replies");
  await prisma.$transaction([
    prisma.houseReply.update({ where: { id: reply.id }, data: { deletedAt: new Date(), deletedById: a.userId } }),
    prisma.houseThread.update({ where: { id: reply.thread.id }, data: { replyCount: { decrement: 1 } } }),
  ]);
  res.json({ ok: true });
});

/** POST /houses/:id/read */
export const markRead = handle(async (req, res) => {
  const houseId = String(req.params.id);
  await prisma.aspirantHouseMember.updateMany({ where: { houseId, userId: req.user!.id }, data: { lastReadAt: new Date() } });
  res.json({ ok: true });
});

/** GET /houses/:id/members?q=&status=&page= — leaders and admins; also feeds the @mention picker. */
export const listMembers = handle(async (req, res) => {
  const a = await access(req, String(req.params.id));
  if (!a.isMod) throw new HttpError(403, "Only House Leaders see the member list");
  const q = String(req.query.q || "").trim();
  const status = ["active", "muted", "removed"].includes(String(req.query.status)) ? String(req.query.status) : undefined;
  const { page, pageSize, skip, take } = pageParams(req.query, { def: 30, max: 100 });
  const where: Prisma.AspirantHouseMemberWhereInput = {
    houseId: a.house.id,
    ...(status ? { status } : { status: { not: "removed" } }),
    ...(q ? { user: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { nickname: { contains: q, mode: "insensitive" } }] } } : {}),
  };
  const [total, rows, counts] = await Promise.all([
    prisma.aspirantHouseMember.count({ where }),
    prisma.aspirantHouseMember.findMany({
      where, skip, take, orderBy: [{ joinedAt: "desc" }],
      include: { user: { select: { ...personSelect, email: true, phone: true, aspirantMeta: true, lastActiveAt: true, createdAt: true, aspirations: { orderBy: { rank: "asc" }, include: { institution: { select: instSelect } } } } } },
    }),
    prisma.aspirantHouseMember.groupBy({ by: ["status"], where: { houseId: a.house.id }, _count: true }),
  ]);
  const replyCounts = rows.length
    ? await prisma.houseReply.groupBy({ by: ["authorId"], where: { authorId: { in: rows.map((r) => r.userId) }, deletedAt: null, thread: { houseId: a.house.id } }, _count: true })
    : [];
  const rc = new Map(replyCounts.map((r) => [r.authorId, r._count]));
  res.json({
    page, pageSize, total,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    members: rows.map((m) => ({
      userId: m.userId, status: m.status, reason: m.reason, choiceRank: m.choiceRank, joinedAt: m.joinedAt, replies: rc.get(m.userId) || 0,
      ...personOut(m.user), id: m.userId,
      email: a.isMod ? m.user.email : undefined, phone: a.isMod ? m.user.phone : undefined, lastActiveAt: m.user.lastActiveAt,
      meta: m.user.aspirantMeta, choices: m.user.aspirations.map((c) => ({ rank: c.rank, course: c.course, institution: { ...c.institution, title: institutionTitle(c.institution) } })),
    })),
  });
});

/** PATCH /houses/:id/members/:userId { status: active|muted|removed, reason } */
export const setMemberStatus = handle(async (req, res) => {
  const a = await access(req, String(req.params.id));
  if (!a.isMod) throw new HttpError(403, "Only House Leaders manage members");
  const { status, reason } = z.object({ status: z.enum(["active", "muted", "removed"]), reason: z.string().trim().max(300).optional().nullable() }).parse(req.body || {});
  const userId = String(req.params.userId);
  const m = await prisma.aspirantHouseMember.findUnique({ where: { houseId_userId: { houseId: a.house.id, userId } } });
  if (!m) throw new HttpError(404, "That person isn't in this house");
  if (userId === a.userId) throw new HttpError(400, "You can't change your own membership");
  await prisma.aspirantHouseMember.update({ where: { id: m.id }, data: { status, reason: reason || null, statusById: a.userId } });
  await refreshMemberCount(a.house.id);
  const verb = status === "active" ? "restored you" : status === "muted" ? "muted you" : "removed you";
  await notifyMany([userId], { type: "house", title: `A House Leader ${verb} in ${a.house.name}`, body: reason || (status === "muted" ? "You can still read threads, but can't reply for now." : null), data: { houseId: a.house.id, link: "/dashboard/house" }, createdById: a.userId });
  if (status === "removed") publishToUsers([userId], { type: "house.removed", data: { houseId: a.house.id } });
  await audit(req.user, `house.member.${status}`, { id: userId }, { houseId: a.house.id, reason });
  res.json({ ok: true, status });
});

// ── admin: aspirants ─────────────────────────────────────────────────────────
const aspirantListSelect = {
  id: true, name: true, email: true, phone: true, photoUrl: true, status: true, emailVerified: true, profileComplete: true, aspirantMeta: true,
  lastActiveAt: true, createdAt: true, uniqueId: true,
  aspirations: { orderBy: { rank: "asc" as const }, include: { institution: { select: instSelect } } },
} as const;
const aspirantOut = (u: any) => ({
  ...u,
  choices: (u.aspirations || []).map((c: any) => ({ rank: c.rank, course: c.course, institution: { ...c.institution, title: institutionTitle(c.institution) } })),
  aspirations: undefined,
});

/** GET /admin/aspirants?q=&institutionId=&status=&page= */
export const adminListAspirants = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const institutionId = typeof req.query.institutionId === "string" && req.query.institutionId ? req.query.institutionId : undefined;
  const status = typeof req.query.status === "string" && ["active", "suspended"].includes(req.query.status) ? req.query.status : undefined;
  const { page, pageSize, skip, take } = pageParams(req.query, { def: 25, max: 100 });
  const where: Prisma.UserWhereInput = {
    role: "aspirant",
    status: status ? (status as any) : { not: "deleted" },
    ...(institutionId ? { aspirations: { some: { institutionId } } } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { uniqueId: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [total, rows, all, suspended, newThisWeek, top] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, skip, take, orderBy: { createdAt: "desc" }, select: aspirantListSelect }),
    prisma.user.count({ where: { role: "aspirant", status: { not: "deleted" } } }),
    prisma.user.count({ where: { role: "aspirant", status: "suspended" } }),
    prisma.user.count({ where: { role: "aspirant", status: { not: "deleted" }, createdAt: { gte: new Date(Date.now() - 7 * 864e5) } } }),
    prisma.aspiration.groupBy({ by: ["institutionId"], where: { rank: 1, user: { status: { not: "deleted" }, role: "aspirant" } }, _count: true, orderBy: { _count: { institutionId: "desc" } }, take: 6 }),
  ]);
  const topInst = top.length ? await prisma.institution.findMany({ where: { id: { in: top.map((t) => t.institutionId) } }, select: instSelect }) : [];
  const byId = new Map(topInst.map((i) => [i.id, i]));
  res.json({
    page, pageSize, total,
    stats: { total: all, suspended, newThisWeek, topFirstChoices: top.map((t) => ({ institution: { ...byId.get(t.institutionId), title: institutionTitle(byId.get(t.institutionId)) }, count: t._count })) },
    aspirants: rows.map(aspirantOut),
  });
});

/** GET /admin/aspirants/:id */
export const adminGetAspirant = handle(async (req, res) => {
  const u = await prisma.user.findFirst({ where: { id: String(req.params.id), role: "aspirant" }, select: { ...aspirantListSelect, nickname: true, gender: true, dob: true, bio: true } });
  if (!u) throw new HttpError(404, "Aspirant not found");
  const [memberships, replies] = await Promise.all([
    prisma.aspirantHouseMember.findMany({ where: { userId: u.id }, include: { house: { select: { id: true, name: true } } } }),
    prisma.houseReply.count({ where: { authorId: u.id, deletedAt: null } }),
  ]);
  res.json({ aspirant: aspirantOut(u), memberships: memberships.map((m) => ({ house: m.house, status: m.status, reason: m.reason, choiceRank: m.choiceRank, joinedAt: m.joinedAt })), replies });
});

/** PATCH /admin/aspirants/:id { name, phone, status, meta, firstChoice, secondChoice } */
export const adminUpdateAspirant = handle(async (req, res) => {
  const target = await prisma.user.findFirst({ where: { id: String(req.params.id), role: "aspirant" } });
  if (!target) throw new HttpError(404, "Aspirant not found");
  if (!outranks(req.user!, target)) throw new HttpError(403, "You can't change this account");
  const body = z.object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(30).optional().nullable(),
    status: z.enum(["active", "suspended"]).optional(),
    meta: metaSchema.optional(),
    firstChoice: choiceSchema.optional(),
    secondChoice: choiceSchema.nullable().optional(),
  }).parse(req.body || {});
  if (body.firstChoice) {
    await saveChoices(target.id, { firstChoice: body.firstChoice, secondChoice: body.secondChoice ?? null });
  }
  await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(body.name ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
      ...(body.status ? { status: body.status, ...(body.status === "suspended" ? { sessionsRevokedAt: new Date() } : {}) } : {}),
      ...(body.meta ? { aspirantMeta: { ...((target.aspirantMeta as object) || {}), ...body.meta } as any } : {}),
    },
  });
  await audit(req.user, "aspirant.update", { id: target.id, label: target.name || target.email }, { fields: Object.keys(body) });
  const u = await prisma.user.findUnique({ where: { id: target.id }, select: aspirantListSelect });
  res.json({ aspirant: aspirantOut(u) });
});

// ── admin: houses & leaders ──────────────────────────────────────────────────
/** GET /admin/houses?q=&page= */
export const adminListHouses = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const { page, pageSize, skip, take } = pageParams(req.query, { def: 25, max: 100 });
  const where: Prisma.AspirantHouseWhereInput = q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { institution: { name: { contains: q, mode: "insensitive" } } }, { institution: { abbreviation: { contains: q, mode: "insensitive" } } }] } : {};
  const [total, rows] = await Promise.all([
    prisma.aspirantHouse.count({ where }),
    prisma.aspirantHouse.findMany({ where, skip, take, orderBy: [{ memberCount: "desc" }, { name: "asc" }], include: { institution: { select: instSelect }, leaders: { include: { user: { select: { ...personSelect, email: true } } } } } }),
  ]);
  res.json({ page, pageSize, total, houses: rows.map((h) => ({ ...houseOut(h), leaders: h.leaders.map((l) => ({ ...personOut(l.user), email: l.user.email })) })) });
});

/** POST /admin/houses { institutionId } — open a house before anyone chooses the institution. */
export const adminCreateHouse = handle(async (req, res) => {
  const { institutionId } = z.object({ institutionId: z.string().min(1) }).parse(req.body || {});
  const house = await ensureHouse(institutionId);
  res.status(201).json({ house });
});

/** PATCH /admin/houses/:id */
export const adminUpdateHouse = handle(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(3).max(120).optional(),
    motto: z.string().trim().max(160).optional().nullable(),
    coverUrl: z.string().trim().url().optional().nullable(),
    rules: z.string().trim().max(4000).optional().nullable(),
    archived: z.boolean().optional(),
  }).parse(req.body || {});
  const house = await prisma.aspirantHouse.update({ where: { id: String(req.params.id) }, data: body, include: { institution: { select: instSelect } } });
  await audit(req.user, "house.update", { id: house.id, label: house.name }, { fields: Object.keys(body) });
  res.json({ house: houseOut(house) });
});

/** GET /admin/houses/leader-candidates?q= — people who can lead (students and staff, not aspirants). */
export const leaderCandidates = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ people: [] });
  const people = await prisma.user.findMany({
    where: { status: "active", role: { not: "aspirant" }, OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { uniqueId: { contains: q, mode: "insensitive" } }] },
    select: { ...personSelect, email: true }, take: 12, orderBy: { name: "asc" },
  });
  res.json({ people: people.map((p) => ({ ...personOut(p), email: p.email })) });
});

/** POST /admin/houses/:id/leaders { userId } — also gives the House Leader duty. */
export const addLeader = handle(async (req, res) => {
  if (!hasCap(req.user as any, "users.houseLeader")) throw new HttpError(403, "You need the “Assign House Leaders” permission");
  const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body || {});
  const house = await prisma.aspirantHouse.findUnique({ where: { id: String(req.params.id) } });
  if (!house) throw new HttpError(404, "House not found");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "active") throw new HttpError(404, "Person not found");
  if (user.role === "aspirant") throw new HttpError(400, "Aspirants can't be House Leaders. Pick a student or an agent.");
  if (!(user.staffTags || []).includes("houseLeader")) {
    await prisma.user.update({ where: { id: user.id }, data: { staffTags: [...new Set([...(user.staffTags || []), "houseLeader"])] } });
  }
  await prisma.aspirantHouseLeader.upsert({ where: { houseId_userId: { houseId: house.id, userId } }, create: { houseId: house.id, userId, assignedById: req.user!.id }, update: {} });
  await notifyMany([userId], { type: "house", title: `You're now a House Leader of ${house.name}`, body: "Start threads, pin updates, mention members and manage the house from your House desk.", data: { houseId: house.id, link: "/house-desk" }, createdById: req.user!.id });
  await audit(req.user, "house.leader.add", { id: userId, label: user.name || user.email }, { houseId: house.id, house: house.name });
  res.status(201).json({ ok: true });
});

/** DELETE /admin/houses/:id/leaders/:userId */
export const removeLeader = handle(async (req, res) => {
  if (!hasCap(req.user as any, "users.houseLeader")) throw new HttpError(403, "You need the “Assign House Leaders” permission");
  const houseId = String(req.params.id), userId = String(req.params.userId);
  await prisma.aspirantHouseLeader.deleteMany({ where: { houseId, userId } });
  await audit(req.user, "house.leader.remove", { id: userId }, { houseId });
  res.json({ ok: true });
});
