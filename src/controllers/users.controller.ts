import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { Prisma, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

export async function listUsers(req: Request, res: Response) {
  const role = req.query.role as string | undefined;
  const search = req.query.q as string | undefined;

  const users = await prisma.user.findMany({
    where: {
      status: { not: "deleted" },
      ...(role ? { role: role as Role } : {}),
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: "insensitive" } },
              { name: { contains: search, mode: "insensitive" } },
              { uniqueId: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      plan: true,
      uniqueId: true,
      department: true,
      faculty: true,
      level: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json({ users });
}

export async function getUser(req: Request, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: String(req.params.id) },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      plan: true,
      uniqueId: true,
      department: true,
      photoUrl: true,
      status: true,
      profileComplete: true,
      coursesEnrolledCount: true,
      questionsPracticedCount: true,
      studyStreakDays: true,
      createdAt: true,
    },
  });

  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user });
}

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  department: z.string().optional(),
  faculty: z.string().optional(),
  level: z.string().optional(),
  matricNumber: z.string().optional(),
  phone: z.string().optional(),
  bio: z.string().optional(),
  interests: z.string().optional(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional(),
  nickname: z.string().optional(),
  showDepartment: z.boolean().optional(),
  showPhone: z.boolean().optional(),
  allowAnonymousComments: z.boolean().optional(),
  studyStreakDays: z.number().int().min(0).optional(),
  materialsOpenedCount: z.number().int().min(0).optional(),
  lastActiveDate: z.string().optional().nullable(),
  lastActiveAt: z.coerce.date().optional().nullable(),
  photoUrl: z.string().max(2000000).optional().nullable(),
  avatarUrl: z.string().max(2000000).optional().nullable(),
  fcmToken: z.string().optional().nullable(),
  deviceToken: z.string().optional().nullable(),
  settings: z.record(z.any()).optional().nullable(),
  profileComplete: z.boolean().optional(),
  uniqueId: z.string().optional(), // only allowed if currently null
  canImportAI: z.boolean().optional(),
  autoPublish: z.boolean().optional(),
  courseRepMeta: z.record(z.any()).nullable().optional(),
  customCourses: z.array(z.any()).optional(),
});

async function createUniqueId() {
  const year = new Date().getFullYear().toString().slice(-2);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = `UAR-${year}-${Math.floor(1000 + Math.random() * 9000)}`;
    const existing = await prisma.user.findUnique({ where: { uniqueId: candidate } });
    if (!existing) return candidate;
  }
  throw new Error("Could not generate a unique ID. Please try again.");
}

export async function updateMe(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });

  try {
    const body = updateProfileSchema.parse(req.body);
    const current = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!current) return res.status(404).json({ error: "User not found" });

    // uniqueId can only be set once
    if (body.uniqueId && current.uniqueId) {
      return res.status(400).json({ error: "uniqueId already set" });
    }

    const generatedUniqueId = body.profileComplete && !current.uniqueId
      ? await createUniqueId()
      : undefined;

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        name: body.name,
        department: body.department,
        faculty: body.faculty,
        level: body.level,
        matricNumber: body.matricNumber,
        phone: body.phone,
        bio: body.bio,
        interests: body.interests,
        dob: body.dob,
        gender: body.gender,
        nickname: body.nickname,
        showDepartment: body.showDepartment,
        showPhone: body.showPhone,
        allowAnonymousComments: body.allowAnonymousComments,
        photoUrl: body.photoUrl,
        avatarUrl: body.avatarUrl,
        fcmToken: body.fcmToken,
        deviceToken: body.deviceToken,
        ...(body.settings !== undefined ? { settings: body.settings === null ? Prisma.JsonNull : body.settings } : {}),
        profileComplete: body.profileComplete,
        studyStreakDays: body.studyStreakDays,
        materialsOpenedCount: body.materialsOpenedCount,
        lastActiveDate: body.lastActiveDate,
        lastActiveAt: body.lastActiveAt,
        ...(body.uniqueId && !current.uniqueId
          ? { uniqueId: body.uniqueId }
          : generatedUniqueId
            ? { uniqueId: generatedUniqueId }
            : {}),
          canImportAI: body.canImportAI,
          autoPublish: body.autoPublish,
          ...(body.courseRepMeta !== undefined
            ? { courseRepMeta: body.courseRepMeta === null ? Prisma.JsonNull : body.courseRepMeta }
            : {}),
          customCourses: body.customCourses,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        plan: true,
        uniqueId: true,
        department: true,
        photoUrl: true,
        faculty: true,
        level: true,
        matricNumber: true,
        phone: true,
        bio: true,
        interests: true,
        dob: true,
        gender: true,
        nickname: true,
        showDepartment: true,
        showPhone: true,
        allowAnonymousComments: true,
        profileComplete: true,
        studyStreakDays: true,
        materialsOpenedCount: true,
        lastActiveDate: true,
        lastActiveAt: true,
        emailVerified: true,
      },
    });

    res.json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
}

const adminUpdateSchema = z.object({
  role: z.enum(["admin", "alphaAgent", "agent", "courseRep", "user"]).optional(),
  plan: z.enum(["free", "pro", "annual"]).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  name: z.string().optional(),
  department: z.string().optional(),
  faculty: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  mustChangePassword: z.boolean().optional(),
  assignedBy: z.string().nullable().optional(),
  assignedAt: z.coerce.date().nullable().optional(),
  courseRepDepartment: z.string().nullable().optional(),
  courseRepLevel: z.string().nullable().optional(),
  courseRepMeta: z.record(z.any()).nullable().optional(),
  fcmToken: z.string().nullable().optional(),
  deviceToken: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
});

export async function adminUpdateUser(req: Request, res: Response) {
  try {
    const body = adminUpdateSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: String(req.params.id) },
      data: {
        ...body,
        courseRepMeta: undefined,
        ...(body.courseRepMeta !== undefined
          ? { courseRepMeta: body.courseRepMeta === null ? Prisma.JsonNull : body.courseRepMeta }
          : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        plan: true,
        status: true,
        department: true,
      },
    });

    res.json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
}

const createAgentSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(6),
  name: z.string().trim().min(1).optional(),
  role: z.enum(["agent", "alphaAgent"]),
});

export async function createAgent(req: Request, res: Response) {
  try {
    const body = createAgentSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) return res.status(409).json({ error: "Email already registered" });
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 12),
        name: body.name || body.email.split("@")[0],
        role: body.role,
        emailVerified: true,
        profileComplete: true,
        mustChangePassword: true,
        agentDomain: body.email.split("@")[1],
        createdByAdmin: true,
        createdByUid: req.user?.id,
      },
      select: { id: true, email: true, name: true, role: true, plan: true, uniqueId: true, status: true, emailVerified: true, profileComplete: true, mustChangePassword: true },
    });
    return res.status(201).json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    console.error(err);
    return res.status(500).json({ error: "Could not create agent" });
  }
}

export async function deleteUser(req: Request, res: Response) {
  try {
    await prisma.user.update({ where: { id: String(req.params.id) }, data: { status: "deleted" } });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(404).json({ error: "User not found" });
  }
}
