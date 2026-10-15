/**
 * Admin: academic structure and the course catalogue.
 * Institutions → Faculties → Departments → Programmes, plus Courses, the national
 * Curricula, and course assignments to departments and programmes.
 *
 * Mounted under /admin/academics, guarded by the "academics.manage" capability;
 * permanent deletes need an admin and only succeed on records nothing depends on.
 * Everything else is retired with active=false / archivedAt so student data survives.
 * Renames are copied onto the profiles that store the name, and every change is audited.
 */
import { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { HttpError, handle, pageParams } from "../lib/http";
import { hid } from "../lib/institutionSeed";
import { catalogKey } from "../lib/curriculumSeed";
import { invalidateInstitutionCache } from "./institutions.controller";
import { audit } from "../lib/audit";
import { normCode } from "./myCourses.controller";

const str = (max: number) => z.string().trim().max(max);
const optStr = (max: number) => str(max).optional().nullable().transform((v) => (v === "" ? null : v));
const nameField = str(200).min(2, "Name is too short");
const sortDir = (v: unknown): Prisma.SortOrder => (v === "desc" ? "desc" : "asc");
const isAdmin = (req: Request) => req.user?.role === "admin";
const who = (req: Request) => ({ id: req.user!.id, name: req.user!.name, email: req.user!.email });
const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

// ─── Overview ────────────────────────────────────────────────────────────────
export const summary = handle(async (_req, res) => {
  const [institutions, faculties, departments, programmes, courses, catalogue, curricula, assigned, archived] = await Promise.all([
    prisma.institution.count({ where: { active: true } }),
    prisma.faculty.count({ where: { active: true } }),
    prisma.academicDepartment.count({ where: { active: true } }),
    prisma.program.count({ where: { active: true } }),
    prisma.course.count({ where: { archivedAt: null } }),
    prisma.course.count({ where: { source: "catalogue", archivedAt: null } }),
    prisma.curriculum.count({ where: { active: true } }),
    prisma.departmentCourse.count(),
    prisma.course.count({ where: { archivedAt: { not: null } } }),
  ]);
  const linked = await prisma.programCurriculum.groupBy({ by: ["programId"], _count: true }).then((r) => r.length);
  res.json({ institutions, faculties, departments, programmes, courses, catalogue, curricula, assigned, archived, programmesWithCurriculum: linked });
});

// ─── Institutions ────────────────────────────────────────────────────────────
const instFields = z.object({
  name: nameField,
  displayName: optStr(200),
  abbreviation: optStr(40),
  type: z.enum(["Degree", "ND", "NCE", "Other"]).optional().nullable(),
  category: optStr(120),
  ownership: z.enum(["Federal", "State", "Private"]).optional().nullable(),
  state: optStr(60),
  active: z.boolean().optional(),
});

export const listInstitutions = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const { page, pageSize, skip, take } = pageParams(req.query);
  const where: Prisma.InstitutionWhereInput = {};
  if (q) where.OR = [{ name: contains(q) }, { displayName: contains(q) }, { abbreviation: contains(q) }];
  for (const k of ["state", "type", "ownership"] as const) if (req.query[k]) (where as any)[k] = String(req.query[k]);
  if (req.query.status === "active") where.active = true;
  if (req.query.status === "archived") where.active = false;
  const sort = ["name", "abbreviation", "state", "type", "createdAt"].includes(String(req.query.sort)) ? String(req.query.sort) : "name";
  const [rows, total] = await Promise.all([
    prisma.institution.findMany({ where, orderBy: { [sort]: sortDir(req.query.dir) }, skip, take, include: { _count: { select: { faculties: true, users: true, studyGroups: true } } } }),
    prisma.institution.count({ where }),
  ]);
  res.json({ institutions: rows, total, page, pageSize });
});

