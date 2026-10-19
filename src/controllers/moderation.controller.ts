/**
 * Reports and the moderation queue.
 *
 * Anyone can report a group message, a house thread or reply, a news comment,
 * a programme feed post or a person. Reports land in one queue for staff with
 * "moderation.manage", who can hide the content, warn the author, mute them
 * for a while, or dismiss the report. Every action is written to the audit log
 * and the reporter is told the outcome (without naming who acted).
 */
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError, pageParams } from "../lib/http";
import { audit } from "../lib/audit";
import { notifyMany } from "../lib/notify";
import { outranks } from "../lib/access";
import { publishToGroup } from "../lib/realtime";

export const TARGETS = ["group_message", "house_thread", "house_reply", "news_comment", "feed_post", "user"] as const;
export const REASONS = ["spam", "abuse", "harassment", "sexual", "violence", "false_info", "cheating", "other"] as const;
export const REASON_LABELS: Record<string, string> = {
  spam: "Spam or scam", abuse: "Insults or hate", harassment: "Bullying or harassment", sexual: "Sexual content",
  violence: "Threats or violence", false_info: "False information", cheating: "Exam leaks or cheating", other: "Something else",
};
const TARGET_LABELS: Record<string, string> = {
  group_message: "Group message", house_thread: "House thread", house_reply: "House reply", news_comment: "News comment", feed_post: "Programme post", user: "Person",
};

type Loaded = { authorId: string | null; snapshot: Record<string, unknown>; contextUrl: string | null; hidden: boolean };

/** Fetch what's being reported (and who wrote it) so staff see it as it was. */
async function loadTarget(type: string, id: string): Promise<Loaded | null> {
  switch (type) {
    case "group_message": {
      const m = await prisma.studyGroupMessage.findUnique({ where: { id }, include: { group: { select: { code: true, name: true } }, sender: { select: { name: true } } } });
      if (!m) return null;
      const arch = (m.archive as any) || {};
      return {
        authorId: m.senderId,
        snapshot: { text: m.text ?? arch.text ?? null, attachmentName: m.attachmentName, attachmentUrl: m.attachmentUrl ?? arch.attachmentUrl ?? null, author: m.sender?.name, where: m.group?.name, at: m.createdAt },
        contextUrl: m.group ? `/study/${m.group.code}` : null,
        hidden: !!m.deletedAt,
      };
    }
    case "house_thread": {
      const t = await prisma.houseThread.findUnique({ where: { id }, include: { house: { select: { name: true } }, author: { select: { name: true } } } });
      if (!t) return null;
      return { authorId: t.authorId, snapshot: { title: t.title, text: t.body, imageUrl: t.imageUrl, author: t.author?.name, where: t.house?.name, at: t.createdAt }, contextUrl: `/dashboard/house/${t.houseId}?thread=${t.id}`, hidden: !!t.deletedAt };
    }
    case "house_reply": {
      const r = await prisma.houseReply.findUnique({ where: { id }, include: { thread: { select: { id: true, houseId: true, title: true } }, author: { select: { name: true } } } });
      if (!r) return null;
      return { authorId: r.authorId, snapshot: { text: r.body, imageUrl: r.imageUrl, author: r.author?.name, where: r.thread?.title, at: r.createdAt }, contextUrl: r.thread ? `/dashboard/house/${r.thread.houseId}?thread=${r.thread.id}` : null, hidden: !!r.deletedAt };
    }
    case "news_comment": {
      const c = await prisma.newsComment.findUnique({ where: { id }, include: { post: { select: { slug: true, title: true } }, user: { select: { name: true } } } });
      if (!c) return null;
      return { authorId: c.userId, snapshot: { text: c.body, author: c.user?.name, where: c.post?.title, at: c.createdAt }, contextUrl: c.post ? `/news/${c.post.slug}` : null, hidden: !!c.deletedAt };
    }
    case "feed_post": {
      const p = await prisma.feedPost.findUnique({ where: { id } });
      if (!p) return null;
      return { authorId: p.authorId, snapshot: { title: p.title, text: p.body, author: p.authorName, where: [p.department, p.level].filter(Boolean).join(" · "), at: p.createdAt }, contextUrl: "/dashboard/department", hidden: false };
    }
    case "user": {
      const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, nickname: true, uniqueId: true, bio: true, photoUrl: true } });
      if (!u) return null;
      return { authorId: u.id, snapshot: { author: u.name, nickname: u.nickname, uniqueId: u.uniqueId, text: u.bio, photoUrl: u.photoUrl }, contextUrl: null, hidden: false };
    }
  }
  return null;
}

