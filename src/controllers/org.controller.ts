/**
 * Organisation management: offices, positions, supervision and assigned work.
 *
 *  - Admins create staff accounts (with a temporary password and a forced change at first sign-in),
 *    choose each person's position and office, and decide who supervises whom.
 *  - An office's head (a Director or HOD) supervises everyone in that office and in the offices
 *    beneath it. Any staff member can also be named the direct supervisor of others.
 *  - Admins and supervisors assign tasks; the assignee updates progress. Everything privileged is audited.
 */
import { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { handle, HttpError } from "../lib/http";
import { audit } from "../lib/audit";
import { grantable } from "../lib/access";
import { notifyMany } from "../lib/notify";
import { DEFAULT_OFFICES, ORG_ROLES, OrgRole, POSITIONS } from "../lib/orgPositions";

const STAFF_ROLES: Array<"agent" | "alphaAgent"> = ["agent", "alphaAgent"];
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
const HEAD_ROLES: OrgRole[] = ["director", "hod"];

const SLIM_USER = { id: true, name: true, nickname: true, positionTitle: true, orgRole: true, photoUrl: true, avatarUrl: true } as const;
const STAFF_SELECT = {
  id: true, name: true, nickname: true, email: true, role: true, status: true, photoUrl: true, avatarUrl: true,
  positionTitle: true, orgRole: true, officeId: true, supervisorId: true, staffTags: true,
  mustChangePassword: true, lastActiveAt: true, createdAt: true,
} as const;

const isAdmin = (req: Request) => req.user?.role === "admin";
const me = (req: Request) => req.user!;

function generateTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(12), (b) => chars[b % chars.length]).join("");
}

function descendantIds(offices: Array<{ id: string; parentId: string | null }>, rootIds: string[]) {
  const out = new Set<string>(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of offices) {
      if (o.parentId && out.has(o.parentId) && !out.has(o.id)) { out.add(o.id); grew = true; }
    }
  }
  return [...out];
}

/** Everyone this person supervises: direct reports plus everyone in the offices they head (and below). */
async function superviseeWhere(userId: string): Promise<Prisma.UserWhereInput> {
  const offices = await prisma.office.findMany({ select: { id: true, parentId: true, headId: true } });
  const headed = offices.filter((o) => o.headId === userId).map((o) => o.id);
  const officeIds = descendantIds(offices, headed);
  return {
    id: { not: userId },
    role: { in: STAFF_ROLES },
    status: { not: "deleted" },
    OR: [{ supervisorId: userId }, ...(officeIds.length ? [{ officeId: { in: officeIds } }] : [])],
  };
}

async function isSupervisor(userId: string) {
  const [reports, headed] = await Promise.all([
    prisma.user.count({ where: { supervisorId: userId, status: { not: "deleted" } } }),
    prisma.office.count({ where: { headId: userId } }),
  ]);
  return reports > 0 || headed > 0;
}

async function supervises(actorId: string, targetId: string) {
  if (actorId === targetId) return false;
  return (await prisma.user.count({ where: { AND: [await superviseeWhere(actorId), { id: targetId }] } })) > 0;
}

async function validateOrg(officeId?: string | null, supervisorId?: string | null, selfId?: string) {
  if (officeId) {
    const office = await prisma.office.findUnique({ where: { id: officeId }, select: { id: true } });
    if (!office) throw new HttpError(400, "That office doesn't exist");
  }
  if (supervisorId) {
    if (selfId && supervisorId === selfId) throw new HttpError(400, "Nobody can supervise themselves");
    const sup = await prisma.user.findUnique({ where: { id: supervisorId }, select: { id: true, role: true, status: true } });
    if (!sup || sup.status === "deleted" || !(STAFF_ROLES as string[]).includes(sup.role)) {
      throw new HttpError(400, "A supervisor must be an active staff member");
    }
    // No loops: walk up the chain; it must never come back to this person.
    let cursor: string | null = supervisorId;
    for (let i = 0; cursor && i < 50; i++) {
      if (selfId && cursor === selfId) throw new HttpError(400, "That would make a supervision loop");
      const up: { supervisorId: string | null } | null = await prisma.user.findUnique({ where: { id: cursor }, select: { supervisorId: true } });
      cursor = up?.supervisorId ?? null;
    }
  }
}

