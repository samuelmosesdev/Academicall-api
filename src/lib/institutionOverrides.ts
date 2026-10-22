/**
 * Applies the catalogue corrections in prisma/data/institution-overrides/ to the live database.
 *
 * - Curated institutions (e.g. unijos.json) get their real faculties and departments; every existing
 *   programme row is MOVED and renamed by id, never deleted, so profiles keep pointing at it.
 * - Every other institution (not UofA) gets the global clean-up from discipline-rules.json: readable
 *   names, JAMB groups renamed/split into neutral discipline groupings, duplicates merged.
 * - Rows left empty are deactivated (active=false), never deleted.
 * - References are carried along: users' faculty/department/programme ids and names, course-rep meta,
 *   department course assignments, curriculum links, aspirations, general-test audiences, and the
 *   faculty/department/programme name strings stored on documents, feed posts, class events,
 *   department memberships and study groups.
 *
 * Idempotent and versioned: a Setting row records the hash of the override files; nothing runs until
 * they change. Admin work is respected: admin-created institutions and faculties, and departments an
 * admin created or renamed (derived=false), are left alone.
 */
import { prisma } from "./prisma";
import { norm } from "./scope";
import {
  buildContext, overridesVersion, transformInstitution, DEFAULT_INSTITUTION_ID,
  type Plan, type TInstitution, type TFaculty, type TDepartment, type TProgram,
} from "./catalogRules";
import { invalidateInstitutionCache } from "../controllers/institutions.controller";

export const OVERRIDES_SETTING = "institutionOverrides";

type Row = Record<string, any>;

async function batchUpdate(table: string, cols: { name: string; cast?: string }[], rows: Row[], size = 400) {
  let n = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const params: any[] = [];
    const values = chunk.map((r) => {
      const ph = ["id", ...cols.map((c) => c.name)].map((k, j) => {
        params.push(r[k]);
        const cast = j === 0 ? "" : cols[j - 1].cast ? `::${cols[j - 1].cast}` : "";
        return `$${params.length}${cast}`;
      });
      return `(${ph.join(", ")})`;
    });
    const set = cols.map((c) => `"${c.name}" = v."${c.name}"`).join(", ");
    const sql = `UPDATE "${table}" AS t SET ${set} FROM (VALUES ${values.join(", ")}) AS v(id, ${cols.map((c) => `"${c.name}"`).join(", ")}) WHERE t.id = v.id`;
    n += await prisma.$executeRawUnsafe(sql, ...params);
  }
  return n;
}

async function inBatches<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

/** Load every institution as a tree, including inactive rows. */
async function loadTrees(jambAbbr: Record<string, string>) {
  const [insts, facs, deps, progs] = await Promise.all([
    prisma.institution.findMany({ select: { id: true, name: true, displayName: true, abbreviation: true, type: true, source: true } }),
    prisma.faculty.findMany({ select: { id: true, institutionId: true, name: true, kind: true, active: true } }),
    prisma.academicDepartment.findMany({ select: { id: true, facultyId: true, name: true, derived: true, active: true } }),
    prisma.program.findMany({ select: { id: true, departmentId: true, name: true, active: true, status: true, duration: true, award: true } }),
  ]);
  const depMap = new Map<string, TDepartment & { facultyId: string }>();
  for (const d of deps) depMap.set(d.id, { ...d, programs: [] });
  for (const p of progs) depMap.get(p.departmentId)?.programs.push({ ...p } as TProgram);
  const facMap = new Map<string, TFaculty & { institutionId: string }>();
  for (const f of facs) facMap.set(f.id, { ...f, departments: [] });
  for (const d of depMap.values()) facMap.get(d.facultyId)?.departments.push(d);
  const trees: TInstitution[] = insts.map((i) => ({ ...i, jambAbbreviation: jambAbbr[i.id] || null, faculties: [] }));
  const byInst = new Map(trees.map((t) => [t.id, t]));
  for (const f of facMap.values()) byInst.get(f.institutionId)?.faculties.push(f);
  return { trees, facMap, depMap };
}

interface Final { fac: Map<string, { name: string; kind: string; active: boolean; institutionId: string }>; dep: Map<string, { name: string; facultyId: string; derived: boolean; active: boolean }>; prog: Map<string, { name: string; departmentId: string; active: boolean }> }