/** Remove the reported content (kept in the database so it can be restored from the Document Center / audit). */
async function hideTarget(type: string, id: string, actorId: string) {
  const now = new Date();
  switch (type) {
    case "group_message": {
      const m = await prisma.studyGroupMessage.findUnique({ where: { id } });
      if (!m || m.deletedAt) return;
      await prisma.studyGroupMessage.update({ where: { id }, data: { deletedAt: now, deletedById: actorId, text: null, attachmentUrl: null, thumbnailUrl: null, archive: { text: m.text, attachmentUrl: m.attachmentUrl, thumbnailUrl: m.thumbnailUrl, removedBy: "moderation" } } });
      publishToGroup(m.groupId, { type: "group.message.deleted", data: { groupId: m.groupId, messageId: m.id } }).catch(() => {});
      return;
    }
    case "house_thread":
      await prisma.houseThread.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: now } });
      return;
    case "house_reply":
      await prisma.houseReply.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: now, deletedById: actorId } });
      return;
    case "news_comment": {
      const c = await prisma.newsComment.findUnique({ where: { id } });
      if (!c || c.deletedAt) return;
      await prisma.$transaction([
        prisma.newsComment.update({ where: { id }, data: { deletedAt: now } }),
        prisma.newsPost.update({ where: { id: c.postId }, data: { commentCount: { decrement: 1 } } }),
      ]);
      return;
    }
    case "feed_post":
      await prisma.feedPost.deleteMany({ where: { id } });
      return;
  }
}

// ── Reporting (anyone signed in) ────────────────────────────────────────────
const reportBody = z.object({
  targetType: z.enum(TARGETS),
  targetId: z.string().min(1).max(64),
  reason: z.enum(REASONS),
  note: z.string().trim().max(1000).optional().nullable(),
});