/** A Director/HOD placed in an office becomes its head when it has none. */
async function syncHead(userId: string, officeId: string | null | undefined, orgRole: string | null | undefined) {
  // Stop heading an office they've left or are no longer head-level for.
  await prisma.office.updateMany({
    where: { headId: userId, ...(officeId && HEAD_ROLES.includes(orgRole as OrgRole) ? { id: { not: officeId } } : {}) },
    data: { headId: null },
  });
  if (officeId && HEAD_ROLES.includes(orgRole as OrgRole)) {
    await prisma.office.updateMany({ where: { id: officeId, headId: null }, data: { headId: userId } });
  }
}

async function staffRows(where: Prisma.UserWhereInput) {
  const users: any[] = await prisma.user.findMany({ where, select: STAFF_SELECT, orderBy: [{ name: "asc" }] });
  const ids = users.map((u) => u.id);
  const [open, overdue] = ids.length
    ? await Promise.all([
        prisma.staffTask.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: ids }, status: { not: "done" } }, _count: { _all: true } }),
        prisma.staffTask.groupBy({ by: ["assigneeId"], where: { assigneeId: { in: ids }, status: { not: "done" }, dueAt: { lt: new Date() } }, _count: { _all: true } }),
      ])
    : [[], []];
  const openBy = new Map(open.map((r: any) => [r.assigneeId, r._count._all as number]));
  const lateBy = new Map(overdue.map((r: any) => [r.assigneeId, r._count._all as number]));
  return users.map((u) => ({ ...u, openTasks: openBy.get(u.id) || 0, overdueTasks: lateBy.get(u.id) || 0 }));
}

// ───────────────────────────── meta & my place in the organisation ─────────────────────────────

export const meta = handle(async (_req, res) => {
  res.json({ positions: POSITIONS, orgRoles: ORG_ROLES, priorities: PRIORITIES, statuses: STATUSES });
});

export const myOrg = handle(async (req, res) => {
  const user: any = await prisma.user.findUnique({
    where: { id: me(req).id },
    select: {
      id: true, positionTitle: true, orgRole: true,
      office: { select: { id: true, name: true, code: true, kind: true, description: true, head: { select: SLIM_USER } } },
      supervisor: { select: SLIM_USER },
    },
  });
  const headed = await prisma.office.findMany({ where: { headId: me(req).id }, select: { id: true, name: true, code: true, kind: true } });
  const team = await staffRows(await superviseeWhere(me(req).id));
  const now = new Date();
  const [open, overdue, done] = await Promise.all([
    prisma.staffTask.count({ where: { assigneeId: me(req).id, status: { not: "done" } } }),
    prisma.staffTask.count({ where: { assigneeId: me(req).id, status: { not: "done" }, dueAt: { lt: now } } }),
    prisma.staffTask.count({ where: { assigneeId: me(req).id, status: "done" } }),
  ]);
  const position = POSITIONS.find((p) => p.title === user?.positionTitle) || null;
  res.json({
    positionTitle: user?.positionTitle || null,
    orgRole: user?.orgRole || null,
    office: user?.office || null,
    supervisor: user?.supervisor || null,
    headOf: headed,
    isSupervisor: team.length > 0 || headed.length > 0,
    team,
    duties: position?.duties || [],
    tasks: { open, overdue, done },
  });
});

// ───────────────────────────── offices ─────────────────────────────

const officeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(12).transform((s) => s.toUpperCase()).optional(),
  kind: z.enum(["directorate", "department", "unit"]).default("department"),
  description: z.string().trim().max(500).optional().nullable(),
  parentId: z.string().optional().nullable(),
  headId: z.string().optional().nullable(),
});

