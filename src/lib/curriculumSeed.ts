import fs from "fs";
import path from "path";
import zlib from "zlib";
import { prisma } from "./prisma";
import { hid } from "./institutionSeed";

/**
 * National course catalogue (NUC CCMAS 2022/23 + older BMAS, NBTE ND, NCCE NCE).
 *
 * prisma/data/curricula.json.gz is built by scripts/build-curricula-data.py from
 * "Nigerian_Institutions_Programme_Courses.docx". Loading it:
 *   1. one Course row per distinct code + title (catalogKey "CODE|TITLE", source "catalogue")
 *   2. one Curriculum per programme heading, with its CurriculumCourse rows (level, semester, units, status)
 *   3. ProgramCurriculum links: institution abbreviation + JAMB programme name ("jamb"),
 *      then programme name alone within the same tier ("name"), then the general
 *      studies lists every programme of a tier takes ("general": GNS, GSE, EDU).
 * Idempotent and additive: never edits or deletes rows an admin changed.
 */
const DATA_FILE = path.resolve(__dirname, "../../prisma/data/curricula.json.gz");
const INSTITUTIONS_FILE = path.resolve(__dirname, "../../prisma/data/institutions.json.gz");

/**
 * The catalogue clean-up renames programmes ("AGRIC-ECONOMICS AND EXTENSION:" → "Agricultural Economics
 * and Extension") and may change an abbreviation (JOS → UNIJOS). Curricula are keyed by JAMB's names, so
 * keep matching on those too: the bundled file records them as "jamb" / "jambAbbreviation".
 */
function jambNames() {
  const programs = new Map<string, string>();
  const abbrs = new Map<string, string>();
  try {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(INSTITUTIONS_FILE)).toString("utf8"));
    for (const i of data.institutions || []) {
      if (i.jambAbbreviation) abbrs.set(i.id, i.jambAbbreviation);
      for (const f of i.faculties || []) for (const d of f.departments || []) for (const p of d.programs || []) if (p.jamb) programs.set(p.id, p.jamb);
    }
  } catch { /* optional */ }
  return { programs, abbrs };
}
const VERSION_KEY = "curriculaVersion";

interface SeedCourse { level: string; semester: string | null; code: string; title: string; units: number | null; status: string | null; legacy: boolean }
interface SeedCurriculum { name: string; tier: "degree" | "nd" | "nce"; edition: string | null; legacyEdition?: string; institutions: string[]; aliases: string[]; courses: SeedCourse[] }