export const getInstitution = handle(async (req, res) => {
  const inst = await prisma.institution.findUnique({
    where: { id: String(req.params.id) },
    include: {
      _count: { select: { faculties: true, users: true, studyGroups: true } },
      faculties: { orderBy: { name: "asc" }, include: { _count: { select: { departments: true } } } },
    },
  });
  if (!inst) throw new HttpError(404, "Institution not found");
  res.json({ institution: inst });
});

export const createInstitution = handle(async (req, res) => {
  const body = instFields.parse(req.body);
  const dup = await prisma.institution.findFirst({ where: { name: { equals: body.name, mode: "insensitive" } } });
  if (dup) throw new HttpError(409, `${dup.displayName || dup.name} is already in the list`, "duplicate", { existingId: dup.id });
  if (body.abbreviation) {
    const ab = await prisma.institution.findFirst({ where: { abbreviation: { equals: body.abbreviation, mode: "insensitive" } } });
    if (ab) throw new HttpError(409, `The abbreviation ${body.abbreviation} already belongs to ${ab.displayName || ab.name}`, "duplicate", { existingId: ab.id });
  }
  const institution = await prisma.institution.create({ data: { id: hid("inst", body.name, body.abbreviation || ""), ...body, source: "admin" } });
  invalidateInstitutionCache();
  await audit(who(req), "academics.institution.create", { id: institution.id, label: institution.name });
  res.status(201).json({ institution });
});

export const updateInstitution = handle(async (req, res) => {
  const id = String(req.params.id);
  const body = instFields.partial().parse(req.body);
  const current = await prisma.institution.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Institution not found");
  if (body.name && body.name.toLowerCase() !== current.name.toLowerCase()) {
    const dup = await prisma.institution.findFirst({ where: { id: { not: id }, name: { equals: body.name, mode: "insensitive" } } });
    if (dup) throw new HttpError(409, "Another institution already has that name", "duplicate");
  }
  if (body.abbreviation && body.abbreviation.toLowerCase() !== (current.abbreviation || "").toLowerCase()) {
    const dup = await prisma.institution.findFirst({ where: { id: { not: id }, abbreviation: { equals: body.abbreviation, mode: "insensitive" } } });
    if (dup) throw new HttpError(409, `${body.abbreviation} already belongs to ${dup.displayName || dup.name}`, "duplicate");
  }
  const institution = await prisma.institution.update({ where: { id }, data: body });
  invalidateInstitutionCache(id);
  await audit(who(req), "academics.institution.update", { id, label: institution.name }, { changes: body });
  res.json({ institution });
});

export const deleteInstitution = handle(async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(403, "Only an admin can delete permanently. Archive it instead.");
  const id = String(req.params.id);
  const inst = await prisma.institution.findUnique({ where: { id }, include: { _count: { select: { users: true, studyGroups: true, faculties: true } } } });
  if (!inst) throw new HttpError(404, "Institution not found");
  if (inst._count.users || inst._count.studyGroups) {
    throw new HttpError(409, `${inst._count.users} student${inst._count.users === 1 ? "" : "s"} and ${inst._count.studyGroups} group${inst._count.studyGroups === 1 ? "" : "s"} use this institution. Archive it instead.`, "in_use");
  }
  await prisma.institution.delete({ where: { id } });
  invalidateInstitutionCache(id);
  await audit(who(req), "academics.institution.delete", { id, label: inst.name }, { faculties: inst._count.faculties });
  res.status(204).send();
});

// ─── Faculties ───────────────────────────────────────────────────────────────
export const listFaculties = handle(async (req, res) => {
  const institutionId = String(req.params.id);
  const faculties = await prisma.faculty.findMany({
    where: { institutionId, ...(req.query.status === "active" ? { active: true } : {}) },
    orderBy: { name: "asc" },
    include: { _count: { select: { departments: true } } },
  });
  const users = await prisma.user.groupBy({ by: ["facultyId"], where: { institutionId, facultyId: { not: null } }, _count: true });
  const byFac = new Map(users.map((u) => [u.facultyId, u._count]));
  res.json({ faculties: faculties.map((f) => ({ ...f, students: byFac.get(f.id) || 0 })) });
});