export async function applyInstitutionOverrides({ log = console.log, force = false } = {}) {
  const version = overridesVersion();
  const done = await prisma.setting.findUnique({ where: { key: OVERRIDES_SETTING } });
  const prev = (done?.value || {}) as any;
  if (!force && prev.version === version) {
    log(`[institution-overrides] ${version} already applied`);
    return { skipped: true, version };
  }
  if ((await prisma.institution.count()) === 0) {
    log("[institution-overrides] no institutions yet; load them first");
    return { skipped: true, version };
  }
  const jambAbbr: Record<string, string> = { ...(prev.jambAbbreviations || {}) };
  const { trees, facMap, depMap } = await loadTrees(jambAbbr);
  const ctx = buildContext(trees.map((t) => t.name));

  // current state, then overlay every plan to get the final state
  const final: Final = { fac: new Map(), dep: new Map(), prog: new Map() };
  for (const f of facMap.values()) final.fac.set(f.id, { name: f.name, kind: f.kind, active: f.active !== false, institutionId: f.institutionId });
  for (const d of depMap.values()) {
    final.dep.set(d.id, { name: d.name, facultyId: d.facultyId, derived: d.derived, active: d.active !== false });
    for (const p of d.programs) final.prog.set(p.id, { name: p.name, departmentId: d.id, active: p.active !== false });
  }
  const before: Final = { fac: new Map([...final.fac].map(([k, v]) => [k, { ...v }])), dep: new Map([...final.dep].map(([k, v]) => [k, { ...v }])), prog: new Map([...final.prog].map(([k, v]) => [k, { ...v }])) };
  const newFacs: Row[] = []; const newDeps: Row[] = []; const newProgs: Row[] = [];
  const instUpdates: Row[] = [];
  const plans: Plan[] = [];
  const warnings: string[] = [];

  for (const tree of trees) {
    const plan = transformInstitution(tree, ctx);
    if (!plan) continue;
    plans.push(plan);
    warnings.push(...plan.warnings);
    if (plan.unplaced.length) warnings.push(`${tree.abbreviation || tree.id}: ${plan.unplaced.length} programme(s) not in its curated file were left in place: ${plan.unplaced.slice(0, 5).join("; ")}`);
    if ((plan.displayName ?? null) !== (tree.displayName ?? null) || (plan.abbreviation ?? null) !== (tree.abbreviation ?? null)) {
      instUpdates.push({ id: tree.id, displayName: plan.displayName, abbreviation: plan.abbreviation });
    }
    if (plan.jambAbbreviation) jambAbbr[tree.id] = plan.jambAbbreviation;
    for (const f of plan.faculties) {
      if (!final.fac.has(f.id)) newFacs.push({ id: f.id, institutionId: tree.id, name: f.name, kind: f.kind });
      final.fac.set(f.id, { name: f.name, kind: f.kind, active: true, institutionId: tree.id });
      for (const d of f.departments) {
        if (!final.dep.has(d.id)) newDeps.push({ id: d.id, facultyId: f.id, name: d.name, derived: d.derived });
        final.dep.set(d.id, { name: d.name, facultyId: f.id, derived: d.derived, active: true });
        for (const p of d.programs) {
          if (!final.prog.has(p.id)) newProgs.push({ id: p.id, departmentId: d.id, name: p.name, status: p.status || "approved", award: p.award ?? null, duration: p.duration ?? null });
          final.prog.set(p.id, { name: p.name, departmentId: d.id, active: p.active !== false });
        }
      }
    }
    for (const id of plan.deactivateFaculties) final.fac.get(id)!.active = false;
    for (const id of plan.deactivateDepartments) final.dep.get(id)!.active = false;
    for (const id of plan.deactivatePrograms) if (final.prog.has(id)) final.prog.get(id)!.active = false;
  }

  // Unique names per parent: a retired row that would share a name with a live one is renamed "(archived)".
  const resolve = <T extends { name: string; active: boolean }>(m: Map<string, T>, parentOf: (v: T) => string, kind: string) => {
    const seen = new Map<string, string>();
    const order = [...m.entries()].sort((a, b) => Number(b[1].active) - Number(a[1].active));
    for (const [id, v] of order) {
      let key = `${parentOf(v)}|${v.name}`;
      if (seen.has(key)) {
        if (!v.active) v.name = `${v.name} (archived)`;
        else { warnings.push(`${kind} ${id} would duplicate "${v.name}"; kept as "${v.name} (2)"`); v.name = `${v.name} (2)`; }
        key = `${parentOf(v)}|${v.name}`;
        let i = 2; while (seen.has(key)) { v.name = `${v.name.replace(/ \(\d+\)$/, "")} (${++i})`; key = `${parentOf(v)}|${v.name}`; }
      }
      seen.set(key, id);
    }
  };
  resolve(final.fac, (v) => v.institutionId, "faculty");
  resolve(final.dep, (v) => v.facultyId, "department");
  resolve(final.prog, (v) => v.departmentId, "programme");

  // diff
  const facChanged: Row[] = []; const depChanged: Row[] = []; const progChanged: Row[] = [];
  for (const [id, v] of final.fac) { const b = before.fac.get(id); if (b && (b.name !== v.name || b.kind !== v.kind || b.active !== v.active)) facChanged.push({ id, ...v }); }
  for (const [id, v] of final.dep) { const b = before.dep.get(id); if (b && (b.name !== v.name || b.facultyId !== v.facultyId || b.derived !== v.derived || b.active !== v.active)) depChanged.push({ id, ...v }); }
  for (const [id, v] of final.prog) { const b = before.prog.get(id); if (b && (b.name !== v.name || b.departmentId !== v.departmentId || b.active !== v.active)) progChanged.push({ id, ...v }); }
  for (const r of newFacs) r.name = final.fac.get(r.id)!.name;
  for (const r of newDeps) r.name = final.dep.get(r.id)!.name;
  for (const r of newProgs) r.name = final.prog.get(r.id)!.name;

  // write the structure: park renamed rows under unique temporary names, create, then set final values
  const tmp = (r: Row) => ({ id: r.id, name: `${r.name} ~${r.id}` });
  await batchUpdate("faculties", [{ name: "name" }], facChanged.map(tmp));
  await batchUpdate("academic_departments", [{ name: "name" }], depChanged.map(tmp));
  await batchUpdate("programs", [{ name: "name" }], progChanged.map(tmp));
  await inBatches(newFacs, 1000, (c) => prisma.faculty.createMany({ data: c as any, skipDuplicates: true }));
  await batchUpdate("faculties", [{ name: "name" }, { name: "kind" }, { name: "active", cast: "boolean" }], facChanged);
  await inBatches(newDeps, 1000, (c) => prisma.academicDepartment.createMany({ data: c as any, skipDuplicates: true }));
  await batchUpdate("academic_departments", [{ name: "name" }, { name: "facultyId" }, { name: "derived", cast: "boolean" }, { name: "active", cast: "boolean" }], depChanged);
  await inBatches(newProgs, 1000, (c) => prisma.program.createMany({ data: c as any, skipDuplicates: true }));
  await batchUpdate("programs", [{ name: "name" }, { name: "departmentId" }, { name: "active", cast: "boolean" }], progChanged);
  for (const u of instUpdates) await prisma.institution.update({ where: { id: u.id }, data: { displayName: u.displayName, abbreviation: u.abbreviation } });

  // ── references ──
  const merges: Record<string, string> = {}; const depMoves: Record<string, string> = {}; const facMoves: Record<string, string[]> = {};
  for (const p of plans) { Object.assign(merges, p.programMerges); Object.assign(depMoves, p.departmentMoves); Object.assign(facMoves, p.facultyMoves); }
  const touchedInsts = new Set(plans.map((p) => p.institutionId));
  const refs = await carryReferences({ before, final, merges, depMoves, facMoves, touchedInsts, warnings });

  const summary = {
    institutions: plans.length, curated: plans.filter((p) => p.curated).map((p) => p.institutionId),
    facultiesCreated: newFacs.length, departmentsCreated: newDeps.length, programmesCreated: newProgs.length,
    facultiesChanged: facChanged.length, departmentsChanged: depChanged.length, programmesChanged: progChanged.length,
    programmesMerged: Object.keys(merges).filter((id) => before.prog.get(id)?.active).length, institutionsRenamed: instUpdates.length, ...refs, warnings: warnings.length,
  };
  await prisma.setting.upsert({
    where: { key: OVERRIDES_SETTING },
    create: { key: OVERRIDES_SETTING, value: { version, appliedAt: new Date().toISOString(), summary, jambAbbreviations: jambAbbr, warnings: warnings.slice(0, 200) } as any },
    update: { value: { version, appliedAt: new Date().toISOString(), summary, jambAbbreviations: jambAbbr, warnings: warnings.slice(0, 200) } as any },
  });
  invalidateInstitutionCache();
  log(`[institution-overrides] applied ${version}: ${JSON.stringify(summary)}`);
  for (const w of warnings.slice(0, 20)) log(`[institution-overrides] note: ${w}`);
  return { skipped: false, version, summary, warnings };
}

