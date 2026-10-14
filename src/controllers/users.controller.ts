import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { Prisma, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { resolveAcademicSelection } from "./institutions.controller";
import { DEFAULT_INSTITUTION_ID, institutionOf } from "../lib/scope";
import { ADMIN_ONLY, CAPABILITIES, ROLE_DEFAULTS, TAG_DEFAULTS, TAGS, cleanPermissionList, defaultCaps, effectiveCaps, grantable, hasCap, outranks } from "../lib/access";
import { audit } from "../lib/audit";

export async function listUsers(req: Request, res: Response) {
  const role = req.query.role as string | undefined;
  const search = req.query.q as string | undefined;
  const tag = req.query.tag as string | undefined;

  const users = await prisma.user.findMany({
    where: {
      status: { not: "deleted" },
      ...(role === "staff" ? { role: { in: ["admin", "alphaAgent", "agent"] as Role[] } } : role ? { role: role as Role } : {}),
      ...(tag ? { staffTags: { has: tag } } : {}),
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
      program: true,
      level: true,
      institutionId: true,
      facultyId: true,
      departmentId: true,
      programId: true,
      status: true,
      photoUrl: true,
      courseRepMeta: true,
      mustChangePassword: true,
      staffTags: true,
      lastActiveAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(req.query.limit) || 100, 500),
  });

  res.json({ users });
}

function normalizeLevel(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s*level\s*/g, "")
    .replace(/\s+/g, "");
}

/** Any authenticated user can check whether a program-level Course Rep exists. */
export async function courseRepStatus(req: Request, res: Response) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated", hasCourseRep: false });
    const program = String(req.query.program || "").trim();
    const level = String(req.query.level || "").trim();
    const scope = program;

    if (!scope || !level) {
      return res.status(400).json({
        error: "program and level are required",
        hasCourseRep: false,
      });
    }

    const requester = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { institutionId: true },
    });
    if (!requester) return res.status(401).json({ error: "User not found", hasCourseRep: false });
    const institutionId = institutionOf(requester);
    const reps = await prisma.user.findMany({
      where: {
        role: "courseRep",
        status: "active",
        ...(institutionId === DEFAULT_INSTITUTION_ID
          ? { OR: [{ institutionId }, { institutionId: null }] }
          : { institutionId }),
      },
      select: {
        id: true,
        name: true,
        department: true,
        program: true,
        level: true,
        courseRepMeta: true,
      },
    });

    const found = reps.find((candidate) => {
      const meta = (candidate.courseRepMeta as Record<string, unknown> | null) || {};
      const candidateScope = String(meta.program || "").trim();
      const candidateLevel = String(meta.level ?? candidate.level ?? "").trim();
      return (
        candidateScope.toLowerCase() === scope.toLowerCase() &&
        normalizeLevel(candidateLevel) === normalizeLevel(level)
      );
    });

    return res.json({
      hasCourseRep: Boolean(found),
      rep: found
        ? {
            id: found.id,
            name: found.name,
            program: (found.courseRepMeta as Record<string, unknown> | null)?.program || null,
            level:
              (found.courseRepMeta as Record<string, unknown> | null)?.level ||
              found.level ||
              null,
          }
        : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed", hasCourseRep: false });
  }
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
      faculty: true,
      program: true,
      level: true,
      institutionId: true,
      facultyId: true,
      departmentId: true,
      programId: true,
      institution: { select: { id: true, name: true, displayName: true, abbreviation: true } },
      matricNumber: true,
      phone: true,
      bio: true,
      photoUrl: true,
      avatarUrl: true,
      status: true,
      profileComplete: true,
      emailVerified: true,
      mustChangePassword: true,
      courseRepMeta: true,
      assignedBy: true,
      assignedAt: true,
      coursesEnrolledCount: true,
      questionsPracticedCount: true,
      studyStreakDays: true,
      materialsOpenedCount: true,
      lastActiveAt: true,
      staffTags: true,
      permissions: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    user: {
      ...user,
      capabilities: effectiveCaps(user),
      defaultCapabilities: defaultCaps(user),
      grantableCapabilities: grantable(user),
      customPermissions: Array.isArray(user.permissions),
    },
    viewer: { canManage: outranks(req.user!, user), caps: req.user!.caps || [] },
  });
}

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  department: z.string().trim().optional().nullable(),
  faculty: z.string().trim().optional().nullable(),
  program: z.string().trim().optional().nullable(),
  level: z.string().trim().optional().nullable(),
  matricNumber: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  bio: z.string().optional().nullable(),
  interests: z.string().optional().nullable(),
  dob: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  nickname: z.string().optional().nullable(),
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
  customCourses: z.array(z.any()).optional(),
  institutionId: z.string().min(1).nullable().optional(),
  facultyId: z.string().min(1).nullable().optional(),
  departmentId: z.string().min(1).nullable().optional(),
  programId: z.string().min(1).nullable().optional(),
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

    if (body.profileComplete && ["user", "courseRep"].includes(current.role)) {
      const program = String(body.program ?? current.program ?? "").trim();
      const department = String(body.department ?? current.department ?? "").trim();
      const faculty = String(body.faculty ?? current.faculty ?? "").trim();
      const level = String(body.level ?? current.level ?? "").trim();
      if (!(body.institutionId ?? current.institutionId) || !program || !department || !faculty || !level) {
        return res.status(400).json({
          error: "Institution, faculty, department, program, and level are required to complete your profile.",
        });
      }
    }

    if (current.profileComplete && body.profileComplete === false) {
      return res.status(400).json({ error: "A completed profile cannot be marked incomplete." });
    }

    const identityFields = [
      "department", "faculty", "program", "level",
      "institutionId", "facultyId", "departmentId", "programId",
    ] as const;
    const changingAcademicIdentity = identityFields.some(
      (field) => body[field] !== undefined && body[field] !== (current[field] ?? null)
    );
    if (changingAcademicIdentity && current.profileComplete && String(current.program || "").trim()) {
      return res.status(403).json({ error: "Academic details can only be changed through a profile change request" });
    }

    const academicIdsProvided =
      body.facultyId !== undefined || body.departmentId !== undefined || body.programId !== undefined;
    if (academicIdsProvided && body.institutionId === undefined && !current.institutionId) {
      return res.status(400).json({ error: "Choose an institution before selecting its academic structure." });
    }
    const academicSelection: Prisma.UserUncheckedUpdateInput | null = body.institutionId === undefined
      ? null
      : body.institutionId
        ? await resolveAcademicSelection(body)
        : { institutionId: null, facultyId: null, departmentId: null, programId: null };

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
        program: body.program,
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
        ...(academicSelection || {}),
          canImportAI: body.canImportAI,
          autoPublish: body.autoPublish,
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
        program: true,
        level: true,
        institutionId: true,
        facultyId: true,
        departmentId: true,
        programId: true,
        institution: { select: { id: true, name: true, displayName: true, abbreviation: true } },
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
    if (err && typeof err === "object" && "status" in err && err.status === 400 && "message" in err) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
}