export const createFaculty = handle(async (req, res) => {
  const { name } = z.object({ name: nameField }).parse(req.body);
  const institutionId = String(req.params.id);
  if (!(await prisma.institution.findUnique({ where: { id: institutionId } }))) throw new HttpError(404, "Institution not found");
  const dup = await prisma.faculty.findFirst({ where: { institutionId, name: { equals: name, mode: "insensitive" } } });
  if (dup) {
    if (dup.active) throw new HttpError(409, `${dup.name} already exists here`, "duplicate", { existingId: dup.id });
    const faculty = await prisma.faculty.update({ where: { id: dup.id }, data: { active: true } });
    invalidateInstitutionCache(institutionId);
    return res.status(200).json({ faculty, restored: true });
  }
  const faculty = await prisma.faculty.create({ data: { id: hid("fac", institutionId, name), institutionId, name, kind: "faculty" } });
  invalidateInstitutionCache(institutionId);
  await audit(who(req), "academics.faculty.create", { id: faculty.id, label: name });
  res.status(201).json({ faculty });
});

export const updateFaculty = handle(async (req, res) => {
  const id = String(req.params.id);
  const body = z.object({ name: nameField.optional(), active: z.boolean().optional() }).parse(req.body);
  const current = await prisma.faculty.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Faculty not found");
  if (body.name && body.name.toLowerCase() !== current.name.toLowerCase()) {
    const dup = await prisma.faculty.findFirst({ where: { id: { not: id }, institutionId: current.institutionId, name: { equals: body.name, mode: "insensitive" } } });
    if (dup) throw new HttpError(409, "This institution already has a faculty with that name", "duplicate");
  }
  const faculty = await prisma.$transaction(async (tx) => {
    const f = await tx.faculty.update({ where: { id }, data: body });
    if (body.name) await tx.user.updateMany({ where: { facultyId: id }, data: { faculty: body.name } });
    return f;
  });
  invalidateInstitutionCache(current.institutionId);
  await audit(who(req), "academics.faculty.update", { id, label: faculty.name }, { changes: body });
  res.json({ faculty });
});

export const deleteFaculty = handle(async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(403, "Only an admin can delete permanently. Archive it instead.");
  const id = String(req.params.id);
  const fac = await prisma.faculty.findUnique({ where: { id }, include: { _count: { select: { departments: true } } } });
  if (!fac) throw new HttpError(404, "Faculty not found");
  const students = await prisma.user.count({ where: { facultyId: id } });
  if (students) throw new HttpError(409, `${students} student${students === 1 ? "" : "s"} belong to this faculty. Archive it instead.`, "in_use");
  if (fac._count.departments) throw new HttpError(409, `Move or delete its ${fac._count.departments} department${fac._count.departments === 1 ? "" : "s"} first.`, "has_children");
  await prisma.faculty.delete({ where: { id } });
  invalidateInstitutionCache(fac.institutionId);
  await audit(who(req), "academics.faculty.delete", { id, label: fac.name });
  res.status(204).send();
});

// ─── Departments ─────────────────────────────────────────────────────────────
export const listDepartments = handle(async (req, res) => {
  const facultyId = String(req.params.id);
  const departments = await prisma.academicDepartment.findMany({
    where: { facultyId, ...(req.query.status === "active" ? { active: true } : {}) },
    orderBy: { name: "asc" },
    include: { _count: { select: { programs: true, courses: true } } },
  });
  const users = await prisma.user.groupBy({ by: ["departmentId"], where: { facultyId, departmentId: { not: null } }, _count: true });
  const byDep = new Map(users.map((u) => [u.departmentId, u._count]));
  res.json({ departments: departments.map((d) => ({ ...d, students: byDep.get(d.id) || 0 })) });
});