export const normName = (s: string) => String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").trim();
export const catalogKey = (code: string, title: string) => `${String(code || "").toUpperCase().trim()}|${String(title || "").toUpperCase().replace(/\s+/g, " ").trim()}`;
const TIER_OF: Record<string, "degree" | "nd" | "nce"> = { Degree: "degree", ND: "nd", NCE: "nce" };
/** "Computer Science (B.Sc.)" → "COMPUTER SCIENCE"; "B.Sc. (Ed) Chemistry" → "CHEMISTRY EDUCATION"-ish core words. */
const AWARD_RE = /^(B\.?\s?(SC|A|ENG|TECH|ED|AGRIC|PHARM|ARCH|N\.?SC|MLS|L)\.?(\s?\(ED\))?|M\.?B\.?B\.?S|LL\.?B|D\.?V\.?M|PHARM\.?D|ND|HND|NCE)\.?\s+/i;
export const coreName = (s: string) => normName(String(s || "").replace(/\([^)]*\)/g, " ").replace(AWARD_RE, ""));
const isGeneral = (c: SeedCurriculum) => /^(EDU|GSE) \(/.test(c.name) || /^General Studies \(GNS\)/i.test(c.name);

async function inBatches<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

export async function seedCurricula({ log = console.log, force = false } = {}) {
  if (!fs.existsSync(DATA_FILE)) {
    log(`[curricula] data file missing: ${DATA_FILE}`);
    return { skipped: true };
  }
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(DATA_FILE)).toString("utf8")) as { version: number; generatedAt: string; curricula: SeedCurriculum[] };
  const version = `${payload.version}:${payload.generatedAt}`;
  const done = await prisma.setting.findUnique({ where: { key: VERSION_KEY } });
  if (!force && (done?.value as any)?.version === version) {
    log(`[curricula] catalogue ${version} already loaded`);
    return { skipped: true };
  }
  if ((await prisma.program.count()) === 0) {
    log("[curricula] no programmes yet; load institutions first");
    return { skipped: true };
  }

  // 1. courses
  const courses = new Map<string, any>();
  for (const c of payload.curricula) {
    for (const x of c.courses) {
      const key = catalogKey(x.code, x.title);
      if (courses.has(key)) continue;
      courses.set(key, {
        id: hid("crs", x.code, x.title), catalogKey: key, code: x.code, title: x.title,
        level: x.level, semester: x.semester, units: x.units, source: "catalogue",
        category: c.tier === "degree" ? "Degree" : c.tier === "nd" ? "ND" : "NCE", published: true,
      });
    }
  }
  await inBatches([...courses.values()], 1000, (chunk) => prisma.course.createMany({ data: chunk, skipDuplicates: true }));
  // map catalogKey -> real id (an older row may already hold the key)
  const idByKey = new Map<string, string>();
  for (const row of await prisma.course.findMany({ where: { catalogKey: { not: null } }, select: { id: true, catalogKey: true } })) idByKey.set(row.catalogKey!, row.id);

  // 2. curricula + entries
  const curRows: any[] = []; const entryRows: any[] = [];
  for (const c of payload.curricula) {
    const id = hid("cur", c.tier, c.name);
    curRows.push({ id, name: c.name, tier: c.tier, edition: c.edition, legacyEdition: c.legacyEdition || null, general: isGeneral(c), aliases: c.aliases, institutionAbbrs: c.institutions });
    for (const x of c.courses) {
      const courseId = idByKey.get(catalogKey(x.code, x.title));
      if (!courseId) continue;
      entryRows.push({ curriculumId: id, courseId, level: x.level, semester: x.semester, units: x.units, status: x.status, legacy: x.legacy });
    }
  }
  await inBatches(curRows, 200, (chunk) => prisma.curriculum.createMany({ data: chunk, skipDuplicates: true }));
  await inBatches(entryRows, 2000, (chunk) => prisma.curriculumCourse.createMany({ data: chunk, skipDuplicates: true }));

  // 3. programme links
  const programs: { id: string; name: string; abbr: string | null; type: string | null; award: string | null; instId: string }[] = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.name, p.award, i.abbreviation AS abbr, i.type, i.id AS "instId" FROM programs p
     JOIN academic_departments d ON d.id = p."departmentId"
     JOIN faculties f ON f.id = d."facultyId"
     JOIN institutions i ON i.id = f."institutionId"`,
  );
  const byInstName = new Map<string, string[]>();
  const byTierName = new Map<string, string[]>();
  const byCore = new Map<string, string[]>();
  const general: { id: string; tier: string }[] = [];
  payload.curricula.forEach((c, i) => {
    const id = curRows[i].id;
    if (curRows[i].general) { general.push({ id, tier: c.tier }); return; }
    const core = `${c.tier}|${coreName(c.name)}`;
    byCore.set(core, [...(byCore.get(core) || []), id]);
    for (const alias of c.aliases) {
      const n = normName(alias);
      const t = `${c.tier}|${n}`;
      byTierName.set(t, [...(byTierName.get(t) || []), id]);
      for (const ab of c.institutions) {
        const k = `${ab.toUpperCase()}|${n}`;
        byInstName.set(k, [...(byInstName.get(k) || []), id]);
      }
    }
  });
  const links: any[] = [];
  let jamb = 0, byName = 0, none = 0;
  const original = jambNames();
  const overrides = await prisma.setting.findUnique({ where: { key: "institutionOverrides" } });
  for (const [k, v] of Object.entries(((overrides?.value as any)?.jambAbbreviations || {}) as Record<string, string>)) original.abbrs.set(k, v);
  const firstHit = (keys: string[], m: Map<string, string[]>) => { for (const k of keys) { const ids = m.get(k); if (ids?.length) return ids; } return []; };
  for (const p of programs) {
    const tier = TIER_OF[p.type || ""] || (/^(ND|HND)/i.test(p.award || "") ? "nd" : /^NCE/i.test(p.award || "") ? "nce" : "degree");
    const names = [...new Set([p.name, original.programs.get(p.id)].filter(Boolean) as string[])];
    const abbrs = [...new Set([p.abbr, original.abbrs.get(p.instId)].filter(Boolean).map((a) => String(a).toUpperCase()))];
    let ids = firstHit(abbrs.flatMap((a) => names.map((n) => `${a}|${normName(n)}`)), byInstName);
    let how = "jamb";
    if (!ids.length) { ids = firstHit(names.flatMap((n) => [`${tier}|${normName(n)}`, `${tier}|${coreName(n)}`]), byTierName); how = "name"; }
    if (!ids.length) { ids = firstHit(names.map((n) => `${tier}|${coreName(n)}`), byCore); how = "name"; }
    if (ids.length) (how === "jamb" ? jamb++ : byName++); else none++;
    for (const id of new Set(ids)) links.push({ programId: p.id, curriculumId: id, matchedBy: how });
    for (const g of general) if (g.tier === tier) links.push({ programId: p.id, curriculumId: g.id, matchedBy: "general" });
  }
  await inBatches(links, 5000, (chunk) => prisma.programCurriculum.createMany({ data: chunk, skipDuplicates: true }));

  await prisma.setting.upsert({
    where: { key: VERSION_KEY },
    create: { key: VERSION_KEY, value: { version, loadedAt: new Date().toISOString() } as any },
    update: { value: { version, loadedAt: new Date().toISOString() } as any },
  });
  const result = { courses: courses.size, curricula: curRows.length, entries: entryRows.length, programmes: programs.length, matchedByInstitution: jamb, matchedByName: byName, unmatched: none };
  log(`[curricula] ${JSON.stringify(result)}`);
  return result;
}