const codeFromName = (name: string) =>
  name.split(/\s+/).filter((w) => w.length > 2).map((w) => w[0]).join("").slice(0, 6).toUpperCase() || name.slice(0, 4).toUpperCase();

async function assertNoOfficeLoop(officeId: string | null, parentId?: string | null) {
  if (!parentId) return;
  if (officeId && parentId === officeId) throw new HttpError(400, "An office can't sit under itself");
  const all = await prisma.office.findMany({ select: { id: true, parentId: true } });
  if (!all.some((o) => o.id === parentId)) throw new HttpError(400, "The parent office doesn't exist");
  if (officeId && descendantIds(all, [officeId]).includes(parentId)) throw new HttpError(400, "That would put the office under one of its own sub-offices");
}

async function setOfficeHead(officeId: string, kind: string, headId: string | null) {
  if (!headId) return;
  const head = await prisma.user.findUnique({ where: { id: headId }, select: { id: true, role: true, status: true, orgRole: true } });
  if (!head || head.status === "deleted" || !(STAFF_ROLES as string[]).includes(head.role)) throw new HttpError(400, "An office head must be an active staff member");
  const asHead = kind === "directorate" ? "director" : "hod";
  await prisma.user.update({
    where: { id: headId },
    data: { officeId, ...(!head.orgRole || head.orgRole === "officer" || head.orgRole === "supervisor" ? { orgRole: asHead } : {}) },
  });
}

export const listOffices = handle(async (_req, res) => {
  const offices = await prisma.office.findMany({
    orderBy: { name: "asc" },
    include: {
      head: { select: SLIM_USER },
      members: { where: { status: { not: "deleted" }, role: { in: STAFF_ROLES } }, select: { ...SLIM_USER, status: true, supervisorId: true }, orderBy: { name: "asc" } },
      _count: { select: { tasks: true } },
    },
  });
  res.json({ offices });
});

export const createOffice = handle(async (req, res) => {
  const b = officeSchema.parse(req.body);
  await assertNoOfficeLoop(null, b.parentId);
  const office = await prisma.office.create({
    data: { name: b.name, code: b.code || codeFromName(b.name), kind: b.kind, description: b.description || null, parentId: b.parentId || null, headId: null },
  });
  if (b.headId) {
    await setOfficeHead(office.id, b.kind, b.headId);
    await prisma.office.update({ where: { id: office.id }, data: { headId: b.headId } });
  }
  await audit(req.user, "office.create", { id: office.id, label: office.name });
  res.status(201).json({ office });
});

export const updateOffice = handle(async (req, res) => {
  const id = String(req.params.id);
  const b = officeSchema.partial().parse(req.body);
  const current = await prisma.office.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Office not found");
  if (b.parentId !== undefined) await assertNoOfficeLoop(id, b.parentId);
  if (b.headId) await setOfficeHead(id, b.kind || current.kind, b.headId);
  const office = await prisma.office.update({
    where: { id },
    data: {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.code !== undefined ? { code: b.code } : {}),
      ...(b.kind !== undefined ? { kind: b.kind } : {}),
      ...(b.description !== undefined ? { description: b.description || null } : {}),
      ...(b.parentId !== undefined ? { parentId: b.parentId || null } : {}),
      ...(b.headId !== undefined ? { headId: b.headId || null } : {}),
    },
  });
  await audit(req.user, "office.update", { id, label: office.name });
  res.json({ office });
});

export const deleteOffice = handle(async (req, res) => {
  const id = String(req.params.id);
  const office = await prisma.office.findUnique({ where: { id }, select: { name: true } });
  if (!office) throw new HttpError(404, "Office not found");
  await prisma.office.delete({ where: { id } }); // members, sub-offices and tasks are detached, not deleted
  await audit(req.user, "office.delete", { id, label: office.name });
  res.json({ ok: true });
});