export const createDepartment = handle(async (req, res) => {
  const { name } = z.object({ name: nameField }).parse(req.body);
  const faculty = await prisma.faculty.findUnique({ where: { id: String(req.params.id) } });
  if (!faculty) throw new HttpError(404, "Faculty not found");
  const dup = await prisma.academicDepartment.findFirst({ where: { facultyId: faculty.id, name: { equals: name, mode: "insensitive" } } });
  if (dup) {
    if (dup.active) throw new HttpError(409, `${dup.name} already exists in this faculty`, "duplicate", { existingId: dup.id });
    const department = await prisma.academicDepartment.update({ where: { id: dup.id }, data: { active: true } });
    invalidateInstitutionCache(faculty.institutionId);
    return res.json({ department, restored: true });
  }
  const department = await prisma.academicDepartment.create({ data: { id: hid("dep", faculty.id, name), facultyId: faculty.id, name, derived: false } });
  invalidateInstitutionCache(faculty.institutionId);
  await audit(who(req), "academics.department.create", { id: department.id, label: name });
  res.status(201).json({ department });
});

export const updateDepartment = handle(async (req, res) => {
  const id = String(req.params.id);
  const body = z.object({ name: nameField.optional(), active: z.boolean().optional(), facultyId: z.string().min(1).optional() }).parse(req.body);
  const current = await prisma.academicDepartment.findUnique({ where: { id }, include: { faculty: true } });
  if (!current) throw new HttpError(404, "Department not found");
  let target = current.faculty;
  if (body.facultyId && body.facultyId !== current.facultyId) {
    const f = await prisma.faculty.findUnique({ where: { id: body.facultyId } });
    if (!f) throw new HttpError(404, "Target faculty not found");
    if (f.institutionId !== current.faculty.institutionId) throw new HttpError(400, "A department can only move to a faculty in the same institution");
    target = f;
  }
  const name = body.name ?? current.name;
  const clash = await prisma.academicDepartment.findFirst({ where: { id: { not: id }, facultyId: target.id, name: { equals: name, mode: "insensitive" } } });
  if (clash) throw new HttpError(409, `${target.name} already has a department called ${clash.name}`, "duplicate");
  const department = await prisma.$transaction(async (tx) => {
    const d = await tx.academicDepartment.update({ where: { id }, data: { name, active: body.active, facultyId: target.id, ...(body.name ? { derived: false } : {}) } });
    if (body.name || target.id !== current.facultyId) {
      await tx.user.updateMany({ where: { departmentId: id }, data: { department: name, facultyId: target.id, faculty: target.name } });
    }
    return d;
  });
  invalidateInstitutionCache(current.faculty.institutionId);
  await audit(who(req), "academics.department.update", { id, label: department.name }, { changes: body });
  res.json({ department });
});

export const deleteDepartment = handle(async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(403, "Only an admin can delete permanently. Archive it instead.");
  const id = String(req.params.id);
  const dep = await prisma.academicDepartment.findUnique({ where: { id }, include: { faculty: true, _count: { select: { programs: true } } } });
  if (!dep) throw new HttpError(404, "Department not found");
  const students = await prisma.user.count({ where: { departmentId: id } });
  if (students) throw new HttpError(409, `${students} student${students === 1 ? "" : "s"} belong to this department. Archive it instead.`, "in_use");
  await prisma.academicDepartment.delete({ where: { id } }); // programmes, curriculum links and course assignments cascade
  invalidateInstitutionCache(dep.faculty.institutionId);
  await audit(who(req), "academics.department.delete", { id, label: dep.name }, { programmes: dep._count.programs });
  res.status(204).send();
});

