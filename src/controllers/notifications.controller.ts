import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

export async function listMyNotifications(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const archived = req.query.archived === "true";

  const notifications = await prisma.notification.findMany({
    where: {
      userId: req.user.id,
      deleted: false,
      archived,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.json({ notifications });
}

export async function listAdminNotifications(_req: Request, res: Response) {
  const notifications = await prisma.notification.findMany({
    where: { deleted: false }, orderBy: { createdAt: "desc" }, take: 100,
  });
  res.json({ notifications });
}

export async function markRead(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  const notif = await prisma.notification.findFirst({
    where: { id: String(req.params.id), userId: req.user.id },
  });
  if (!notif) return res.status(404).json({ error: "Not found" });

  const updated = await prisma.notification.update({
    where: { id: notif.id },
    data: { readByUser: true, readAt: new Date() },
  });

  res.json({ notification: updated });
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
    data: { archived, archivedAt: archived ? new Date() : null, ...(req.body?.deleted !== undefined ? { deleted: Boolean(req.body.deleted), deletedAt: req.body.deleted ? new Date() : null } : {}) },
  });

  res.json({ notification: updated });
}

const createSchema = z.object({
  userId: z.string().uuid(),
  title: z.string().min(1),
  body: z.string().optional(),
  type: z.enum(["general", "payment_claim", "class_event", "announcement", "system"]).optional(),
  data: z.any().optional(),
});

export async function createNotification(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  try {
    const body = createSchema.parse(req.body);

    const notif = await prisma.notification.create({
      data: {
        ...body,
        type: body.type || "general",
        createdById: req.user.id,
      },
    });

    res.status(201).json({ notification: notif });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    res.status(500).json({ error: "Create failed" });
  }
}
