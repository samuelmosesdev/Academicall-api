import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { DEFAULT_INSTITUTION_ID } from "../lib/scope";
import { hid } from "../lib/institutionSeed";

const treeCache = new Map<string, { at: number; value: unknown }>();
const TREE_TTL_MS = 10 * 60 * 1000;

export function invalidateInstitutionCache(id?: string) {
  if (id) treeCache.delete(id);
  else treeCache.clear();
}

const instSelect = {
  id: true, name: true, displayName: true, abbreviation: true, type: true,
  category: true, ownership: true, state: true, source: true,
} as const;

export interface ResolvedAcademicSelection {
  institutionId: string;
  facultyId: string | null;
  departmentId: string | null;
  programId: string | null;
  faculty?: string;
  department?: string;
  program?: string;
}

/** GET /institutions?q=&state=&type=&limit=&offset= — public, used before sign-up completes. */
export async function listInstitutions(req: Request, res: Response) {
  const q = String(req.query.q || "").trim();
  const state = String(req.query.state || "").trim();
  const type = String(req.query.type || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where: any = { active: true };
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 5);
    where.AND = terms.map((term) => ({
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { displayName: { contains: term, mode: "insensitive" } },
        { abbreviation: { contains: term, mode: "insensitive" } },
      ],
    }));
  }
  if (state) where.state = { equals: state, mode: "insensitive" };
  if (type) where.type = type;

  const [rows, total] = await Promise.all([
    prisma.institution.findMany({ where, select: instSelect, orderBy: { name: "asc" }, skip: offset, take: limit + 1 }),
    prisma.institution.count({ where }),
  ]);
  let institutions = rows.slice(0, limit);
  // Keep the University of Abuja at the top of an unfiltered list.
  if (!q && !state && !type && offset === 0) {
    const uofa = await prisma.institution.findUnique({ where: { id: DEFAULT_INSTITUTION_ID }, select: instSelect });
    if (uofa) institutions = [uofa, ...institutions.filter((i) => i.id !== uofa.id)].slice(0, limit);
  }
  res.set("Cache-Control", "public, max-age=300");
  res.json({ institutions, total, limit, offset });
}

export async function getInstitution(req: Request, res: Response) {
  const institution = await prisma.institution.findUnique({ where: { id: String(req.params.id) }, select: instSelect });
  if (!institution) return res.status(404).json({ error: "Institution not found" });
  res.json({ institution });
}

/** GET /institutions/:id/tree — faculties → departments → programmes for one institution. */
export async function getInstitutionTree(req: Request, res: Response) {
  const id = String(req.params.id);
  const cached = treeCache.get(id);
  if (cached && Date.now() - cached.at < TREE_TTL_MS) {
    res.set("Cache-Control", "public, max-age=300");
    return res.json(cached.value);
  }
  const institution = await prisma.institution.findUnique({ where: { id }, select: instSelect });
  if (!institution) return res.status(404).json({ error: "Institution not found" });
  const faculties = await prisma.faculty.findMany({
    where: { institutionId: id, active: true },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, kind: true,
      departments: {
        where: { active: true },
        orderBy: { name: "asc" },
        select: {
          id: true, name: true, derived: true,
          programs: {
            where: { active: true },
            orderBy: { name: "asc" },
            select: { id: true, name: true, status: true, duration: true, award: true },
          },
        },
      },
    },
  });
  // UofA keeps the curated faculty order from the catalog setting.
  if (id === DEFAULT_INSTITUTION_ID) {
    const setting = await prisma.setting.findUnique({ where: { key: "academicCatalog" } });
    const order = ((setting?.value as any)?.faculties || []).map((f: any) => String(f?.name || ""));
    if (order.length) faculties.sort((a, b) => (order.indexOf(a.name) + 1 || 999) - (order.indexOf(b.name) + 1 || 999));
  }
  const value = {
    institution,
    faculties,
    // tells the client this institution's departments are placeholders named after programmes
    derivedDepartments: faculties.length > 0 && faculties.every((f) => f.departments.every((d) => d.derived)),
  };
  treeCache.set(id, { at: Date.now(), value });
  res.set("Cache-Control", "public, max-age=300");
  res.json(value);
}

// ─── Admin: extend the catalog later without a data import ─────────────────

const nameSchema = z.object({ name: z.string().trim().min(2).max(200) });