// ─── Programmes ──────────────────────────────────────────────────────────────
export const listProgrammes = handle(async (req, res) => {
  const departmentId = String(req.params.id);
  const programs = await prisma.program.findMany({
    where: { departmentId },
    orderBy: { name: "asc" },
    include: { curricula: { include: { curriculum: { select: { id: true, name: true, tier: true, general: true, edition: true } } } } },
  });
  const users = await prisma.user.groupBy({ by: ["programId"], where: { departmentId, programId: { not: null } }, _count: true });
  const byProg = new Map(users.map((u) => [u.programId, u._count]));
  res.json({
    programmes: programs.map((p) => ({
      ...p, students: byProg.get(p.id) || 0,
      curricula: p.curricula.map((c) => ({ ...c.curriculum, matchedBy: c.matchedBy })),
    })),
  });
});

const progFields = z.object({ name: nameField, award: optStr(40), duration: optStr(40), active: z.boolean().optional() });

export const createProgramme = handle(async (req, res) => {
  const body = progFields.parse(req.body);
  const dep = await prisma.academicDepartment.findUnique({ where: { id: String(req.params.id) }, include: { faculty: true } });
  if (!dep) throw new HttpError(404, "Department not found");
  const dup = await prisma.program.findFirst({ where: { departmentId: dep.id, name: { equals: body.name, mode: "insensitive" } } });
  if (dup) throw new HttpError(409, `${dup.name} already exists in this department`, "duplicate", { existingId: dup.id });
  const program = await prisma.program.create({ data: { id: hid("prg", dep.id, body.name), departmentId: dep.id, ...body, status: "approved" } });
  invalidateInstitutionCache(dep.faculty.institutionId);
  await audit(who(req), "academics.programme.create", { id: program.id, label: program.name });
  res.status(201).json({ programme: program });
});

export const updateProgramme = handle(async (req, res) => {
  const id = String(req.params.id);
  const body = progFields.partial().parse(req.body);
  const current = await prisma.program.findUnique({ where: { id }, include: { department: { include: { faculty: true } } } });
  if (!current) throw new HttpError(404, "Programme not found");
  if (body.name && body.name.toLowerCase() !== current.name.toLowerCase()) {
    const dup = await prisma.program.findFirst({ where: { id: { not: id }, departmentId: current.departmentId, name: { equals: body.name, mode: "insensitive" } } });
    if (dup) throw new HttpError(409, "This department already has a programme with that name", "duplicate");
  }
  const programme = await prisma.$transaction(async (tx) => {
    const p = await tx.program.update({ where: { id }, data: body });
    if (body.name) await tx.user.updateMany({ where: { programId: id }, data: { program: body.name } });
    return p;
  });
  invalidateInstitutionCache(current.department.faculty.institutionId);
  await audit(who(req), "academics.programme.update", { id, label: programme.name }, { changes: body });
  res.json({ programme });
});

export const deleteProgramme = handle(async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(403, "Only an admin can delete permanently. Archive it instead.");
  const id = String(req.params.id);
  const prog = await prisma.program.findUnique({ where: { id }, include: { department: { include: { faculty: true } } } });
  if (!prog) throw new HttpError(404, "Programme not found");
  const students = await prisma.user.count({ where: { programId: id } });
  if (students) throw new HttpError(409, `${students} student${students === 1 ? "" : "s"} are on this programme. Archive it instead.`, "in_use");
  await prisma.program.delete({ where: { id } });
  invalidateInstitutionCache(prog.department.faculty.institutionId);
  await audit(who(req), "academics.programme.delete", { id, label: prog.name });
  res.status(204).send();
});

export const linkCurriculum = handle(async (req, res) => {
  const programId = String(req.params.id);
  const { curriculumId } = z.object({ curriculumId: z.string().min(1) }).parse(req.body);
  const [prog, cur] = await Promise.all([prisma.program.findUnique({ where: { id: programId } }), prisma.curriculum.findUnique({ where: { id: curriculumId } })]);
  if (!prog) throw new HttpError(404, "Programme not found");
  if (!cur) throw new HttpError(404, "Curriculum not found");
  const link = await prisma.programCurriculum.upsert({
    where: { programId_curriculumId: { programId, curriculumId } },
    create: { programId, curriculumId, matchedBy: "admin" },
    update: {},
  });
  await audit(who(req), "academics.curriculum.link", { id: programId, label: prog.name }, { curriculum: cur.name });
  res.status(201).json({ link });
});

