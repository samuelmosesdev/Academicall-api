import { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

function isStaff(role?: string) {
  return ["admin", "alphaAgent", "agent"].includes(role || "");
}

export async function listDocuments(req: Request, res: Response) {
  const courseId = req.query.courseId as string | undefined;
  const q = req.query.q as string | undefined;
  const status = req.query.status as string | undefined;
  const staff = isStaff(req.user?.role);
  const documents = await prisma.document.findMany({
    where: {
      ...(courseId ? { courseId } : {}),
      ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      ...(!staff ? { status: "approved" } : status ? { status } : {}),
    },
    include: {
      uploadedBy: { select: { id: true, name: true, email: true } },
      course: { select: { id: true, title: true, code: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ documents });
}

export async function getDocument(req: Request, res: Response) {
  const document = await prisma.document.findUnique({
    where: { id: String(req.params.id) },
    include: { uploadedBy: { select: { id: true, name: true, email: true } }, course: true },
  });
  if (!document) return res.status(404).json({ error: "Document not found" });
  if (!isStaff(req.user?.role) && document.status !== "approved") {
    return res.status(403).json({ error: "Material not yet approved" });
  }
  res.json({ document });
}

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  fileUrl: z.string().url().optional().nullable(),
  thumbnailUrl: z.string().url().optional().nullable(),
  courseId: z.string().min(1).optional().nullable(),
  source: z.string().optional(),
  fileName: z.string().optional().nullable(),
  fileSize: z.number().int().nonnegative().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
  faculty: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  level: z.string().optional().nullable(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

export async function createDocument(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = createSchema.parse(req.body);
    const staff = isStaff(req.user.role);
    const status = body.status || (staff || (req.user as any).autoPublish === true ? "approved" : "pending");
    const document = await prisma.document.create({
      data: {
        ...body,
        tags: body.tags === null ? Prisma.JsonNull : body.tags,
        uploadedById: req.user.id,
        source: body.source || (req.user.role === "courseRep" ? "courseRep" : "staff"),
        status,
        ...(status === "approved" ? { approvedById: req.user.id, approvedAt: new Date() } : {}),
      },
    });
    res.status(201).json({ document });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    console.error(err);
    res.status(500).json({ error: "Create failed" });
  }
}

export async function updateDocument(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const existing = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Document not found" });
  if (existing.uploadedById !== req.user.id && !isStaff(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  const document = await prisma.document.update({ where: { id: existing.id }, data: req.body });
  res.json({ document });
}

export async function approveDocument(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  if (!isStaff(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  const existing = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Document not found" });
  const status = req.body?.status === "rejected" ? "rejected" : "approved";
  const document = await prisma.document.update({
    where: { id: existing.id },
    data: { status, approvedById: req.user.id, approvedAt: new Date() },
  });
  res.json({ document });
}

export async function deleteDocument(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const existing = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Document not found" });
  if (existing.uploadedById !== req.user.id && !isStaff(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  await prisma.document.delete({ where: { id: existing.id } });
  res.status(204).send();
}
