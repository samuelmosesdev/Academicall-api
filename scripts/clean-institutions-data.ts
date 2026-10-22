/**
 * Rewrites prisma/data/institutions.json.gz with the catalogue corrections applied, so fresh
 * installs load clean data. Uses exactly the same transform as the boot-time pass
 * (src/lib/catalogRules.ts), so ids match and the boot pass is a no-op on a fresh install.
 *
 *   npx ts-node --transpile-only scripts/clean-institutions-data.ts [--dry-run]
 *
 * Safe to run repeatedly (the transform is idempotent). Every id is kept; duplicate programmes
 * are dropped from the file (the boot pass merges them in existing databases). A programme whose
 * name changed keeps its original JAMB name in "jamb" (used to match national curricula), and a
 * curated institution whose abbreviation changed keeps JAMB's in "jambAbbreviation".
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { buildContext, transformInstitution, type TInstitution } from "../src/lib/catalogRules";

const FILE = path.resolve(__dirname, "../prisma/data/institutions.json.gz");
const dry = process.argv.includes("--dry-run");

const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString("utf8"));
const ctx = buildContext(payload.institutions.map((i: any) => i.name));

let changedInsts = 0, merged = 0, renamedProgs = 0;
const warnings: string[] = [];
const out = payload.institutions.map((inst: any) => {
  const tree: TInstitution = {
    ...inst,
    faculties: inst.faculties.map((f: any) => ({ ...f, active: true, departments: f.departments.map((d: any) => ({ ...d, active: true, programs: d.programs.map((p: any) => ({ ...p, active: true })) })) })),
  };
  const plan = transformInstitution(tree, ctx);
  if (!plan) return inst;
  warnings.push(...plan.warnings);
  merged += Object.keys(plan.programMerges).length;
  const original = new Map<string, string>();
  for (const f of inst.faculties) for (const d of f.departments) for (const p of d.programs) original.set(p.id, p.jamb || p.name);
  const next: any = {
    ...inst,
    displayName: plan.displayName ?? inst.displayName ?? null,
    abbreviation: plan.abbreviation ?? inst.abbreviation ?? null,
    faculties: plan.faculties.filter((f) => f.departments.length).map((f) => ({
      id: f.id, name: f.name, kind: f.kind,
      departments: f.departments.filter((d) => d.programs.length).map((d) => ({
        id: d.id, name: d.name, derived: d.derived,
        programs: d.programs.filter((p) => p.active !== false).map((p) => {
          const { active, isNew, jamb, ...rest } = p as any;
          const was = original.get(p.id);
          if (was && was !== p.name) renamedProgs++;
          return { ...rest, ...(was && was !== p.name ? { jamb: was } : {}) };
        }),
      })),
    })),
  };
  if (plan.jambAbbreviation && plan.jambAbbreviation !== next.abbreviation) next.jambAbbreviation = plan.jambAbbreviation;
  if (JSON.stringify(next) !== JSON.stringify(inst)) changedInsts++;
  return next;
});

const counts = { institutions: out.length, faculties: 0, departments: 0, programmes: 0 };
for (const i of out) for (const f of i.faculties) { counts.faculties++; for (const d of f.departments) { counts.departments++; counts.programmes += d.programs.length; } }
const result = { ...payload, version: (payload.version || 1) + (changedInsts ? 1 : 0), cleanedAt: new Date().toISOString(), cleanedWith: "scripts/clean-institutions-data.ts", counts, institutions: out };
console.log(JSON.stringify({ changedInstitutions: changedInsts, programmesMerged: merged, programmesRenamed: renamedProgs, counts, warnings: warnings.slice(0, 10) }, null, 2));
if (!dry && changedInsts) {
  fs.writeFileSync(FILE, zlib.gzipSync(Buffer.from(JSON.stringify(result)), { level: 9 }));
  console.log(`wrote ${FILE}`);
} else console.log(dry ? "dry run: nothing written" : "already clean: nothing written");
