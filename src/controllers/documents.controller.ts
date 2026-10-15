import { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { publishToScope } from "../lib/realtime";
import { DEFAULT_INSTITUTION_ID, institutionOf, programmeScopeKey } from "../lib/scope";
import { hasCap } from "../lib/access";

function isStaff(role?: string) {
  return ["admin", "alphaAgent", "agent"].includes(role || "");
}

function hasGlobalInstitutionAccess(role?: string) {
  return role === "admin" || role === "alphaAgent";
}

async function canAccessInstitution(
  userId: string | undefined,
  role: string | undefined,
  institutionId: string | null,
) {
  if (hasGlobalInstitutionAccess(role)) return true;
  if (!userId) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { institutionId: true },
  });
  return Boolean(
    user &&
    (institutionId || DEFAULT_INSTITUTION_ID) === institutionOf(user),
  );
}

export async function listDocuments(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const courseId = req.query.courseId as string | undefined;
  const q = req.query.q as string | undefined;
  const status = req.query.status as string | undefined;
  const staff = isStaff(req.user?.role);
  const canReview = hasCap(req.user, "documents.review") || hasCap(req.user, "documents.manage");
  const requestedInstitution = String(req.query.institutionId || "").trim();
  const globalAccess = hasGlobalInstitutionAccess(req.user.role);
  const requester = globalAccess
    ? null
    : await prisma.user.findUnique({ where: { id: req.user.id }, select: { institutionId: true } });
  if (!requester && !globalAccess) return res.status(401).json({ error: "User not found" });
  if (
    staff &&
    !globalAccess &&
    requestedInstitution &&
    requestedInstitution !== institutionOf(requester)
  ) {
    return res.status(403).json({ error: "Wrong institution scope" });
  }
  const requesterInstitution = requester ? institutionOf(requester) : DEFAULT_INSTITUTION_ID;
  const institutionId = globalAccess ? requestedInstitution || undefined : requesterInstitution;
  const documents = await prisma.document.findMany({
    where: {
      deletedAt: null,
      ...(!globalAccess
        ? {
            OR: [
              { institutionId: requesterInstitution },
              ...(requesterInstitution === DEFAULT_INSTITUTION_ID
                ? [{ institutionId: null }]
                : []),
            ],
          }
        : globalAccess && institutionId
          ? { institutionId }
          : {}),
      ...(courseId ? { courseId } : {}),
      ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      ...(!canReview
        ? {
            status: "approved",
            AND: [{ OR: [{ source: null }, { source: { not: "personal" } }] }],
          }
        : status
          ? { status }
          : {}),
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

export async function listMyDocuments(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const documents = await prisma.document.findMany({
    where: { uploadedById: req.user.id, source: "personal", deletedAt: null },
    include: { course: { select: { id: true, title: true, code: true } } },
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
  if (!document || document.deletedAt) return res.status(404).json({ error: "Document not found" });
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const canAccess = await canAccessInstitution(req.user.id, req.user.role, document.institutionId);
  if (!canAccess) {
    return res.status(404).json({ error: "Document not found" });
  }
  if (
    document.source === "personal" &&
    document.uploadedById !== req.user?.id &&
    !hasCap(req.user, "documents.manage")
  ) {
    return res.status(404).json({ error: "Document not found" });
  }
  if (!hasCap(req.user, "documents.review") && !hasCap(req.user, "documents.manage") && document.status !== "approved") {
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
  program: z.string().trim().min(1).optional().nullable(),
  level: z.string().optional().nullable(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  institutionId: z.string().min(1).optional(),
});

function normalizeScope(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function levelsMatch(first: unknown, second: unknown) {
  const normalizeLevel = (value: unknown) => normalizeScope(value).replace(/\s*level\s*/g, "");
  return Boolean(normalizeLevel(first) && normalizeLevel(first) === normalizeLevel(second));
}

function broadcastMaterial(document: {
  id: string;
  department: string | null;
  institutionId: string | null;
  level: string | null;
  source: string | null;
  status: string;
}, action: "created" | "updated" | "deleted") {
  if (document.source !== "courseRep" || document.status !== "approved" || !document.department) return;
  publishToScope(programmeScopeKey(document.institutionId, document.department), {
    type: "programme.material",
    data: { action, item: action === "deleted" ? { id: document.id } : document, level: document.level },
  });
}

export async function createDocument(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = createSchema.parse(req.body);
    const staff = isStaff(req.user.role);
    const isCourseRep = req.user.role === "courseRep";
    const isStudent = req.user.role === "user";
    if ((isCourseRep || isStudent) && !body.fileUrl) {
      return res.status(400).json({ error: "A file URL is required to upload a material" });
    }
    const uploader = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { plan: true, courseRepMeta: true, autoPublish: true, institutionId: true },
    });
    if (!uploader) return res.status(401).json({ error: "User not found" });
    if (isStudent && uploader.plan === "free") {
      return res.status(403).json({ error: "A premium plan is required to upload personal materials" });
    }
    if (!staff && !isCourseRep && !isStudent) {
      return res.status(403).json({ error: "You don't have permission to upload materials" });
    }
    const institutionId = staff
      ? body.institutionId || institutionOf(uploader)
      : institutionOf(uploader);
    if (staff && body.institutionId) {
      const institution = await prisma.institution.findUnique({
        where: { id: body.institutionId },
        select: { id: true },
      });
      if (!institution) return res.status(400).json({ error: "Institution not found" });
      if (
        !hasGlobalInstitutionAccess(req.user.role) &&
        body.institutionId !== institutionOf(uploader)
      ) {
        return res.status(403).json({ error: "Wrong institution scope" });
      }
    }
    let assignedProgram: string | null = null;
    let level: string | null = null;
    if (isCourseRep) {
      const meta = uploader.courseRepMeta as { program?: string; level?: string } | null;
      assignedProgram = String(meta?.program || "").trim() || null;
      level = String(meta?.level || "").trim() || null;
      if (
        !assignedProgram ||
        !level ||
        (body.program && normalizeScope(body.program) !== normalizeScope(assignedProgram)) ||
        (body.level && !levelsMatch(body.level, level))
      ) {
        return res.status(403).json({ error: "Course Reps can only upload materials for their assigned program and level" });
      }
      if (body.courseId) {
        const course = await prisma.course.findUnique({
          where: { id: body.courseId },
          select: { department: true, level: true },
        });
        if (
          !course ||
          normalizeScope(course.department) !== normalizeScope(assignedProgram) ||
          !levelsMatch(course.level, level)
        ) {
          return res.status(403).json({ error: "Course Reps can only attach materials to courses in their assigned program and level" });
        }
      }
    }
    const { program: requestedProgram, ...documentBody } = body;
    const status = isStudent || isCourseRep
      ? "approved"
      : body.status || (staff || uploader.autoPublish ? "approved" : "pending");
    const document = await prisma.document.create({
      data: {
        ...documentBody,
        institutionId,
        ...(isStudent
          ? { courseId: null, faculty: null, department: null, level: null, source: "personal" }
          : isCourseRep
            ? { department: assignedProgram, level, source: "courseRep" }
            : requestedProgram
              ? { department: requestedProgram }
              : {}),
        tags: body.tags === null ? Prisma.JsonNull : body.tags,
        uploadedById: req.user.id,
        source: isStudent
          ? "personal"
          : isCourseRep
            ? "courseRep"
            : body.source || "staff",
        status,
        ...(status === "approved" && !isStudent && !isCourseRep
          ? { approvedById: req.user.id, approvedAt: new Date() }
          : {}),
        ...(isStudent || isCourseRep ? { approvedAt: new Date() } : {}),
      },
    });
    broadcastMaterial(document, "created");
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
  if (!existing || existing.deletedAt) return res.status(404).json({ error: "Document not found" });
  if (!(await canAccessInstitution(req.user.id, req.user.role, existing.institutionId))) {
    return res.status(404).json({ error: "Document not found" });
  }
  if (existing.uploadedById !== req.user.id && !isStaff(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  let data: Record<string, unknown>;
  if (!isStaff(req.user.role)) {
    const parsed = z.object({
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      fileUrl: z.string().url().nullable().optional(),
      thumbnailUrl: z.string().url().nullable().optional(),
      fileName: z.string().nullable().optional(),
      fileSize: z.number().int().nonnegative().nullable().optional(),
      tags: z.array(z.string()).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors });
    data = parsed.data;
  } else if (isStaff(req.user.role)) {
    const parsed = createSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors });
    if (Object.keys(parsed.data).some((key) => key !== "status") && !hasCap(req.user, "documents.manage")) {
      return res.status(403).json({ error: "You need the documents.manage permission to edit materials" });
    }
    if (parsed.data.status !== undefined && !hasCap(req.user, "documents.review")) {
      return res.status(403).json({ error: "You need the documents.review permission to change material status" });
    }
    data = parsed.data;
    if (parsed.data.institutionId) {
      const institution = await prisma.institution.findUnique({
        where: { id: parsed.data.institutionId },
        select: { id: true },
      });
      if (!institution) return res.status(400).json({ error: "Institution not found" });
      if (!hasGlobalInstitutionAccess(req.user.role)) {
        const uploader = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { institutionId: true },
        });
        if (!uploader) return res.status(401).json({ error: "User not found" });
        if (parsed.data.institutionId !== institutionOf(uploader)) {
          return res.status(403).json({ error: "Wrong institution scope" });
        }
      }
    }
  } else {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (data.tags === null) data.tags = Prisma.JsonNull;
  const document = await prisma.document.update({ where: { id: existing.id }, data: data as Prisma.DocumentUpdateInput });
  broadcastMaterial(existing, "deleted");
  broadcastMaterial(document, "updated");
  res.json({ document });
}

export async function approveDocument(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  if (!hasCap(req.user, "documents.review")) return res.status(403).json({ error: "Forbidden" });
  const existing = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!existing || existing.deletedAt) return res.status(404).json({ error: "Document not found" });
  if (!(await canAccessInstitution(req.user.id, req.user.role, existing.institutionId))) {
    return res.status(404).json({ error: "Document not found" });
  }
  const status = req.body?.status === "rejected" ? "rejected" : "approved";
  const document = await prisma.document.update({
    where: { id: existing.id },
    data: { status, approvedById: req.user.id, approvedAt: new Date() },
  });
  broadcastMaterial(existing, "deleted");
  broadcastMaterial(document, "updated");
  res.json({ document });
}

export async function deleteDocument(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const existing = await prisma.document.findUnique({ where: { id: String(req.params.id) } });
  if (!existing || existing.deletedAt) return res.status(404).json({ error: "Document not found" });
  if (!(await canAccessInstitution(req.user.id, req.user.role, existing.institutionId))) {
    return res.status(404).json({ error: "Document not found" });
  }
  if (existing.uploadedById !== req.user.id && !isStaff(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  if (existing.uploadedById !== req.user.id && !hasCap(req.user, "documents.manage")) return res.status(403).json({ error: "Forbidden" });
  await prisma.document.update({ where: { id: existing.id }, data: { deletedAt: new Date(), deletedById: req.user.id } });
  broadcastMaterial(existing, "deleted");
  res.status(204).send();
}