export async function createInstitution(req: Request, res: Response) {
  try {
    const body = nameSchema.extend({
      displayName: z.string().trim().max(200).optional().nullable(),
      abbreviation: z.string().trim().max(40).optional().nullable(),
      type: z.string().trim().max(40).optional().nullable(),
      category: z.string().trim().max(120).optional().nullable(),
      ownership: z.enum(["Federal", "State", "Private"]).optional().nullable(),
      state: z.string().trim().max(60).optional().nullable(),
    }).parse(req.body);
    const id = hid("inst", body.name, body.abbreviation || "");
    const existing = await prisma.institution.findFirst({ where: { name: { equals: body.name, mode: "insensitive" }, abbreviation: body.abbreviation || null } });
    if (existing) return res.status(409).json({ error: "That institution already exists", institution: existing });
    const institution = await prisma.institution.create({ data: { id, ...body, source: "admin" } });
    res.status(201).json({ institution });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    throw err;
  }
}

export async function createFaculty(req: Request, res: Response) {
  try {
    const { name } = nameSchema.parse(req.body);
    const institutionId = String(req.params.id);
    if (!(await prisma.institution.findUnique({ where: { id: institutionId } }))) return res.status(404).json({ error: "Institution not found" });
    const id = hid("fac", institutionId, name);
    const faculty = await prisma.faculty.upsert({ where: { id }, create: { id, institutionId, name, kind: "faculty" }, update: { active: true } });
    invalidateInstitutionCache(institutionId);
    res.status(201).json({ faculty });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    throw err;
  }
}

export async function createDepartment(req: Request, res: Response) {
  try {
    const { name } = nameSchema.parse(req.body);
    const faculty = await prisma.faculty.findUnique({ where: { id: String(req.params.id) } });
    if (!faculty) return res.status(404).json({ error: "Faculty not found" });
    const id = hid("dep", faculty.id, name);
    const department = await prisma.academicDepartment.upsert({ where: { id }, create: { id, facultyId: faculty.id, name, derived: false }, update: { active: true } });
    invalidateInstitutionCache(faculty.institutionId);
    res.status(201).json({ department });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    throw err;
  }
}

export async function createProgram(req: Request, res: Response) {
  try {
    const body = nameSchema.extend({ duration: z.string().max(40).optional().nullable(), award: z.string().max(40).optional().nullable() }).parse(req.body);
    const department = await prisma.academicDepartment.findUnique({ where: { id: String(req.params.id) }, include: { faculty: true } });
    if (!department) return res.status(404).json({ error: "Department not found" });
    const id = hid("prg", department.id, body.name);
    const program = await prisma.program.upsert({ where: { id }, create: { id, departmentId: department.id, ...body, status: "approved" }, update: { active: true } });
    invalidateInstitutionCache(department.faculty.institutionId);
    res.status(201).json({ program });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    throw err;
  }
}

/**
 * Resolve a profile's academic selection by ids and check that each level
 * belongs to the one above it. Returns the official names to store on the user.
 */
export async function resolveAcademicSelection(sel: {
  institutionId?: string | null; facultyId?: string | null; departmentId?: string | null; programId?: string | null;
}): Promise<ResolvedAcademicSelection | null> {
  if (!sel.institutionId) return null;
  const institution = await prisma.institution.findUnique({ where: { id: sel.institutionId } });
  if (!institution) throw Object.assign(new Error("Institution not found"), { status: 400 });
  const out: ResolvedAcademicSelection = { institutionId: institution.id, facultyId: null, departmentId: null, programId: null };
  if (sel.facultyId) {
    const faculty = await prisma.faculty.findUnique({ where: { id: sel.facultyId } });
    if (!faculty || faculty.institutionId !== institution.id) throw Object.assign(new Error("That faculty does not belong to the selected institution"), { status: 400 });
    out.facultyId = faculty.id;
    out.faculty = faculty.name;
  }
  if (sel.departmentId) {
    const department = await prisma.academicDepartment.findUnique({ where: { id: sel.departmentId } });
    if (!department || department.facultyId !== out.facultyId) throw Object.assign(new Error("That department does not belong to the selected faculty"), { status: 400 });
    out.departmentId = department.id;
    out.department = department.name;
  }
  if (sel.programId) {
    const program = await prisma.program.findUnique({ where: { id: sel.programId } });
    if (!program || program.departmentId !== out.departmentId) throw Object.assign(new Error("That programme does not belong to the selected department"), { status: 400 });
    out.programId = program.id;
    out.program = program.name;
  }
  return out;
}