async function carryReferences(a: {
  before: Final; final: Final; merges: Record<string, string>; depMoves: Record<string, string>; facMoves: Record<string, string[]>;
  touchedInsts: Set<string>; warnings: string[];
}) {
  const { before, final, merges, depMoves, facMoves } = a;
  const out = { usersUpdated: 0, departmentCoursesMoved: 0, curriculumLinksCopied: 0, aspirationsUpdated: 0, testsUpdated: 0, recordsRenamed: 0 };
  const mergeRows = Object.entries(merges).map(([from, to]) => ({ from, to }));
  const moveRows = Object.entries(depMoves).map(([from, to]) => ({ from, to }));

  // curriculum links + aspirations follow merged programmes
  await inBatches(mergeRows, 500, async (c) => {
    const vals = c.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
    const params = c.flatMap((r) => [r.from, r.to]);
    out.curriculumLinksCopied += await prisma.$executeRawUnsafe(
      `INSERT INTO program_curricula ("programId", "curriculumId", "matchedBy", "createdAt")
       SELECT v.to_id, pc."curriculumId", pc."matchedBy", now() FROM program_curricula pc JOIN (VALUES ${vals}) AS v(from_id, to_id) ON pc."programId" = v.from_id
       ON CONFLICT DO NOTHING`, ...params);
    out.aspirationsUpdated += await prisma.$executeRawUnsafe(
      `UPDATE aspirations a SET "programId" = v.to_id FROM (VALUES ${vals}) AS v(from_id, to_id) WHERE a."programId" = v.from_id`, ...params);
  });
  // department course assignments follow retired departments (a course already on the new department stays put)
  await inBatches(moveRows, 500, async (c) => {
    const vals = c.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
    out.departmentCoursesMoved += await prisma.$executeRawUnsafe(
      `UPDATE department_courses dc SET "departmentId" = v.to_id FROM (VALUES ${vals}) AS v(from_id, to_id)
       WHERE dc."departmentId" = v.from_id AND NOT EXISTS (SELECT 1 FROM department_courses x WHERE x."departmentId" = v.to_id AND x."courseId" = dc."courseId")`,
      ...c.flatMap((r) => [r.from, r.to]));
  });

  // users: re-resolve from ids
  const instIds = [...a.touchedInsts].filter((i) => i !== DEFAULT_INSTITUTION_ID);
  const users = await prisma.user.findMany({
    where: { institutionId: { in: instIds }, OR: [{ facultyId: { not: null } }, { departmentId: { not: null } }, { programId: { not: null } }] },
    select: { id: true, institutionId: true, facultyId: true, departmentId: true, programId: true, faculty: true, department: true, program: true, courseRepMeta: true },
  });
  const changed = (x: any, y: any) => (x ?? null) !== (y ?? null);
  for (const u of users) {
    let { facultyId, departmentId, programId } = u;
    if (programId && merges[programId]) programId = merges[programId];
    if (programId && final.prog.has(programId)) {
      departmentId = final.prog.get(programId)!.departmentId;
      facultyId = final.dep.get(departmentId)!.facultyId;
    } else if (departmentId && (depMoves[departmentId] || final.dep.has(departmentId))) {
      departmentId = depMoves[departmentId] || departmentId;
      facultyId = final.dep.get(departmentId)?.facultyId || facultyId;
    } else if (facultyId && facMoves[facultyId]?.length === 1) {
      facultyId = facMoves[facultyId][0];
    } else if (facultyId && final.fac.get(facultyId)?.active === false) {
      a.warnings.push(`user ${u.id}: faculty ${facultyId} was split across faculties; left as is`);
    }
    const data: Row = {};
    if (changed(facultyId, u.facultyId)) data.facultyId = facultyId;
    if (changed(departmentId, u.departmentId)) data.departmentId = departmentId;
    if (changed(programId, u.programId)) data.programId = programId;
    const facName = facultyId ? final.fac.get(facultyId)?.name : undefined;
    const depName = departmentId ? final.dep.get(departmentId)?.name : undefined;
    const progName = programId ? final.prog.get(programId)?.name : undefined;
    if (facName && facName !== u.faculty) data.faculty = facName;
    if (depName && depName !== u.department) data.department = depName;
    if (progName && progName !== u.program) data.program = progName;
    const meta = (u.courseRepMeta || null) as Row | null;
    if (meta && typeof meta === "object") {
      const m = { ...meta }; let dirty = false;
      if (progName && m.program && norm(m.program) === norm(u.program) && m.program !== progName) { m.program = progName; dirty = true; }
      if (depName && m.department && norm(m.department) === norm(u.department) && m.department !== depName) { m.department = depName; dirty = true; }
      if (facName && m.faculty && norm(m.faculty) === norm(u.faculty) && m.faculty !== facName) { m.faculty = facName; dirty = true; }
      if (dirty) data.courseRepMeta = m;
    }
    if (Object.keys(data).length) { await prisma.user.update({ where: { id: u.id }, data }); out.usersUpdated++; }
  }

  // name strings on content, per institution: old name → new name when it maps to exactly one
  const facInst = (fid: string) => before.fac.get(fid)?.institutionId || final.fac.get(fid)?.institutionId;
  const maps = new Map<string, { dep: Map<string, Set<string>>; fac: Map<string, Set<string>>; prog: Map<string, Set<string>> }>();
  const mapFor = (inst: string) => { if (!maps.has(inst)) maps.set(inst, { dep: new Map(), fac: new Map(), prog: new Map() }); return maps.get(inst)!; };
  const add = (m: Map<string, Set<string>>, k: string, v: string) => { const key = norm(k); if (!m.has(key)) m.set(key, new Set()); m.get(key)!.add(v); };
  for (const [pid, b] of before.prog) {
    const to = merges[pid] || pid;
    const f = final.prog.get(to); if (!f) continue;
    const bd = before.dep.get(b.departmentId); const fd = final.dep.get(f.departmentId); if (!bd || !fd) continue;
    const inst = facInst(bd.facultyId); if (!inst || inst === DEFAULT_INSTITUTION_ID || !a.touchedInsts.has(inst)) continue;
    const ff = final.fac.get(fd.facultyId)!; const bf = before.fac.get(bd.facultyId)!;
    const m = mapFor(inst);
    add(m.prog, b.name, f.name);
    add(m.dep, bd.name, `${fd.name}\u0000${ff.name}`);
    add(m.fac, bf.name, ff.name);
  }
  const one = (m: Map<string, Set<string>>, v: string | null) => { if (!v) return null; const s = m.get(norm(v)); return s && s.size === 1 ? [...s][0] : null; };
  const tables: { table: string; cols: string[] }[] = [
    { table: "documents", cols: ["faculty", "department"] },
    { table: "department_memberships", cols: ["faculty", "department"] },
    { table: "class_events", cols: ["faculty", "department"] },
    { table: "feed_posts", cols: ["faculty", "department"] },
    { table: "study_groups", cols: ["faculty", "department", "program"] },
  ];
  const instList = [...maps.keys()];
  if (instList.length) {
    for (const t of tables) {
      const rows: Row[] = await prisma.$queryRawUnsafe(
        `SELECT id, "institutionId", ${t.cols.map((c) => `"${c}"`).join(", ")} FROM "${t.table}" WHERE "institutionId" = ANY($1::text[])`, instList);
      for (const r of rows) {
        const m = maps.get(r.institutionId); if (!m) continue;
        const data: Row = {};
        const dep = one(m.dep, r.department);
        if (dep) { const [dn, fn] = dep.split("\u0000"); if (dn !== r.department) data.department = dn; if (t.cols.includes("faculty") && fn !== r.faculty) data.faculty = fn; }
        else if (r.faculty) { const fn = one(m.fac, r.faculty); if (fn && fn !== r.faculty) data.faculty = fn; }
        if (t.cols.includes("program") && r.program) { const pn = one(m.prog, r.program); if (pn && pn !== r.program) data.program = pn; }
        const keys = Object.keys(data); if (!keys.length) continue;
        try {
          await prisma.$executeRawUnsafe(`UPDATE "${t.table}" SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ")} WHERE id = $1`, r.id, ...keys.map((k) => data[k]));
          out.recordsRenamed++;
        } catch (err: any) {
          a.warnings.push(`${t.table} ${r.id}: could not rename (${String(err?.message || err).slice(0, 80)})`);
        }
      }
    }
  }

  // general-test audiences
  const tests = await prisma.generalTest.findMany({ select: { id: true, audience: true } });
  for (const t of tests) {
    const au = (t.audience || {}) as Row; let dirty = false;
    const remap = (key: string, fn: (id: string) => string[]) => {
      if (!Array.isArray(au[key])) return;
      const next = [...new Set(au[key].flatMap((id: string) => fn(id)))];
      if (next.join() !== au[key].join()) { au[key] = next; dirty = true; }
    };
    remap("programIds", (id) => [merges[id] || id]);
    remap("departmentIds", (id) => [depMoves[id] || id]);
    remap("facultyIds", (id) => (facMoves[id]?.length ? facMoves[id] : [id]));
    if (dirty) { await prisma.generalTest.update({ where: { id: t.id }, data: { audience: au as any } }); out.testsUpdated++; }
  }
  return out;
}