const adminUpdateSchema = z.object({
  role: z.enum(["admin", "alphaAgent", "agent", "courseRep", "newsAgent", "user"]).optional(),
  plan: z.enum(["free", "pro", "annual"]).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
  name: z.string().optional(),
  department: z.string().nullable().optional(),
  faculty: z.string().nullable().optional(),
  program: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  mustChangePassword: z.boolean().optional(),
  assignedBy: z.string().nullable().optional(),
  assignedAt: z.coerce.date().nullable().optional(),
  courseRepMeta: z.record(z.any()).nullable().optional(),
  fcmToken: z.string().nullable().optional(),
  deviceToken: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  institutionId: z.string().min(1).nullable().optional(),
  facultyId: z.string().min(1).nullable().optional(),
  departmentId: z.string().min(1).nullable().optional(),
  programId: z.string().min(1).nullable().optional(),
});

export async function adminUpdateUser(req: Request, res: Response) {
  try {
    const actor = req.user!;
    const body = adminUpdateSchema.parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!outranks(actor, target)) return res.status(403).json({ error: "You can't change an account at or above your own rank" });
    const need = (cap: string) => {
        if (!hasCap(actor, cap)) throw Object.assign(new Error(`You need the "${cap}" permission for that`), { status: 403 });
    };
    const staffRoles = ["admin", "alphaAgent", "agent"];
    let role = body.role;
    let tags = [...(target.staffTags || [])];
    if (role === "newsAgent") {
        need("users.news");
        if (!tags.includes("news")) tags.push("news");
        role = target.role === "newsAgent" ? "user" : target.role === "user" ? undefined : target.role;
    }
    const academicSelection: Prisma.UserUncheckedUpdateInput | null = body.institutionId === undefined
        ? null
        : body.institutionId
          ? await resolveAcademicSelection(body)
        : { institutionId: null, facultyId: null, departmentId: null, programId: null };
    const meta = body.courseRepMeta;
    if (role === "courseRep" || (meta !== undefined && meta !== null)) {
        const program = String(meta?.program || "").trim();
        const department = String(meta?.department || "").trim();
        const level = String(meta?.level || "").trim();
      if (!program || !department || !level) {
        return res.status(400).json({
          error: "A Course Rep assignment requires an explicit program, parent department, and level.",
        });
      }
      if (
        (body.program !== undefined && body.program !== program) ||
        (body.department !== undefined && body.department !== department) ||
        (body.level !== undefined && body.level !== level)
      ) {
        return res.status(400).json({
          error: "Course Rep profile and assignment program, department, and level must match.",
        });
      }
      if (
        role === "courseRep" &&
        (body.program !== program || body.department !== department || body.level !== level)
      ) {
        return res.status(400).json({
          error: "Assigning the Course Rep role also requires matching user program, department, and level fields.",
        });
      }
    }

    const data: Prisma.UserUncheckedUpdateInput = {};

    if (role !== undefined && role !== target.role) {
      if (staffRoles.includes(role) || staffRoles.includes(target.role)) need("staff.manage");
      else need("users.courseRep");
      data.role = role;
      if (!staffRoles.includes(role)) data.permissions = Prisma.JsonNull;
      if (role !== "courseRep" && body.courseRepMeta === undefined) data.courseRepMeta = Prisma.JsonNull;
    }
    if (body.plan !== undefined && body.plan !== target.plan) {
      need("users.edit");
      data.plan = body.plan;
    }
    if (body.status !== undefined && body.status !== target.status) {
      need(body.status === "deleted" ? "users.delete" : "users.suspend");
      if (actor.id === target.id) return res.status(403).json({ error: "You can't change your own account status" });
      data.status = body.status;
    }
    if (body.mustChangePassword !== undefined && body.mustChangePassword !== target.mustChangePassword) {
      need("users.password");
      data.mustChangePassword = body.mustChangePassword;
    }
    const profileFields = ["name", "department", "faculty", "program", "level", "fcmToken", "deviceToken", "avatarUrl"] as const;
    const touched = profileFields.filter((key) => body[key] !== undefined && body[key] !== target[key]);
    if (touched.length || academicSelection) {
      const repAssignment = (role === "courseRep" || target.role === "courseRep") &&
        touched.every((key) => ["department", "faculty", "program", "level"].includes(key)) &&
        !body.name && !body.fcmToken && !body.deviceToken && !body.avatarUrl && body.plan === undefined;
      need(repAssignment ? "users.courseRep" : "users.edit");
      for (const key of profileFields) {
        if (body[key] !== undefined) {
          if (key === "name") data.name = body.name;
          if (key === "department") data.department = body.department;
          if (key === "faculty") data.faculty = body.faculty;
          if (key === "program") data.program = body.program;
          if (key === "level") data.level = body.level;
          if (key === "fcmToken") data.fcmToken = body.fcmToken;
          if (key === "deviceToken") data.deviceToken = body.deviceToken;
          if (key === "avatarUrl") data.avatarUrl = body.avatarUrl;
        }
      }
      if (academicSelection) Object.assign(data, academicSelection);
    }
    if (body.courseRepMeta !== undefined) {
      need("users.courseRep");
      data.courseRepMeta = body.courseRepMeta === null ? Prisma.JsonNull : body.courseRepMeta;
    } else if (role === "user" && target.role === "courseRep") {
      data.courseRepMeta = Prisma.JsonNull;
    }
    if (body.assignedBy !== undefined) data.assignedBy = body.assignedBy;
    if (body.assignedAt !== undefined) data.assignedAt = body.assignedAt;
    if (tags.join() !== (target.staffTags || []).join()) data.staffTags = tags;

    const user = await prisma.user.update({
      where: { id: target.id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        plan: true,
        status: true,
        department: true,
        faculty: true,
        program: true,
        level: true,
        institutionId: true,
        facultyId: true,
        departmentId: true,
        programId: true,
        institution: { select: { id: true, name: true, displayName: true, abbreviation: true } },
        courseRepMeta: true,
        assignedBy: true,
        assignedAt: true,
        mustChangePassword: true,
        staffTags: true,
      },
    });

    if (data.role) await audit(actor, "role.change", { id: target.id, label: target.name || target.email }, { from: target.role, to: data.role });
    if (data.status) await audit(actor, data.status === "suspended" ? "user.suspend" : data.status === "active" ? "user.reactivate" : "user.delete", { id: target.id, label: target.name || target.email });
    if (data.staffTags) await audit(actor, "duty.change", { id: target.id, label: target.name || target.email }, { from: target.staffTags, to: tags });
    res.json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    if (err && typeof err === "object" && "status" in err && (err as { status?: unknown }).status === 403) {
      const message = "message" in err && typeof err.message === "string" ? err.message : "Forbidden";
      return res.status(403).json({ error: message });
    }
    console.error("adminUpdateUser failed:", err);
    const reason =
      err instanceof Prisma.PrismaClientValidationError
        ? "Invalid update — field does not match schema."
        : err instanceof Prisma.PrismaClientKnownRequestError
        ? `Database error (${err.code})`
        : err instanceof Error
        ? err.message
        : "Unknown error";
    res.status(500).json({ error: "Update failed", reason });
  }
}

