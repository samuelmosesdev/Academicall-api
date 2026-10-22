import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { hasCap } from "../lib/access";

const requestSchema = z.object({
  type: z.string().optional(), title: z.string().optional(), body: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(), meta: z.any().optional(),
  requesterName: z.string().optional(), requesterEmail: z.string().optional(), requesterRole: z.string().optional(),
  field: z.string().optional(), fieldLabel: z.string().optional(), requestedValue: z.string().optional(), reason: z.string().optional(),
  reviewedAt: z.coerce.date().nullable().optional(), reviewedBy: z.string().nullable().optional(), reviewedByName: z.string().nullable().optional(), reviewNote: z.string().nullable().optional(),
});

export async function listRequests(req: Request, res: Response) {
  const canReview = !!req.user && hasCap(req.user, "requests.review");
  const requests = await prisma.request.findMany({
    where: canReview ? undefined : { requesterUid: req.user!.id },
    orderBy: { createdAt: "desc" }, take: 200,
  });
  res.json({ requests });
}

export async function createRequest(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = requestSchema.parse(req.body);
    const request = await prisma.request.create({ data: { ...body, requesterUid: req.user.id } });
    res.status(201).json({ request });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Create failed" });
  }
}

export async function updateRequest(req: Request, res: Response) {
  try {
    const body = requestSchema.partial().parse(req.body);
    const request = await prisma.request.update({ where: { id: String(req.params.id) }, data: body });
    res.json({ request });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Update failed" });
  }
}

const profileChangeSchema = z.object({
  userId: z.string().optional(), userName: z.string().optional(), userEmail: z.string().optional(), uniqueId: z.string().nullable().optional(),
  body: z.string().optional(),
  field: z.string().optional(), fieldLabel: z.string().optional(), currentValue: z.string().nullable().optional(), requestedValue: z.string().optional(), reason: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(), reviewedAt: z.coerce.date().nullable().optional(), reviewedBy: z.string().nullable().optional(), reviewedByName: z.string().nullable().optional(), adminNote: z.string().nullable().optional(), meta: z.any().optional(),
});

function profileChangeView(item: any) { return { ...item, userId: item.userId, userName: item.userName, userEmail: item.userEmail }; }

type CatalogShape = { faculties?: Array<{ name?: string; departments?: Array<{ name?: string; programs?: string[] }> }> } | null;

async function catalogFor(institutionId: string | null | undefined): Promise<CatalogShape> {
  if (!institutionId || institutionId === "uofa") {
    const setting = await prisma.setting.findUnique({ where: { key: "academicCatalog" } });
    return setting?.value as CatalogShape;
  }
  const faculties = await prisma.faculty.findMany({
    where: { institutionId, active: true },
    select: {
      name: true,
      departments: {
        where: { active: true },
        select: { name: true, programs: { where: { active: true }, select: { name: true } } },
      },
    },
  });
  return {
    faculties: faculties.map((faculty) => ({
      name: faculty.name,
      departments: faculty.departments.map((department) => ({
        name: department.name,
        programs: department.programs.map((program) => program.name),
      })),
    })),
  };
}

export async function listProfileChangeRequests(req: Request, res: Response) {
  const canReview = !!req.user && hasCap(req.user, "requests.review");
  const requests = await prisma.profileChangeRequest.findMany({ where: canReview ? undefined : { userId: req.user!.id }, orderBy: { createdAt: "desc" }, take: 200 });
  res.json({ requests: requests.map(profileChangeView) });
}

export async function createProfileChangeRequest(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = profileChangeSchema.parse(req.body);
    const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
    const field = body.field || meta.field;
    const requestedValue = body.requestedValue || meta.requestedValue;
    if (!field || !requestedValue) return res.status(400).json({ error: "field and requestedValue are required" });
    const request = await prisma.profileChangeRequest.create({ data: {
      userId: req.user.id, userName: body.userName || meta.userName, userEmail: body.userEmail || meta.userEmail, uniqueId: body.uniqueId ?? meta.uniqueId,
      field, fieldLabel: body.fieldLabel || meta.fieldLabel, currentValue: body.currentValue ?? meta.currentValue, requestedValue,
      reason: body.reason || meta.reason || body.body, status: "pending",
    } });
    res.status(201).json({ request: profileChangeView(request) });
  } catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Create failed" }); }
}