export const unlinkCurriculum = handle(async (req, res) => {
  const programId = String(req.params.id);
  const curriculumId = String(req.params.curriculumId);
  await prisma.programCurriculum.delete({ where: { programId_curriculumId: { programId, curriculumId } } }).catch(() => { throw new HttpError(404, "That curriculum isn't linked to this programme"); });
  await audit(who(req), "academics.curriculum.unlink", { id: programId }, { curriculumId });
  res.status(204).send();
});

// ─── Department course assignments ───────────────────────────────────────────
export const listDepartmentCourses = handle(async (req, res) => {
  const departmentId = String(req.params.id);
  const links = await prisma.departmentCourse.findMany({
    where: { departmentId },
    include: { course: { select: { id: true, code: true, title: true, units: true, level: true, semester: true, archivedAt: true, source: true } } },
    orderBy: [{ level: "asc" }, { createdAt: "asc" }],
  });
  res.json({ courses: links });
});

const courseFields = z.object({
  title: str(200).min(2, "Title is too short"),
  code: str(20).min(2, "Code is too short").transform((c) => normCode(c)),
  units: z.coerce.number().int().min(0).max(30).optional().nullable(),
  level: optStr(30),
  semester: z.enum(["1st", "2nd"]).optional().nullable(),
  description: optStr(2000),
  category: optStr(40),
  faculty: optStr(200),
  department: optStr(200),
  published: z.boolean().optional(),
});

export const assignDepartmentCourse = handle(async (req, res) => {
  const departmentId = String(req.params.id);
  const body = z.object({
    courseId: z.string().min(1).optional(),
    course: courseFields.optional(),
    level: optStr(30),
    semester: z.enum(["1st", "2nd"]).optional().nullable(),
    status: z.enum(["Compulsory", "Elective", "Required"]).optional().nullable(),
  }).refine((b) => b.courseId || b.course, { message: "Pick a course or describe a new one" }).parse(req.body);
  const dep = await prisma.academicDepartment.findUnique({ where: { id: departmentId }, include: { faculty: true } });
  if (!dep) throw new HttpError(404, "Department not found");
  let courseId = body.courseId;
  if (!courseId && body.course) {
    const key = catalogKey(body.course.code, body.course.title);
    const existing = await prisma.course.findFirst({ where: { OR: [{ catalogKey: key }, { code: { equals: body.course.code, mode: "insensitive" }, title: { equals: body.course.title, mode: "insensitive" } }] } });
    courseId = existing?.id || (await prisma.course.create({ data: { ...body.course, department: dep.name, faculty: dep.faculty.name, source: "admin", published: true } })).id;
  }
  const course = await prisma.course.findUnique({ where: { id: courseId! } });
  if (!course) throw new HttpError(404, "Course not found");
  if (course.archivedAt) throw new HttpError(409, "That course is archived. Restore it first.");
  const dup = await prisma.departmentCourse.findUnique({ where: { departmentId_courseId: { departmentId, courseId: course.id } } });
  if (dup) throw new HttpError(409, `${course.code || course.title} is already assigned to ${dep.name}`, "duplicate");
  const link = await prisma.departmentCourse.create({
    data: { departmentId, courseId: course.id, level: body.level ?? course.level, semester: body.semester ?? course.semester, status: body.status ?? null, createdById: req.user!.id },
    include: { course: true },
  });
  await audit(who(req), "academics.course.assign", { id: course.id, label: `${course.code || ""} ${course.title}`.trim() }, { department: dep.name, departmentId });
  res.status(201).json({ link });
});

