import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { Role } from "@prisma/client";

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
  profileComplete: z.boolean().optional(),
  uniqueId: z.string().optional(), // only allowed if currently null
});

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
        profileComplete: body.profileComplete,
        studyStreakDays: body.studyStreakDays,
        materialsOpenedCount: body.materialsOpenedCount,
        lastActiveDate: body.lastActiveDate,
        lastActiveAt: body.lastActiveAt,
        ...(body.uniqueId && !current.uniqueId ? { uniqueId: body.uniqueId } : {}),
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
});

export async function adminUpdateUser(req: Request, res: Response) {
  try {
    const body = adminUpdateSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: String(req.params.id) },
      data: body,
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