export async function updateProfileChangeRequest(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = profileChangeSchema.partial().parse(req.body);
    const current = await prisma.profileChangeRequest.findUnique({ where: { id: String(req.params.id) } });
    if (!current) return res.status(404).json({ error: "Profile change request not found" });
    if (!["admin", "alphaAgent", "agent"].includes(req.user.role) && current.userId !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    if (body.status === "approved") {
      const fieldRaw = String(current.field || "").trim();
      const fieldKey = fieldRaw.toLowerCase().replace(/\s+/g, "");
      const fieldAliases: Record<string, string> = {
        name: "name",
        fullname: "name",
        phone: "phone",
        phonenumber: "phone",
        faculty: "faculty",
        program: "program",
        programme: "program",
        department: "department",
        dept: "department",
        level: "level",
        matricnumber: "matricNumber",
        matric: "matricNumber",
      };
      const normalizedField = fieldAliases[fieldKey];
      const allowedFields = ["name", "phone", "faculty", "program", "department", "level", "matricNumber"];
      if (!normalizedField || !allowedFields.includes(normalizedField)) {
        return res.status(400).json({
          error: "Field cannot be approved",
          detail: `Unsupported field "${fieldRaw}". Allowed: ${allowedFields.join(", ")}`,
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: current.userId },
        select: { faculty: true, department: true, program: true, profileComplete: true, institutionId: true },
      });
      if (!user) return res.status(404).json({ error: "Request owner not found" });

      const updateData: Record<string, string | boolean> = {
        [normalizedField]: current.requestedValue,
      };

      if (normalizedField === "program") {
        const catalog = await catalogFor(user.institutionId);

        const faculties = catalog?.faculties || [];
        const matches = faculties.flatMap((faculty) =>
          (faculty.departments || [])
            .filter((department) =>
              (department.programs || []).some(
                (program) =>
                  String(program).trim().toLowerCase() ===
                  String(current.requestedValue).trim().toLowerCase()
              )
            )
            .map((department) => ({ faculty: faculty.name || "", department: department.name || "" }))
        );
        if (!matches.length) {
          return res.status(400).json({ error: "The requested program is not in the academic catalog." });
        }
        const match =
          matches.find((item) => item.faculty === user.faculty && item.department === user.department) ||
          matches.find((item) => item.faculty === user.faculty) ||
          matches[0];
        updateData.faculty = match.faculty;
        updateData.department = match.department;
      }

      if (normalizedField === "faculty") {
        if (user.faculty !== current.requestedValue) {
          updateData.department = "";
          updateData.program = "";
          updateData.profileComplete = false;
        }
      }

      if (normalizedField === "department") {
        const catalog = await catalogFor(user.institutionId);
        const faculty = catalog?.faculties?.find((item) => item.name === user.faculty);
        const department = faculty?.departments?.find((item) => item.name === current.requestedValue);
        if (!department) {
          return res.status(400).json({ error: "The requested department is not in the user's faculty catalog." });
        }
        if (!(department.programs || []).includes(user.program || "")) {
          updateData.program = "";
          updateData.profileComplete = false;
        }
      }

      await prisma.user.update({ where: { id: current.userId }, data: updateData });
    }
    const request = await prisma.profileChangeRequest.update({
      where: { id: current.id },
      data: {
        status: body.status,
        reviewedAt: body.reviewedAt || (body.status ? new Date() : undefined),
        reviewedBy: body.reviewedBy,
        reviewedByName: body.reviewedByName,
        adminNote: body.adminNote,
      },
    });
    res.json({ request: profileChangeView(request) });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Update failed" });
  }
}

export async function deleteProfileChangeRequest(req: Request, res: Response) {
  if (!req.user || !["admin", "alphaAgent", "agent"].includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  await prisma.profileChangeRequest.delete({ where: { id: String(req.params.id) } });
  res.status(204).send();
}