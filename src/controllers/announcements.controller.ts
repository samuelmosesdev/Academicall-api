import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

const announcementSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  published: z.boolean().optional(),
});

export async function listAnnouncements(_req: Request, res: Response) {
  const announcements = await prisma.announcement.findMany({
    where: { published: true }, orderBy: { createdAt: "desc" }, take: 100,
  });
  res.json({ announcements });
}

export async function createAnnouncement(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = announcementSchema.parse(req.body);
    const announcement = await prisma.announcement.create({ data: { ...body, createdBy: req.user.id } });
    res.status(201).json({ announcement });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Create failed" });
  }
}

export async function updateAnnouncement(req: Request, res: Response) {
  try {
    const body = announcementSchema.partial().parse(req.body);
    const announcement = await prisma.announcement.update({ where: { id: String(req.params.id) }, data: body });
    res.json({ announcement });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Update failed" });
  }
}

export async function deleteAnnouncement(req: Request, res: Response) {
  await prisma.announcement.delete({ where: { id: String(req.params.id) } });
  res.status(204).send();
}