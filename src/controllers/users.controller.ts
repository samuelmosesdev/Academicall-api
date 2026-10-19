import { revokeSessions as revokeDeviceSessions } from "../lib/security";
import { resolveAcademicSelection } from "./institutions.controller";
import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { Prisma, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { CAPABILITIES, ADMIN_ONLY, ROLE_DEFAULTS, TAG_DEFAULTS, TAGS, cleanPermissionList, defaultCaps, effectiveCaps, grantable, hasCap, outranks } from "../lib/access";
import { audit } from "../lib/audit";

const USER_LIST_SELECT = {
  id: true, email: true, name: true, role: true, plan: true, uniqueId: true, department: true, faculty: true,
  program: true, institutionId: true, level: true, status: true, photoUrl: true, courseRepMeta: true,
  mustChangePassword: true, staffTags: true, lastActiveAt: true, createdAt: true, emailVerified: true,
  institution: { select: { name: true, displayName: true, abbreviation: true } },
} as const;

const GROUPS: Record<string, any> = {
  students: { role: "user" },
  aspirants: { role: "aspirant" },
  houseLeaders: { staffTags: { has: "houseLeader" } },
  courseReps: { role: "courseRep" },
  news: { staffTags: { has: "news" } },
  secretaries: { staffTags: { has: "secretary" } },
  agents: { role: { in: ["agent", "alphaAgent"] } },
  staff: { role: { in: ["admin", "alphaAgent", "agent"] } },
  admins: { role: "admin" },
};

/**
 * GET /users — the staff user directory.
 * Without ?page it keeps the old shape (up to 500 newest). With ?page it is paginated
 * and sortable: ?group=&status=&plan=&institutionId=&department=&level=&q=&sort=&dir=,
 * and it returns per-group counts for the filter chips.
 */
export async function listUsers(req: Request, res: Response) {
  const role = req.query.role as string | undefined;
  const search = String(req.query.q || "").trim();
  const tag = req.query.tag as string | undefined;
  const where: any = { status: { not: "deleted" } };
  const and: any[] = [];
  if (role === "staff") and.push(GROUPS.staff); else if (role) and.push({ role: role as Role });
  if (tag) and.push({ staffTags: { has: tag } });
  if (search) {
    and.push({ OR: [
      { email: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
      { nickname: { contains: search, mode: "insensitive" } },
      { uniqueId: { contains: search, mode: "insensitive" } },
      { matricNumber: { contains: search, mode: "insensitive" } },
    ] });
  }
  if (req.query.page === undefined) {
    const users = await prisma.user.findMany({
      where: { ...where, AND: and }, select: USER_LIST_SELECT, orderBy: { createdAt: "desc" },
      take: Math.min(Number(req.query.limit) || 100, 500),
    });
    return res.json({ users });
  }

  const base = [...and];
  if (req.query.status && ["active", "suspended", "pending"].includes(String(req.query.status))) base.push({ status: String(req.query.status) });
  if (req.query.plan && ["free", "pro", "annual"].includes(String(req.query.plan))) base.push({ plan: String(req.query.plan) });
  if (req.query.institutionId) base.push({ institutionId: String(req.query.institutionId) });
  if (req.query.department) base.push({ department: { contains: String(req.query.department), mode: "insensitive" } });
  if (req.query.level) base.push({ level: { startsWith: String(req.query.level), mode: "insensitive" } });
  const group = String(req.query.group || "all");
  const listAnd = GROUPS[group] ? [...base, GROUPS[group]] : base;

  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 25, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const sortKey = ["createdAt", "name", "email", "lastActiveAt", "level"].includes(String(req.query.sort)) ? String(req.query.sort) : "createdAt";
  const dir = req.query.dir === "asc" ? "asc" : "desc";
  const orderBy = sortKey === "lastActiveAt" ? [{ lastActiveAt: { sort: dir, nulls: "last" } }, { createdAt: "desc" }] : [{ [sortKey]: dir }, { createdAt: "desc" }];

  const [users, total, ...groupCounts] = await Promise.all([
    prisma.user.findMany({ where: { ...where, AND: listAnd }, select: USER_LIST_SELECT, orderBy: orderBy as any, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.user.count({ where: { ...where, AND: listAnd } }),
    ...Object.values(GROUPS).map((g) => prisma.user.count({ where: { ...where, AND: [...base, g] } })),
    prisma.user.count({ where: { ...where, AND: base } }),
  ]);
  const keys = Object.keys(GROUPS);
  const counts: Record<string, number> = { all: groupCounts[keys.length] as number };
  keys.forEach((k, i) => { counts[k] = groupCounts[i] as number; });
  res.json({ users, total, page, pageSize, counts });
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
    const program = String(req.query.program || "").trim();
    const department = String(req.query.department || "").trim();
    const level = String(req.query.level || "").trim();
    const scope = (program || department).trim();

    if (!scope || !level) {
      return res.status(400).json({
        error: "program or department and level are required",
        hasCourseRep: false,
      });
    }

    const requester = req.user ? await prisma.user.findUnique({ where: { id: req.user.id }, select: { institutionId: true } }) : null;
    const inst = requester?.institutionId || "uofa";
    const reps = await prisma.user.findMany({
      where: { role: "courseRep", status: "active", ...(inst === "uofa" ? { OR: [{ institutionId: "uofa" }, { institutionId: null }] } : { institutionId: inst }) },
      select: {
        id: true,
        name: true,
        department: true,
        program: true,
      institutionId: true,
        level: true,
        courseRepMeta: true,
      },
      take: 200,
    });

    const found = reps.find((candidate) => {
      const meta = (candidate.courseRepMeta as Record<string, unknown> | null) || {};
      const candidateScope = String(meta.program || candidate.program || meta.department || candidate.department || "").trim();
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
            program:
              (found.courseRepMeta as Record<string, unknown> | null)?.program ||
              found.program ||
              (found.courseRepMeta as Record<string, unknown> | null)?.department ||
              found.department ||
              null,
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
      institutionId: true,
      institution: { select: { id: true, name: true, displayName: true, abbreviation: true } },
      level: true,
      matricNumber: true,
      phone: true,
      bio: true,
      betaTester: true,
      twoFactorMethod: true,
      mutedUntil: true,
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
      sessionsRevokedAt: true,
      passwordChangedAt: true,
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
  department: z.string().optional().nullable(),
  faculty: z.string().optional().nullable(),
  program: z.string().optional().nullable(),
  level: z.string().optional().nullable(),
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
  courseRepMeta: z.record(z.any()).nullable().optional(),
  customCourses: z.array(z.any()).optional(),
  institutionId: z.string().min(1).optional().nullable(),
  facultyId: z.string().min(1).optional().nullable(),
  departmentId: z.string().min(1).optional().nullable(),
  programId: z.string().min(1).optional().nullable(),
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

    // Course-rep scope is assigned by staff; a user cannot widen it themselves.
    if (body.courseRepMeta !== undefined && !["admin", "alphaAgent", "agent"].includes(current.role)) {
      delete (body as any).courseRepMeta;
    }

    // Academic selection by id: validated top-down, official names stored alongside.
    let academic: any = null;
    if (body.institutionId !== undefined) {
      academic = body.institutionId
        ? await resolveAcademicSelection(body)
        : { institutionId: null, facultyId: null, departmentId: null, programId: null };
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
          canImportAI: body.canImportAI,
          autoPublish: body.autoPublish,
          ...(body.courseRepMeta !== undefined
            ? { courseRepMeta: body.courseRepMeta === null ? Prisma.JsonNull : body.courseRepMeta }
            : {}),
          customCourses: body.customCourses,
          ...(academic || {}),
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
    if ((err as any)?.status === 400) return res.status(400).json({ error: (err as Error).message });
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
}

const adminUpdateSchema = z.object({
  role: z.enum(["admin", "alphaAgent", "agent", "courseRep", "newsAgent", "user", "aspirant"]).optional(),
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
  institutionId: z.string().nullable().optional(),
  facultyId: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  programId: z.string().nullable().optional(),
});

class Forbidden extends Error { status = 403; }
const STAFF_ROLES = ["admin", "alphaAgent", "agent"];

/**
 * Staff edit a user. Every field is checked against the editor's capabilities,
 * and nobody but an admin can touch someone of equal or higher rank.
 */
export async function adminUpdateUser(req: Request, res: Response) {
  try {
    const actor = req.user!;
    const body = adminUpdateSchema.parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
    if (!target) return res.status(404).json({ error: "User not found" });
    if (!outranks(actor, target)) throw new Forbidden("You can't change an account at or above your own rank");
    const need = (cap: string) => { if (!hasCap(actor, cap)) throw new Forbidden(`You need the "${cap}" permission for that`); };

    const data: Prisma.UserUpdateInput = {};
    let tags = [...(target.staffTags || [])];

    // Legacy: "newsAgent" as a role now means "add the news duty".
    let role = body.role;
    if (role === "newsAgent") {
      need("users.news");
      if (!tags.includes("news")) tags.push("news");
      role = STAFF_ROLES.includes(target.role) || target.role === "courseRep" ? undefined : "user";
    }
    const courseRepChange = role === "courseRep" || (role === "user" && target.role === "courseRep") || body.courseRepMeta !== undefined;
    if (role !== undefined && role !== target.role) {
      if (STAFF_ROLES.includes(role) || STAFF_ROLES.includes(target.role)) need("staff.manage");
      else need("users.courseRep");
      data.role = role;
      if (!STAFF_ROLES.includes(role)) data.permissions = Prisma.JsonNull;
      if (role !== "courseRep" && body.courseRepMeta === undefined) data.courseRepMeta = Prisma.JsonNull;
    }
    if (body.courseRepMeta !== undefined) {
      need("users.courseRep");
      data.courseRepMeta = body.courseRepMeta === null ? Prisma.JsonNull : body.courseRepMeta;
    }
    if (body.status !== undefined && body.status !== target.status) {
      need(body.status === "deleted" ? "users.delete" : "users.suspend");
      if (actor.id === target.id) throw new Forbidden("You can't suspend your own account");
      data.status = body.status;
    }
    if (body.mustChangePassword !== undefined) {
      need("users.password");
      data.mustChangePassword = body.mustChangePassword;
    }
    const profileFields = ["plan", "name", "department", "faculty", "program", "level", "institutionId", "facultyId", "departmentId", "programId", "fcmToken", "deviceToken", "avatarUrl"] as const;
    const touched = profileFields.filter((k) => body[k] !== undefined && body[k] !== (target as any)[k]);
    if (touched.length) {
      // Assigning a Course Rep carries their department and level with it.
      const repOnly = courseRepChange && touched.every((k) => ["department", "faculty", "program", "level"].includes(k));
      if (repOnly) need("users.courseRep"); else need("users.edit");
      for (const k of touched) (data as any)[k] = body[k];
    }
    if (body.assignedBy !== undefined) data.assignedBy = body.assignedBy;
    if (body.assignedAt !== undefined) data.assignedAt = body.assignedAt;
    if (tags.join() !== (target.staffTags || []).join()) data.staffTags = tags;

    const user = await prisma.user.update({
      where: { id: target.id },
      data,
      select: {
        id: true, email: true, name: true, role: true, plan: true, status: true, department: true, faculty: true, program: true,
        level: true, courseRepMeta: true, assignedBy: true, assignedAt: true, mustChangePassword: true, staffTags: true,
      },
    });
    if (data.role) await audit(actor, "role.change", { id: target.id, label: target.name || target.email }, { from: target.role, to: data.role });
    if (data.status) await audit(actor, data.status === "suspended" ? "user.suspend" : data.status === "active" ? "user.reactivate" : "user.delete", { id: target.id, label: target.name || target.email });
    if (data.staffTags) await audit(actor, "duty.change", { id: target.id, label: target.name || target.email }, { from: target.staffTags, to: tags });
    res.json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    if (err instanceof Forbidden) return res.status(403).json({ error: err.message });
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
  await revokeDeviceSessions(target.id);
  await audit(req.user, "user.sign_out_everywhere", { id: target.id, label: target.name || target.email });
  res.json({ ok: true });
}

/** The permission catalogue the admin chooses from. */
export async function accessCatalog(_req: Request, res: Response) {
  res.json({ capabilities: CAPABILITIES, adminOnly: ADMIN_ONLY, roleDefaults: ROLE_DEFAULTS, tagDefaults: TAG_DEFAULTS, tags: TAGS });
}

const accessSchema = z.object({
  tags: z.object({ news: z.boolean().optional(), secretary: z.boolean().optional(), newsChief: z.boolean().optional(), houseLeader: z.boolean().optional() }).optional(),
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
      if (tag === "newsChief") {
        if (actor.role !== "admin") return res.status(403).json({ error: "Only admins appoint the Chief News Agent" });
        if (target.role === "aspirant") return res.status(400).json({ error: "Aspirants can't hold staff duties" });
        // The chief is also a News Agent.
        tags = on ? [...new Set([...tags, "newsChief", "news"])] : tags.filter((t) => t !== "newsChief");
        continue;
      }
      const cap = tag === "news" ? "users.news" : tag === "houseLeader" ? "users.houseLeader" : "users.secretary";
      if (!hasCap(actor, cap)) return res.status(403).json({ error: `You need the "${cap}" permission for that` });
      if (on && target.role === "aspirant") return res.status(400).json({ error: "Aspirants can't hold staff duties" });
      tags = on ? [...new Set([...tags, tag])] : tags.filter((t) => t !== tag && !(tag === "news" && t === "newsChief"));
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
    // Dropping the House Leader duty ends every house they led.
    if ((target.staffTags || []).includes("houseLeader") && !tags.includes("houseLeader")) {
      await prisma.aspirantHouseLeader.deleteMany({ where: { userId: target.id } });
    }
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