export const seedOffices = handle(async (req, res) => {
  const existing = await prisma.office.findMany({ select: { id: true, code: true } });
  const byCode = new Map(existing.map((o) => [o.code, o.id]));
  let created = 0;
  for (const seed of DEFAULT_OFFICES) {
    if (byCode.has(seed.code)) continue;
    let row;
    try {
      row = await prisma.office.create({
        data: { name: seed.name, code: seed.code, kind: seed.kind, description: seed.description, parentId: seed.parent ? byCode.get(seed.parent) || null : null },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      throw error;
    }
    if (row) { byCode.set(seed.code, row.id); created++; }
  }
  await audit(req.user, "office.seed_defaults", null, { created });
  res.json({ created });
});

// ───────────────────────────── staff accounts ─────────────────────────────

const staffBase = {
  positionKey: z.string().optional(),
  positionTitle: z.string().trim().max(120).optional().nullable(),
  orgRole: z.enum(ORG_ROLES as [OrgRole, ...OrgRole[]]).optional().nullable(),
  role: z.enum(["agent", "alphaAgent"]).optional(),
  officeId: z.string().optional().nullable(),
  supervisorId: z.string().optional().nullable(),
  permissions: z.array(z.string()).optional().nullable(),
  tags: z.array(z.enum(["news", "secretary"])).optional(),
};
const createStaffSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(100).optional(),
  ...staffBase,
});
const updateStaffSchema = z.object({
  ...staffBase,
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

function positionOf(key?: string) {
  if (!key) return undefined;
  const p = POSITIONS.find((x) => x.key === key);
  if (!p) throw new HttpError(400, "Unknown position");
  return p;
}
/** Keep only permissions this person can hold at all. */
const allowedPerms = (role: string, tags: string[], list: string[]) => {
  const allowed = new Set(grantable({ role, staffTags: tags }));
  return list.filter((c) => allowed.has(c));
};

export const listStaff = handle(async (req, res) => {
  const where: Prisma.UserWhereInput = isAdmin(req)
    ? { role: { in: STAFF_ROLES }, status: { not: "deleted" } }
    : await superviseeWhere(me(req).id);
  res.json({ staff: await staffRows(where) });
});

export const createStaff = handle(async (req, res) => {
  const b = createStaffSchema.parse(req.body);
  if (await prisma.user.findUnique({ where: { email: b.email }, select: { id: true } })) throw new HttpError(409, "That email is already registered");
  const pos = positionOf(b.positionKey);
  const role = b.role ?? pos?.role ?? "agent";
  const tags = b.tags ?? pos?.tags ?? [];
  const orgRole = b.orgRole ?? pos?.orgRole ?? "officer";
  const caps = b.permissions ?? pos?.caps ?? null;
  await validateOrg(b.officeId, b.supervisorId);
  const tempPassword = b.password || generateTempPassword();
  const user: any = await prisma.user.create({
    data: {
      email: b.email, name: b.name, role,
      passwordHash: await bcrypt.hash(tempPassword, 12),
      emailVerified: true, profileComplete: true,
      mustChangePassword: true, // they must choose their own password at first sign-in
      agentDomain: b.email.split("@")[1], createdByAdmin: true, createdByUid: me(req).id,
      staffTags: tags, orgRole, positionTitle: b.positionTitle ?? pos?.title ?? null,
      officeId: b.officeId || null, supervisorId: b.supervisorId || null,
      ...(caps ? { permissions: allowedPerms(role, tags, caps) } : {}),
    },
    select: STAFF_SELECT,
  });
  await syncHead(user.id, user.officeId, user.orgRole);
  await audit(req.user, "staff.create", { id: user.id, label: user.name || user.email }, { position: user.positionTitle, officeId: user.officeId });
  res.status(201).json({ user, tempPassword, generated: !b.password });
});

export const updateStaff = handle(async (req, res) => {
  const id = String(req.params.id);
  const b = updateStaffSchema.parse(req.body);
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, staffTags: true, orgRole: true, officeId: true } });
  if (!target || !(STAFF_ROLES as string[]).includes(target.role)) throw new HttpError(404, "Staff member not found");
  const pos = positionOf(b.positionKey);
  const role = b.role ?? pos?.role ?? target.role;
  const tags = b.tags ?? pos?.tags ?? target.staffTags;
  const orgRole = b.orgRole !== undefined ? b.orgRole : pos?.orgRole ?? target.orgRole;
  const caps = b.permissions !== undefined ? b.permissions : pos?.caps;
  const officeId = b.officeId !== undefined ? b.officeId : target.officeId;
  if (b.officeId !== undefined || b.supervisorId !== undefined) await validateOrg(b.officeId, b.supervisorId, id);
  const data: any = {
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.positionTitle !== undefined || pos ? { positionTitle: b.positionTitle ?? pos?.title ?? null } : {}),
    ...(b.role !== undefined || pos ? { role } : {}),
    ...(b.tags !== undefined || pos ? { staffTags: tags } : {}),
    ...(b.orgRole !== undefined || pos ? { orgRole } : {}),
    ...(b.officeId !== undefined ? { officeId: b.officeId || null } : {}),
    ...(b.supervisorId !== undefined ? { supervisorId: b.supervisorId || null } : {}),
    ...(caps !== undefined ? { permissions: caps === null ? Prisma.JsonNull : allowedPerms(role, tags, caps) } : {}),
    ...(b.status ? { status: b.status, ...(b.status === "suspended" ? { sessionsRevokedAt: new Date() } : {}) } : {}),
  };
  const user: any = await prisma.user.update({ where: { id }, data, select: STAFF_SELECT });
  await syncHead(id, officeId, orgRole);
  await audit(req.user, "staff.update", { id, label: user.name || user.email }, { changed: Object.keys(b) });
  res.json({ user });
});