function generateTempPassword() {
  // 12 random chars from an unambiguous alphabet (no 0/O/1/l/I) — easy to
  // read aloud over a phone call when handing it to a user who lost access.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Admin-triggered password reset for a user who lost access to their email.
 *
 * IMPORTANT: this does NOT expose the user's existing password or its hash —
 * bcrypt hashes are one-way, so there is no way to "recover" a lost password
 * from its hash even if you could see it. Showing hashes to admins would add
 * real security risk (offline cracking, leak surface) without solving the
 * actual problem. Instead this issues a brand-new temporary password, shown
 * to the admin exactly once in this response, and forces the user to change
 * it on next login. Verify the user's identity through another channel
 * (student ID, phone call, etc.) before handing over the temp password.
 */
export async function adminResetPassword(req: Request, res: Response) {
  try {
    const userId = String(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, role: true } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!outranks(req.user!, user)) return res.status(403).json({ error: "You can't reset the password of an account at or above your rank" });

    const tempPassword = generateTempPassword();
    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(tempPassword, 12),
        mustChangePassword: true,
        passwordResetHash: null,
        passwordResetExpiresAt: null,
        sessionsRevokedAt: new Date(),
      },
    });
    await audit(req.user, "user.temp_password", { id: user.id, label: user.name || user.email });

    return res.json({
      email: user.email,
      tempPassword,
      note: "Share this with the verified user through a secure channel. It is shown only once — run this again to issue a new one if it's lost.",
    });
  } catch (err) {
    console.error("adminResetPassword failed:", err);
    return res.status(500).json({ error: "Could not reset password" });
  }
}

const createAgentSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(6),
  name: z.string().trim().min(1).optional(),
  role: z.enum(["agent", "alphaAgent"]),
  /** Optional: exactly what this agent may do (defaults for the role otherwise) */
  permissions: z.array(z.string()).nullable().optional(),
  tags: z.array(z.enum(["news", "secretary"])).optional(),
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
        staffTags: body.tags || [],
        ...(body.permissions ? { permissions: cleanPermissionList({ role: body.role, staffTags: body.tags || [] }, body.permissions) } : {}),
      },
      select: { id: true, email: true, name: true, role: true, plan: true, uniqueId: true, status: true, emailVerified: true, profileComplete: true, mustChangePassword: true },
    });
    return res.status(201).json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    if ((err as any)?.status === 400) return res.status(400).json({ error: (err as Error).message });
    console.error(err);
    return res.status(500).json({ error: "Could not create agent" });
  }
}

export async function deleteUser(req: Request, res: Response) {
  try {
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, role: true, name: true, email: true } });
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!outranks(req.user!, target) || target.id === req.user!.id) return res.status(403).json({ error: "You can't delete this account" });
    await prisma.user.update({ where: { id: target.id }, data: { status: "deleted", sessionsRevokedAt: new Date() } });
    await audit(req.user, "user.delete", { id: target.id, label: target.name || target.email });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(404).json({ error: "User not found" });
  }
}

/** Force a password change: they're signed out everywhere and must pick a new password at next sign-in. */
export async function forcePasswordChange(req: Request, res: Response) {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, role: true, name: true, email: true } });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!outranks(req.user!, target)) return res.status(403).json({ error: "You can't force a password change on an account at or above your rank" });
  const signOut = req.body?.signOut !== false;
  await prisma.user.update({ where: { id: target.id }, data: { mustChangePassword: true, ...(signOut ? { sessionsRevokedAt: new Date() } : {}) } });
  await audit(req.user, "user.force_password_change", { id: target.id, label: target.name || target.email }, { signedOut: signOut });
  res.json({ ok: true, mustChangePassword: true, signedOut: signOut });
}