/** POST /reports */
export const createReport = handle(async (req, res) => {
  const b = reportBody.parse(req.body);
  const t = await loadTarget(b.targetType, b.targetId);
  if (!t) throw new HttpError(404, "That's no longer there.");
  if (t.authorId === req.user!.id) throw new HttpError(400, "You can't report your own post.");
  const recent = await prisma.contentReport.count({ where: { reporterId: req.user!.id, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
  if (recent >= 20) throw new HttpError(429, "You've sent a lot of reports this hour. Staff are looking at them.");
  const dup = await prisma.contentReport.findFirst({ where: { reporterId: req.user!.id, targetType: b.targetType, targetId: b.targetId, status: "open" } });
  if (dup) return res.json({ ok: true, id: dup.id, duplicate: true });
  const row = await prisma.contentReport.create({
    data: { reporterId: req.user!.id, targetType: b.targetType, targetId: b.targetId, targetUserId: t.authorId, reason: b.reason, note: b.note || null, snapshot: t.snapshot as any, contextUrl: t.contextUrl },
  });
  res.status(201).json({ ok: true, id: row.id });
});

// ── The queue (staff) ───────────────────────────────────────────────────────

/** GET /admin/moderation/summary */
export const summary = handle(async (_req, res) => {
  const [open, today, muted, byReason] = await Promise.all([
    prisma.contentReport.count({ where: { status: "open" } }),
    prisma.contentReport.count({ where: { createdAt: { gt: new Date(Date.now() - 86_400_000) } } }),
    prisma.user.count({ where: { mutedUntil: { gt: new Date() } } }),
    prisma.contentReport.groupBy({ by: ["reason"], where: { status: "open" }, _count: { _all: true } }),
  ]);
  res.json({ open, today, muted, byReason: byReason.map((r) => ({ reason: r.reason, label: REASON_LABELS[r.reason] || r.reason, count: r._count._all })) });
});

/** GET /admin/moderation/reports?status=open&type=&reason=&page= — grouped by the content reported. */
export const listReports = handle(async (req, res) => {
  const status = ["open", "actioned", "dismissed"].includes(String(req.query.status)) ? String(req.query.status) : "open";
  const where: any = { status };
  if (TARGETS.includes(String(req.query.type) as any)) where.targetType = String(req.query.type);
  if (REASONS.includes(String(req.query.reason) as any)) where.reason = String(req.query.reason);
  const { take, skip, page, pageSize } = pageParams(req.query, { def: 25, max: 100 });
  const [rows, total] = await Promise.all([
    prisma.contentReport.findMany({ where, orderBy: { createdAt: status === "open" ? "asc" : "desc" }, take, skip }),
    prisma.contentReport.count({ where }),
  ]);
  const people = [...new Set(rows.flatMap((r) => [r.reporterId, r.targetUserId]).filter(Boolean) as string[])];
  const [users, counts, priors] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true, email: true, uniqueId: true, role: true, mutedUntil: true } }),
    prisma.contentReport.groupBy({ by: ["targetType", "targetId"], where: { status: "open", targetId: { in: rows.map((r) => r.targetId) } }, _count: { _all: true } }),
    prisma.userRestriction.groupBy({ by: ["userId"], where: { userId: { in: rows.map((r) => r.targetUserId).filter(Boolean) as string[] } }, _count: { _all: true } }),
  ]);
  const u = new Map(users.map((x) => [x.id, x]));
  const c = new Map(counts.map((x) => [`${x.targetType}:${x.targetId}`, x._count._all]));
  const p = new Map(priors.map((x) => [x.userId, x._count._all]));
  res.json({
    page, pageSize, total,
    items: rows.map((r) => ({
      ...r,
      typeLabel: TARGET_LABELS[r.targetType] || r.targetType,
      reasonLabel: REASON_LABELS[r.reason] || r.reason,
      reporter: r.reporterId ? u.get(r.reporterId) || null : null,
      author: r.targetUserId ? u.get(r.targetUserId) || null : null,
      sameTargetReports: c.get(`${r.targetType}:${r.targetId}`) || 1,
      authorPriorActions: r.targetUserId ? p.get(r.targetUserId) || 0 : 0,
    })),
  });
});

const actionBody = z.object({
  action: z.enum(["hide", "warn", "mute", "dismiss"]),
  /** For mute: 1, 3, 7 or 30 days */
  days: z.number().int().min(1).max(30).optional(),
  /** Also hide the content when warning or muting */
  hide: z.boolean().optional(),
  note: z.string().trim().max(500).optional().nullable(),
});