/** Issue a new temporary password, sign the person out everywhere and require a change at next sign-in. */
export const issueTempPassword = handle(async (req, res) => {
  const id = String(req.params.id);
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, email: true } });
  if (!target || !(STAFF_ROLES as string[]).includes(target.role)) throw new HttpError(404, "Staff member not found");
  const tempPassword = generateTempPassword();
  await prisma.user.update({
    where: { id },
    data: { passwordHash: await bcrypt.hash(tempPassword, 12), mustChangePassword: true, sessionsRevokedAt: new Date() },
  });
  await audit(req.user, "staff.temp_password", { id, label: target.name || target.email });
  res.json({ tempPassword });
});

/** Put several staff members under one supervisor (or clear it with supervisorId: null). */
export const assignSupervision = handle(async (req, res) => {
  const b = z.object({ staffIds: z.array(z.string()).min(1).max(200), supervisorId: z.string().nullable() }).parse(req.body);
  for (const staffId of b.staffIds) await validateOrg(null, b.supervisorId, staffId);
  const staff = await prisma.user.findMany({ where: { id: { in: b.staffIds }, role: { in: STAFF_ROLES } }, select: { id: true } });
  await prisma.user.updateMany({ where: { id: { in: staff.map((s) => s.id) } }, data: { supervisorId: b.supervisorId } });
  await audit(req.user, "staff.supervision", b.supervisorId ? { id: b.supervisorId } : null, { count: staff.length });
  if (b.supervisorId && staff.length) {
    await notifyMany([b.supervisorId], { type: "system", title: `You now supervise ${staff.length} staff member${staff.length === 1 ? "" : "s"}`, body: "Open My team to see their work.", createdById: me(req).id, data: { kind: "org_supervision" } });
  }
  res.json({ updated: staff.length });
});

// ───────────────────────────── tasks ─────────────────────────────

const taskInclude = {
  assignee: { select: SLIM_USER },
  createdBy: { select: SLIM_USER },
  office: { select: { id: true, name: true, code: true } },
} as const;

const taskSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  priority: z.enum(PRIORITIES).default("normal"),
  assigneeId: z.string(),
  officeId: z.string().optional().nullable(),
  dueAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().nullable(),
});

