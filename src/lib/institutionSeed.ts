import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import { prisma } from "./prisma";
import { DEFAULT_INSTITUTION_ID } from "./scope";

const DATA_FILE = path.resolve(__dirname, "../../prisma/data/institutions.json.gz");

/** Same deterministic ids as scripts/build-institutions-data.py. */
export function hid(prefix: string, ...parts: string[]) {
  const raw = parts.map((p) => String(p).trim().toUpperCase()).join("|");
  return `${prefix}_${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20)}`;
}

interface SeedProgram { id: string; name: string; status?: string; duration?: string | null; utme?: string | null; award?: string | null }
interface SeedDepartment { id: string; name: string; derived: boolean; programs: SeedProgram[] }
interface SeedFaculty { id: string; name: string; kind: string; departments: SeedDepartment[] }
interface SeedInstitution {
  id: string; name: string; displayName?: string | null; abbreviation?: string | null; type?: string | null;
  category?: string | null; ownership?: string | null; state?: string | null; faculties: SeedFaculty[];
}

async function inBatches<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

/**
 * Loads the bundled institution data. Idempotent: rows are keyed by deterministic
 * ids and inserted with skipDuplicates, so it is safe to run on every boot.
 */
export async function seedInstitutions({ log = console.log } = {}) {
  if (!fs.existsSync(DATA_FILE)) {
    log(`[institutions] data file missing: ${DATA_FILE}`);
    return { skipped: true };
  }
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(DATA_FILE)).toString("utf8")) as {
    version: number; institutions: SeedInstitution[];
  };

  const insts: any[] = [];
  const facs: any[] = [];
  const deps: any[] = [];
  const progs: any[] = [];
  for (const inst of payload.institutions) {
    insts.push({
      id: inst.id, name: inst.name, displayName: inst.displayName || null, abbreviation: inst.abbreviation || null,
      type: inst.type || null, category: inst.category || null, ownership: inst.ownership || null, state: inst.state || null,
      source: inst.id === DEFAULT_INSTITUTION_ID ? "curated" : "ibass",
    });
    for (const f of inst.faculties) {
      facs.push({ id: f.id, institutionId: inst.id, name: f.name, kind: f.kind });
      for (const d of f.departments) {
        deps.push({ id: d.id, facultyId: f.id, name: d.name, derived: Boolean(d.derived) });
        for (const p of d.programs) {
          progs.push({
            id: p.id, departmentId: d.id, name: p.name, status: p.status || "approved",
            duration: p.duration || null, award: p.award || null, utmeSubjects: p.utme || null,
          });
        }
      }
    }
  }

  const before = await prisma.program.count();
  const instCount = await prisma.institution.count();
  if (instCount >= insts.length && before >= progs.length) {
    log(`[institutions] catalogue already loaded (${instCount} institutions, ${before} programmes)`);
    await syncFromSetting();
    return { institutions: instCount, programsAdded: 0 };
  }
  await inBatches(insts, 500, (chunk) => prisma.institution.createMany({ data: chunk, skipDuplicates: true }));
  // The UofA row may already exist from the migration — fill in its display name.
  await prisma.institution.updateMany({ where: { id: DEFAULT_INSTITUTION_ID, displayName: null }, data: { displayName: "University of Abuja" } });
  await inBatches(facs, 1000, (chunk) => prisma.faculty.createMany({ data: chunk, skipDuplicates: true }));
  await inBatches(deps, 2000, (chunk) => prisma.academicDepartment.createMany({ data: chunk, skipDuplicates: true }));
  await inBatches(progs, 2000, (chunk) => prisma.program.createMany({ data: chunk, skipDuplicates: true }));
  await syncFromSetting();
  const after = await prisma.program.count();
  log(`[institutions] ${insts.length} institutions, ${facs.length} faculties, ${deps.length} departments, ${progs.length} programmes in data; ${after - before} programmes added`);
  return { institutions: insts.length, programsAdded: after - before };
}

/**
 * Mirrors the admin-editable UofA catalog (Setting "academicCatalog") into the
 * relational tables. Removed entries are deactivated, never deleted, so users
 * who already chose them keep a valid record.
 */
export async function syncUofaCatalog(catalog: any) {
  const faculties = Array.isArray(catalog?.faculties) ? catalog.faculties : [];
  if (!faculties.length) return;
  const keepF = new Set<string>();
  const keepD = new Set<string>();
  const keepP = new Set<string>();
  for (const fac of faculties) {
    const fname = String(fac?.name || "").trim();
    if (!fname) continue;
    const fid = hid("fac", DEFAULT_INSTITUTION_ID, fname);
    keepF.add(fid);
    await prisma.faculty.upsert({
      where: { id: fid },
      create: { id: fid, institutionId: DEFAULT_INSTITUTION_ID, name: fname, kind: "faculty" },
      update: { active: true },
    });
    for (const dep of fac.departments || []) {
      const dname = String(typeof dep === "string" ? dep : dep?.name || "").trim();
      if (!dname) continue;
      const did = hid("dep", fid, dname);
      keepD.add(did);
      await prisma.academicDepartment.upsert({
        where: { id: did },
        create: { id: did, facultyId: fid, name: dname, derived: false },
        update: { active: true },
      });
      for (const prog of (typeof dep === "string" ? [] : dep.programs) || []) {
        const pname = String(prog || "").trim();
        if (!pname) continue;
        const pid = hid("prg", did, pname);
        keepP.add(pid);
        await prisma.program.upsert({
          where: { id: pid },
          create: { id: pid, departmentId: did, name: pname, status: "approved", award: "Degree" },
          update: { active: true },
        });
      }
    }
  }
  await prisma.faculty.updateMany({ where: { institutionId: DEFAULT_INSTITUTION_ID, id: { notIn: [...keepF] } }, data: { active: false } });
  await prisma.academicDepartment.updateMany({ where: { faculty: { institutionId: DEFAULT_INSTITUTION_ID }, id: { notIn: [...keepD] } }, data: { active: false } });
  await prisma.program.updateMany({ where: { department: { faculty: { institutionId: DEFAULT_INSTITUTION_ID } }, id: { notIn: [...keepP] } }, data: { active: false } });
}

/** Apply admin edits made to the UofA catalog setting on top of the bundled copy. */
async function syncFromSetting() {
  const setting = await prisma.setting.findUnique({ where: { key: "academicCatalog" } });
  if ((setting?.value as any)?.faculties?.length) await syncUofaCatalog(setting!.value);
}