/** Sign someone out of every device. */
export async function revokeSessions(req: Request, res: Response) {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, role: true, name: true, email: true } });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!outranks(req.user!, target)) return res.status(403).json({ error: "You can't sign out an account at or above your rank" });
  await prisma.user.update({ where: { id: target.id }, data: { sessionsRevokedAt: new Date() } });
  await audit(req.user, "user.sign_out_everywhere", { id: target.id, label: target.name || target.email });
  res.json({ ok: true });
}

/** The permission catalogue the admin chooses from. */
export async function accessCatalog(_req: Request, res: Response) {
  res.json({ capabilities: CAPABILITIES, adminOnly: ADMIN_ONLY, roleDefaults: ROLE_DEFAULTS, tagDefaults: TAG_DEFAULTS, tags: TAGS });
}

const accessSchema = z.object({
  tags: z.object({ news: z.boolean().optional(), secretary: z.boolean().optional() }).optional(),
  /** null = back to the defaults for their role and duties */
  permissions: z.array(z.string()).nullable().optional(),
});

/**
 * Duties and permissions for one person.
 *  - News duty: anyone with users.news (admins, and Alpha Agents by default).
 *  - Secretary duty: users.secretary (admins; grantable).
 *  - Permissions: admins only.
 */
export async function updateAccess(req: Request, res: Response) {
  try {
    const actor = req.user!;
    const body = accessSchema.parse(req.body || {});
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!outranks(actor, target) && actor.id !== target.id) return res.status(403).json({ error: "You can't change access for an account at or above your rank" });
    let tags = [...(target.staffTags || [])];
    for (const [tag, on] of Object.entries(body.tags || {})) {
      if (on === undefined) continue;
      const cap = tag === "news" ? "users.news" : "users.secretary";
      if (!hasCap(actor, cap)) return res.status(403).json({ error: `You need the "${cap}" permission for that` });
      tags = on ? [...new Set([...tags, tag])] : tags.filter((t) => t !== tag);
    }
    const data: Prisma.UserUpdateInput = { staffTags: tags };
    if (body.permissions !== undefined) {
      if (actor.role !== "admin") return res.status(403).json({ error: "Only admins choose what each person can do" });
      if (target.role === "admin") return res.status(400).json({ error: "Admins always have full access" });
      data.permissions = body.permissions === null ? Prisma.JsonNull : cleanPermissionList({ ...target, staffTags: tags }, body.permissions);
    } else if (target.permissions && !tags.includes("secretary")) {
      // Dropping a duty drops the permissions that came with it.
      const list = cleanPermissionList({ ...target, staffTags: [...tags, "secretary"] }, target.permissions).filter((c) => !c.startsWith("secretariat."));
      data.permissions = list;
    }
    const user = await prisma.user.update({ where: { id: target.id }, data, select: { id: true, role: true, staffTags: true, permissions: true } });
    if (tags.join() !== (target.staffTags || []).join()) await audit(actor, "duty.change", { id: target.id, label: target.name || target.email }, { from: target.staffTags, to: tags });
    if (body.permissions !== undefined) await audit(actor, "permissions.change", { id: target.id, label: target.name || target.email }, { permissions: body.permissions });
    res.json({ user: { ...user, capabilities: effectiveCaps(user), defaultCapabilities: defaultCaps(user), grantableCapabilities: grantable(user), customPermissions: Array.isArray(user.permissions) } });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message || "Invalid input" });
    const e = err as { status?: number; message?: string };
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error("updateAccess failed:", err);
    res.status(500).json({ error: "Couldn't update access" });
  }
}

/** Everyone with staff power or a duty, with what they can do. */
export async function listStaffAccess(_req: Request, res: Response) {
  const people = await prisma.user.findMany({
    where: { status: { not: "deleted" }, OR: [{ role: { in: ["admin", "alphaAgent", "agent"] } }, { staffTags: { isEmpty: false } }] },
    select: { id: true, name: true, email: true, role: true, status: true, staffTags: true, permissions: true, photoUrl: true, lastActiveAt: true, mustChangePassword: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    take: 500,
  });
  res.json({
    people: people.map(({ permissions, ...p }) => ({
      ...p,
      capabilities: effectiveCaps({ ...p, permissions }),
      grantableCapabilities: grantable(p),
      customPermissions: Array.isArray(permissions),
    })),
  });
}