async function mayManageAssignee(req: Request, assigneeId: string) {
  if (isAdmin(req)) return true;
  if (assigneeId === me(req).id) return true;
  return supervises(me(req).id, assigneeId);
}

export const listTasks = handle(async (req, res) => {
  const scope = String(req.query.scope || "mine");
  const status = typeof req.query.status === "string" && (STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : undefined;
  let where: Prisma.StaffTaskWhereInput;
  if (scope === "all") {
    if (!isAdmin(req)) throw new HttpError(403, "Only admins can see every task");
    where = {};
  } else if (scope === "team") {
    if (isAdmin(req)) where = {};
    else {
      const team = await prisma.user.findMany({ where: await superviseeWhere(me(req).id), select: { id: true } });
      where = { OR: [{ assigneeId: { in: team.map((t) => t.id) } }, { createdById: me(req).id }] };
    }
  } else {
    where = { assigneeId: me(req).id };
  }
  const tasks: any[] = await prisma.staffTask.findMany({
    where: { ...where, ...(status ? { status } : {}) },
    include: taskInclude,
    orderBy: [{ createdAt: "desc" }],
    take: 300,
  });
  // Open work first, soonest due first; finished work last.
  tasks.sort((a, b) => {
    if ((a.status === "done") !== (b.status === "done")) return a.status === "done" ? 1 : -1;
    const ad = a.dueAt ? +new Date(a.dueAt) : Infinity;
    const bd = b.dueAt ? +new Date(b.dueAt) : Infinity;
    return ad - bd;
  });
  res.json({ tasks });
});

export const createTask = handle(async (req, res) => {
  const b = taskSchema.parse(req.body);
  if (!(await mayManageAssignee(req, b.assigneeId))) throw new HttpError(403, "You can only assign work to yourself or to staff you supervise");
  const assignee = await prisma.user.findUnique({ where: { id: b.assigneeId }, select: { id: true, role: true, status: true, officeId: true } });
  if (!assignee || assignee.status === "deleted" || !(STAFF_ROLES as string[]).includes(assignee.role)) throw new HttpError(400, "Tasks can only be assigned to staff");
  const task: any = await prisma.staffTask.create({
    data: {
      title: b.title, description: b.description || null, priority: b.priority,
      assigneeId: b.assigneeId, createdById: me(req).id,
      officeId: b.officeId ?? assignee.officeId ?? null,
      dueAt: b.dueAt ? new Date(b.dueAt) : null,
    },
    include: taskInclude,
  });
  if (b.assigneeId !== me(req).id) {
    await notifyMany([b.assigneeId], { type: "system", title: `New task: ${b.title}`, body: b.dueAt ? `Due ${new Date(b.dueAt).toDateString()}` : null, createdById: me(req).id, data: { kind: "staff_task", taskId: task.id } });
  }
  await audit(req.user, "task.create", { id: task.id, label: b.title }, { assigneeId: b.assigneeId });
  res.status(201).json({ task });
});

export const updateTask = handle(async (req, res) => {
  const id = String(req.params.id);
  const task = await prisma.staffTask.findUnique({ where: { id } });
  if (!task) throw new HttpError(404, "Task not found");
  const isOwner = task.assigneeId === me(req).id;
  const isManager = isAdmin(req) || task.createdById === me(req).id || (await supervises(me(req).id, task.assigneeId));
  if (!isOwner && !isManager) throw new HttpError(403, "This task isn't yours to change");

  const full = taskSchema.partial().extend({ status: z.enum(STATUSES).optional(), note: z.string().trim().max(1000).optional().nullable() }).parse(req.body);
  // The person doing the work can report progress; managers can change anything.
  const allowed = isManager ? full : { status: full.status, note: full.note };
  if (isManager && allowed.assigneeId && allowed.assigneeId !== task.assigneeId && !(await mayManageAssignee(req, allowed.assigneeId))) {
    throw new HttpError(403, "You can only reassign to staff you supervise");
  }
  const data: any = {
    ...(allowed.title !== undefined ? { title: allowed.title } : {}),
    ...(allowed.description !== undefined ? { description: allowed.description || null } : {}),
    ...(allowed.priority !== undefined ? { priority: allowed.priority } : {}),
    ...(allowed.assigneeId !== undefined ? { assigneeId: allowed.assigneeId } : {}),
    ...(allowed.officeId !== undefined ? { officeId: allowed.officeId || null } : {}),
    ...(allowed.dueAt !== undefined ? { dueAt: allowed.dueAt ? new Date(allowed.dueAt) : null } : {}),
    ...(allowed.note !== undefined ? { note: allowed.note || null } : {}),
    ...(allowed.status !== undefined ? { status: allowed.status, completedAt: allowed.status === "done" ? new Date() : null } : {}),
  };
  const updated: any = await prisma.staffTask.update({ where: { id }, data, include: taskInclude });
  if (allowed.status === "done" && task.status !== "done" && task.createdById && task.createdById !== me(req).id) {
    await notifyMany([task.createdById], { type: "system", title: `Task done: ${task.title}`, createdById: me(req).id, data: { kind: "staff_task", taskId: id } });
  }
  if (allowed.assigneeId && allowed.assigneeId !== task.assigneeId) {
    await notifyMany([allowed.assigneeId], { type: "system", title: `New task: ${updated.title}`, createdById: me(req).id, data: { kind: "staff_task", taskId: id } });
  }
  res.json({ task: updated });
});

export const deleteTask = handle(async (req, res) => {
  const id = String(req.params.id);
  const task = await prisma.staffTask.findUnique({ where: { id } });
  if (!task) throw new HttpError(404, "Task not found");
  const allowed = isAdmin(req) || task.createdById === me(req).id || (await supervises(me(req).id, task.assigneeId));
  if (!allowed) throw new HttpError(403, "Only whoever set the task, their supervisor or an admin can remove it");
  await prisma.staffTask.delete({ where: { id } });
  await audit(req.user, "task.delete", { id, label: task.title });
  res.json({ ok: true });
});

// ───────────────────────────── admin overview ─────────────────────────────

export const overview = handle(async (_req, res) => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 864e5);
  const staffWhere: Prisma.UserWhereInput = { role: { in: STAFF_ROLES }, status: { not: "deleted" } };
  const [staffTotal, suspended, noOffice, unsupervised, pendingFirstLogin, officeCount, open, overdue, doneWeek, offices, openByOffice] = await Promise.all([
    prisma.user.count({ where: staffWhere }),
    prisma.user.count({ where: { ...staffWhere, status: "suspended" } }),
    prisma.user.count({ where: { ...staffWhere, officeId: null } }),
    prisma.user.count({ where: { ...staffWhere, supervisorId: null, orgRole: { not: "director" } } }),
    prisma.user.count({ where: { ...staffWhere, mustChangePassword: true } }),
    prisma.office.count(),
    prisma.staffTask.count({ where: { status: { not: "done" } } }),
    prisma.staffTask.count({ where: { status: { not: "done" }, dueAt: { lt: now } } }),
    prisma.staffTask.count({ where: { status: "done", completedAt: { gte: weekAgo } } }),
    prisma.office.findMany({ select: { id: true, name: true, code: true, kind: true, head: { select: SLIM_USER }, _count: { select: { members: true } } }, orderBy: { name: "asc" } }),
    prisma.staffTask.groupBy({ by: ["officeId"], where: { status: { not: "done" } }, _count: { _all: true } }),
  ]);
  const openMap = new Map(openByOffice.map((r: any) => [r.officeId, r._count._all as number]));
  res.json({
    staff: { total: staffTotal, suspended, noOffice, unsupervised, pendingFirstLogin },
    offices: officeCount,
    tasks: { open, overdue, doneThisWeek: doneWeek },
    byOffice: offices.map((o: any) => ({ id: o.id, name: o.name, code: o.code, kind: o.kind, head: o.head, staff: o._count.members, openTasks: openMap.get(o.id) || 0 })),
  });
});