/** POST /admin/moderation/reports/:id/action — closes every open report on the same content. */
export const actOnReport = handle(async (req, res) => {
  const b = actionBody.parse(req.body);
  const report = await prisma.contentReport.findUnique({ where: { id: String(req.params.id) } });
  if (!report) throw new HttpError(404, "Report not found");
  if (report.status !== "open") throw new HttpError(409, "Someone already handled this report.");
  const actor = req.user!;
  const author = report.targetUserId ? await prisma.user.findUnique({ where: { id: report.targetUserId }, select: { id: true, name: true, email: true, role: true } }) : null;
  if ((b.action === "warn" || b.action === "mute") && !author) throw new HttpError(400, "There's no author to warn or mute.");
  if ((b.action === "warn" || b.action === "mute") && author && !outranks(actor, author)) throw new HttpError(403, "You can only act on accounts below your rank.");

  if (b.action === "hide" || ((b.action === "warn" || b.action === "mute") && b.hide)) await hideTarget(report.targetType, report.targetId, actor.id);

  let until: Date | null = null;
  if (b.action === "mute" && author) {
    until = new Date(Date.now() + (b.days || 1) * 86_400_000);
    await prisma.user.update({ where: { id: author.id }, data: { mutedUntil: until } });
  }
  if ((b.action === "warn" || b.action === "mute") && author) {
    await prisma.userRestriction.create({
      data: { userId: author.id, kind: b.action, reason: b.note || REASON_LABELS[report.reason], reportId: report.id, until, createdById: actor.id, createdByName: actor.name || actor.email },
    });
    await notifyMany([author.id], {
      type: "moderation",
      title: b.action === "mute" ? `You're muted for ${b.days || 1} day${(b.days || 1) > 1 ? "s" : ""}` : "A warning from Academicall staff",
      body: `${REASON_LABELS[report.reason]}${b.note ? `: ${b.note}` : ""}. ${b.action === "mute" ? "You can still read, but you can't post, comment or reply until it ends." : "Please keep to the community rules."}`,
      data: { link: report.contextUrl || "/dashboard" },
      createdById: actor.id,
    });
  }

  const status = b.action === "dismiss" ? "dismissed" : "actioned";
  const closed = await prisma.contentReport.findMany({ where: { targetType: report.targetType, targetId: report.targetId, status: "open" }, select: { id: true, reporterId: true } });
  await prisma.contentReport.updateMany({
    where: { id: { in: closed.map((x) => x.id) } },
    data: { status, action: b.action, actionNote: b.note || null, handledById: actor.id, handledByName: actor.name || actor.email, handledAt: new Date() },
  });
  await notifyMany(closed.map((x) => x.reporterId).filter(Boolean) as string[], {
    type: "moderation",
    title: status === "actioned" ? "Thanks — we acted on your report" : "We looked at your report",
    body: status === "actioned" ? "Staff reviewed what you reported and took action." : "Staff reviewed what you reported and found it within the rules.",
    createdById: actor.id,
  });
  await audit(actor, `moderation.${b.action}`, { id: report.targetId, label: `${TARGET_LABELS[report.targetType]}${author ? ` by ${author.name || author.email}` : ""}` }, {
    reportId: report.id, reason: report.reason, days: b.days || null, note: b.note || null, reports: closed.length,
  });
  res.json({ ok: true, status, closed: closed.length, mutedUntil: until });
});

/** GET /admin/moderation/restrictions?active=1 */
export const listRestrictions = handle(async (req, res) => {
  const active = String(req.query.active || "") === "1";
  const rows = await prisma.userRestriction.findMany({
    where: active ? { kind: "mute", liftedAt: null, until: { gt: new Date() } } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { user: { select: { id: true, name: true, email: true, uniqueId: true, mutedUntil: true } } },
  });
  res.json({ items: rows });
});

/** POST /admin/moderation/restrictions/:id/lift */
export const liftRestriction = handle(async (req, res) => {
  const r = await prisma.userRestriction.findUnique({ where: { id: String(req.params.id) }, include: { user: { select: { id: true, name: true, email: true, role: true } } } });
  if (!r) throw new HttpError(404, "Not found");
  if (!outranks(req.user!, r.user)) throw new HttpError(403, "You can only act on accounts below your rank.");
  await prisma.userRestriction.update({ where: { id: r.id }, data: { liftedAt: new Date(), liftedById: req.user!.id } });
  if (r.kind === "mute") {
    await prisma.user.update({ where: { id: r.userId }, data: { mutedUntil: null } });
    await notifyMany([r.userId], { type: "moderation", title: "You can post again", body: "Staff lifted the mute on your account.", createdById: req.user!.id });
  }
  await audit(req.user, "moderation.lift", { id: r.userId, label: r.user.name || r.user.email }, { kind: r.kind });
  res.json({ ok: true });
});