export const unassignDepartmentCourse = handle(async (req, res) => {
  const link = await prisma.departmentCourse.findFirst({ where: { id: String(req.params.linkId), departmentId: String(req.params.id) }, include: { course: true } });
  if (!link) throw new HttpError(404, "That assignment doesn't exist");
  await prisma.departmentCourse.delete({ where: { id: link.id } });
  await audit(who(req), "academics.course.unassign", { id: link.courseId, label: link.course.code || link.course.title }, { departmentId: link.departmentId });
  res.status(204).send();
});

// ─── Courses ─────────────────────────────────────────────────────────────────
export const listCatalogCourses = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const { page, pageSize, skip, take } = pageParams(req.query);
  const and: Prisma.CourseWhereInput[] = [];
  if (q) and.push({ OR: [{ code: contains(q) }, { title: contains(q) }, { department: contains(q) }] });
  if (req.query.category) and.push({ category: String(req.query.category) });
  if (req.query.source === "catalogue") and.push({ source: "catalogue" });
  if (req.query.source === "local") and.push({ OR: [{ source: null }, { source: { not: "catalogue" } }] });
  if (req.query.level) and.push({ level: { startsWith: String(req.query.level), mode: "insensitive" } });
  const where: Prisma.CourseWhereInput = { AND: and };
  where.archivedAt = req.query.status === "archived" ? { not: null } : req.query.status === "all" ? undefined : null;
  const sort = ["code", "title", "level", "createdAt", "updatedAt"].includes(String(req.query.sort)) ? String(req.query.sort) : "code";
  const [rows, total] = await Promise.all([
    prisma.course.findMany({
      where, orderBy: [{ [sort]: sortDir(req.query.dir) }, { title: "asc" }], skip, take,
      include: { _count: { select: { enrollments: true, curriculumEntries: true, departmentLinks: true, documents: true } } },
    }),
    prisma.course.count({ where }),
  ]);
  res.json({ courses: rows, total, page, pageSize });
});

export const getCatalogCourse = handle(async (req, res) => {
  const course = await prisma.course.findUnique({
    where: { id: String(req.params.id) },
    include: {
      _count: { select: { enrollments: true, documents: true } },
      curriculumEntries: { include: { curriculum: { select: { id: true, name: true, tier: true, edition: true, legacyEdition: true } } }, take: 60 },
      departmentLinks: { include: { department: { include: { faculty: { include: { institution: { select: { id: true, name: true, displayName: true, abbreviation: true } } } } } } } },
    },
  });
  if (!course) throw new HttpError(404, "Course not found");
  res.json({ course });
});

export const createCatalogCourse = handle(async (req, res) => {
  const body = courseFields.parse(req.body);
  const key = catalogKey(body.code, body.title);
  const same = await prisma.course.findFirst({ where: { OR: [{ catalogKey: key }, { code: { equals: body.code, mode: "insensitive" }, title: { equals: body.title, mode: "insensitive" } }] } });
  if (same) throw new HttpError(409, `${body.code} ${body.title} is already in the catalogue`, "duplicate", { existingId: same.id });
  const course = await prisma.course.create({ data: { ...body, source: "admin", published: body.published ?? true } });
  await audit(who(req), "academics.course.create", { id: course.id, label: `${course.code} ${course.title}` });
  res.status(201).json({ course });
});

