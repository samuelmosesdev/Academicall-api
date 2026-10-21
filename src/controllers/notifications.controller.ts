import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

const staffRoles = ["admin", "alphaAgent", "agent"];

/**
 * Which of the latest published announcements this person has already read.
 * The old /announcements/reads list was capped at 200 rows with no ordering,
 * so once someone had read more than 200 announcements, older reads could drop
 * out of the list and already-read announcements came back as "unread". Here we
 * look up reads only for the announcements the feed can actually show.
 */
async function readAnnouncementIdsFor(userId: string) {
  const latest = await prisma.announcement.findMany({
    where: { published: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
    take: 200,
  });
  if (!latest.length) return [] as string[];
  const reads = await prisma.announcementRead.findMany({
    where: { userId, announcementId: { in: latest.map((a) => a.id) } },
    select: { announcementId: true },
  });
  return reads.map((r) => r.announcementId).filter(Boolean) as string[];
}

export async function listMyNotifications(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const archived = req.query.archived === "true";
  const where = { userId: req.user.id, deleted: false, archived };
  const [notifications, unreadCount, readAnnouncementIds] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 50 }),
    // The list is capped at 50; the true unread total is counted separately so
    // badges stay right even when older unread items sit past the cap.
    archived ? Promise.resolve(0) : prisma.notification.count({ where: { ...where, readByUser: false } }),
    archived ? Promise.resolve([] as string[]) : readAnnouncementIdsFor(req.user.id),
  ]);
  res.json({ notifications, unreadCount, readAnnouncementIds });
}

/**
 * Staff inbox: only notifications addressed to staff accounts (payment claims,
 * new-student alerts, backup failures…). It used to return every notification
 * in the system, so each house post / news fan-out to students showed up as an
 * "unread" item for admins that could never be cleared individually.
 */
const staffInboxWhere = { deleted: false, user: { role: { in: staffRoles as any } } };

export async function listAdminNotifications(_req: Request, res: Response) {
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where: staffInboxWhere as any, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.notification.count({ where: { ...staffInboxWhere, readByAdmin: false } as any }),
  ]);
  res.json({ notifications, unreadCount });
}

/** PATCH /notifications/all/read — mark everything for the signed-in person read. */
async function markAllMineRead(req: Request, res: Response) {
  const userId = req.user!.id;
  const now = new Date();
  const result = await prisma.notification.updateMany({
    where: { userId, deleted: false, readByUser: false },
    data: { readByUser: true, readAt: now },
  });
  // Announcements are broadcast rows with no per-user notification, so their
  // read state lives in announcement_reads. Persist those too (the client sends
  // the ids it is showing; we only accept real, published ones).
  const raw = Array.isArray(req.body?.announcementIds) ? req.body.announcementIds : [];
  const wanted = [...new Set(raw.map((x: unknown) => String(x)).filter(Boolean))].slice(0, 300) as string[];
  let announcements = 0;
  if (wanted.length) {
    const real = await prisma.announcement.findMany({ where: { id: { in: wanted }, published: true }, select: { id: true } });
    await Promise.all(real.map((a) => {
      const id = `${userId}_${a.id}`;
      return prisma.announcementRead.upsert({
        where: { id },
        create: { id, userId, announcementId: a.id, readAt: now },
        update: {},
      });
    }));
    announcements = real.length;
  }
  res.json({ updated: result.count, announcements });
}

export async function markRead(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  if (String(req.params.id) === "all") return markAllMineRead(req, res);
  const notif = await prisma.notification.findUnique({ where: { id: String(req.params.id) } });
  if (!notif) return res.status(404).json({ error: "Not found" });

  const isStaff = staffRoles.includes(req.user.role);
  const isOwner = notif.userId === req.user.id;
  if (!isOwner && !isStaff) return res.status(404).json({ error: "Not found" });

  // ?as=admin marks the shared staff inbox copy; otherwise the owner's own read
  // state. Staff reading their own personal notification shouldn't silently
  // clear it for the rest of the staff team, and vice versa.
  const asAdmin = isStaff && (req.query.as === "admin" || !isOwner);
  const updated = await prisma.notification.update({
    where: { id: notif.id },
    data: {
      ...(isOwner && !asAdmin ? { readByUser: true } : {}),
      ...(asAdmin ? { readByAdmin: true } : {}),
      ...(isOwner && req.query.as === "admin" ? { readByUser: true } : {}),
      readAt: notif.readAt ?? new Date(),
    },
  });
  res.json({ notification: updated });
}

export async function markAllAdminRead(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  if (!staffRoles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  const result = await prisma.notification.updateMany({
    where: { ...staffInboxWhere, readByAdmin: false } as any,
    data: { readByAdmin: true, readAt: new Date() },
  });
  res.json({ updated: result.count });
}

export async function archiveNotification(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const notif = await prisma.notification.findFirst({
    where: { id: String(req.params.id), userId: req.user.id },
  });
  if (!notif) return res.status(404).json({ error: "Not found" });
  const archived = req.body?.archived !== false;
  const updated = await prisma.notification.update({
    where: { id: notif.id },
    data: {
      archived,
      archivedAt: archived ? new Date() : null,
      ...(req.body?.deleted !== undefined
        ? { deleted: Boolean(req.body.deleted), deletedAt: req.body.deleted ? new Date() : null }
        : {}),
    },
  });
  res.json({ notification: updated });
}

const createSchema = z.object({
  userId: z.string().optional().nullable(),
  title: z.string().min(1),
  body: z.string().optional(),
  type: z.string().optional(),
  data: z.any().optional(),
  readByUser: z.boolean().optional(),
  readByAdmin: z.boolean().optional(),
});

export async function createNotification(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = createSchema.parse(req.body);
    const isStaff = staffRoles.includes(req.user.role);
    const userId = body.userId || (isStaff
      ? req.user.id
      : (await prisma.user.findFirst({ where: { role: "admin", status: "active" }, select: { id: true } }))?.id || req.user.id);
    if (userId !== req.user.id && !isStaff) return res.status(403).json({ error: "Cannot notify another user" });

    const allowedTypes = ["general", "payment_claim", "class_event", "announcement", "system", "new_student", "lecture_update", "announcement_published"] as const;
    const notification = await prisma.notification.create({
      data: {
        userId,
        title: body.title,
        body: body.body,
        data: body.data ?? undefined,
        readByUser: body.readByUser ?? false,
        readByAdmin: body.readByAdmin ?? false,
        type: (allowedTypes.includes(body.type as typeof allowedTypes[number]) ? body.type : "general") as typeof allowedTypes[number],
        createdById: req.user.id,
      },
    });
    res.status(201).json({ notification });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    console.error(err);
    res.status(500).json({ error: "Create failed" });
  }
}

const tokenSchema = z.object({ token: z.string().min(1), uid: z.string().optional(), platform: z.string().optional() });

export async function registerDeviceToken(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const body = tokenSchema.parse(req.body);
  await prisma.user.update({ where: { id: req.user.id }, data: { deviceToken: body.token, fcmToken: body.token } });
  res.json({ ok: true });
}

export async function removeDeviceToken(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  await prisma.user.update({ where: { id: req.user.id }, data: { deviceToken: null, fcmToken: null } });
  res.json({ ok: true });
}

export const registerFcmToken = registerDeviceToken;
export const removeFcmToken = removeDeviceToken;