export const updateCatalogCourse = handle(async (req, res) => {
  const id = String(req.params.id);
  const body = courseFields.partial().parse(req.body);
  const current = await prisma.course.findUnique({ where: { id } });
  if (!current) throw new HttpError(404, "Course not found");
  const code = body.code ?? current.code ?? "";
  const title = body.title ?? current.title;
  if (body.code || body.title) {
    const clash = await prisma.course.findFirst({ where: { id: { not: id }, code: { equals: code, mode: "insensitive" }, title: { equals: title, mode: "insensitive" } } });
    if (clash) throw new HttpError(409, `Another course is already ${code} ${title}`, "duplicate", { existingId: clash.id });
  }
  const course = await prisma.$transaction(async (tx) => {
    const c = await tx.course.update({ where: { id }, data: { ...body, ...(current.catalogKey && (body.code || body.title) ? { catalogKey: catalogKey(code, title) } : {}) } });
    if (body.code) await tx.enrollment.updateMany({ where: { courseId: id }, data: { courseCode: body.code } }).catch(() => null);
    if (body.title) await tx.enrollment.updateMany({ where: { courseId: id }, data: { courseTitle: body.title } });
    return c;
  });
  await audit(who(req), "academics.course.update", { id, label: `${course.code} ${course.title}` }, { changes: body });
  res.json({ course });
});

export const archiveCatalogCourse = handle(async (req, res) => {
  const id = String(req.params.id);
  const restore = req.path.endsWith("/restore");
  const course = await prisma.course.update({ where: { id }, data: { archivedAt: restore ? null : new Date() } });
  await audit(who(req), restore ? "academics.course.restore" : "academics.course.archive", { id, label: `${course.code} ${course.title}` });
  res.json({ course });
});

export const deleteCatalogCourse = handle(async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(403, "Only an admin can delete permanently. Archive it instead.");
  const id = String(req.params.id);
  const course = await prisma.course.findUnique({ where: { id }, include: { _count: { select: { enrollments: true, documents: true } } } });
  if (!course) throw new HttpError(404, "Course not found");
  if (course._count.enrollments || course._count.documents) {
    throw new HttpError(409, `${course._count.enrollments} student${course._count.enrollments === 1 ? "" : "s"} have it and ${course._count.documents} material${course._count.documents === 1 ? "" : "s"} use it. Archive it instead.`, "in_use");
  }
  await prisma.course.delete({ where: { id } });
  await audit(who(req), "academics.course.delete", { id, label: `${course.code} ${course.title}` });
  res.status(204).send();
});

// ─── Curricula ───────────────────────────────────────────────────────────────
export const listCurricula = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const { page, pageSize, skip, take } = pageParams(req.query, { def: 30 });
  const where: Prisma.CurriculumWhereInput = {};
  if (q) where.OR = [{ name: contains(q) }, { aliases: { has: q.toUpperCase() } }];
  if (req.query.tier) where.tier = String(req.query.tier);
  const [rows, total] = await Promise.all([
    prisma.curriculum.findMany({ where, orderBy: { name: "asc" }, skip, take, include: { _count: { select: { entries: true, programs: true } } } }),
    prisma.curriculum.count({ where }),
  ]);
  res.json({ curricula: rows.map(({ institutionAbbrs, aliases, ...c }) => ({ ...c, institutions: institutionAbbrs.length, aliases: aliases.slice(0, 6) })), total, page, pageSize });
});

export const getCurriculum = handle(async (req, res) => {
  const cur = await prisma.curriculum.findUnique({
    where: { id: String(req.params.id) },
    include: {
      _count: { select: { programs: true } },
      entries: { include: { course: { select: { id: true, code: true, title: true, archivedAt: true } } }, orderBy: [{ legacy: "asc" }, { level: "asc" }, { semester: "asc" }] },
    },
  });
  if (!cur) throw new HttpError(404, "Curriculum not found");
  res.json({ curriculum: cur });
});

export const updateCurriculum = handle(async (req, res) => {
  const id = String(req.params.id);
  const body = z.object({ name: nameField.optional(), active: z.boolean().optional(), edition: optStr(200) }).parse(req.body);
  const cur = await prisma.curriculum.update({ where: { id }, data: body });
  await audit(who(req), "academics.curriculum.update", { id, label: cur.name }, { changes: body });
  res.json({ curriculum: cur });
});
