/**
 * Pure, data-driven clean-up of the institution catalogue (no database access).
 *
 * Used twice, with identical results:
 *   - src/lib/institutionOverrides.ts applies it to the live database at boot (keeping every row id)
 *   - scripts/clean-institutions-data.ts applies it to prisma/data/institutions.json.gz for fresh installs
 *
 * Inputs live in prisma/data/institution-overrides/:
 *   discipline-rules.json  JAMB group → neutral discipline grouping, programme → grouping rules, name clean-up words
 *   <abbr>.json            a curated structure for one institution (e.g. unijos.json)
 * The University of Abuja is curated by admins (Setting "academicCatalog") and is never touched here.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const DEFAULT_INSTITUTION_ID = "uofa";
export const OVERRIDES_DIR = path.resolve(__dirname, "../../prisma/data/institution-overrides");
const RULES_FILE = "discipline-rules.json";
/** Bump when the transform code changes in a way the data files don't capture. */
export const TRANSFORM_VERSION = 1;

/** Deterministic ids (same as scripts/build-institutions-data.py). */
export function hid(prefix: string, ...parts: string[]) {
  const raw = parts.map((p) => String(p).trim().toUpperCase()).join("|");
  return `${prefix}_${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20)}`;
}

// ─── types ────────────────────────────────────────────────────────────────────

export interface Rules {
  groupLabels: Record<string, string>;
  programmeRules: { group: string; from: string[]; types?: string[]; onlyIfGroupExists?: boolean; match: string[] }[];
  abbreviations: Record<string, string>;
  acronyms: string[];
  dottedForms: Record<string, string>;
  smallWords: string[];
  institutionAcronyms?: string[];
}
export interface CuratedProgramme { name: string; from?: string[]; award?: string | null; duration?: string | null }
export interface CuratedDepartment { name: string; placeholder?: boolean; programmes: CuratedProgramme[] }
export interface CuratedFaculty { name: string; departments: CuratedDepartment[] }
export interface Curated { file?: string; institutionId: string; displayName?: string; abbreviation?: string; faculties: CuratedFaculty[] }

export interface TProgram { id: string; name: string; active?: boolean; [k: string]: any }
export interface TDepartment { id: string; name: string; derived: boolean; active?: boolean; programs: TProgram[] }
export interface TFaculty { id: string; name: string; kind: string; active?: boolean; departments: TDepartment[] }
export interface TInstitution {
  id: string; name: string; displayName?: string | null; abbreviation?: string | null; type?: string | null;
  source?: string | null; faculties: TFaculty[]; [k: string]: any;
}

export interface Plan {
  institutionId: string;
  curated: boolean;
  displayName: string | null;
  abbreviation: string | null;
  /** The abbreviation before a curated override changed it (JAMB's, used to match national curricula). */
  jambAbbreviation: string | null;
  /** Target state: every active faculty → department → programme after the change. */
  faculties: TFaculty[];
  /** Duplicate programme id → the programme it was merged into. */
  programMerges: Record<string, string>;
  /** Old department id → the department its programmes now live in (for departments that are retired). */
  departmentMoves: Record<string, string>;
  /** Old faculty id → faculties that received its programmes (for faculties that are retired). */
  facultyMoves: Record<string, string[]>;
  deactivateFaculties: string[];
  deactivateDepartments: string[];
  deactivatePrograms: string[];
  /** Programmes a curated file did not mention (left where they were). */
  unplaced: string[];
  warnings: string[];
}

// ─── loading ──────────────────────────────────────────────────────────────────

export function loadRules(dir = OVERRIDES_DIR): Rules {
  return JSON.parse(fs.readFileSync(path.join(dir, RULES_FILE), "utf8"));
}

export function loadCurated(dir = OVERRIDES_DIR): Curated[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== RULES_FILE)
    .sort()
    .map((f) => ({ ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), file: f }));
}

/** Changes whenever a rules/override file or the transform version changes. */
export function overridesVersion(dir = OVERRIDES_DIR) {
  const h = crypto.createHash("sha1").update(`v${TRANSFORM_VERSION}`);
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return `${TRANSFORM_VERSION}:${h.digest("hex").slice(0, 16)}`;
}

// ─── names ────────────────────────────────────────────────────────────────────

/** Comparison key: case, "&"/"and", punctuation and spacing don't matter. */
export function normKey(s: string) {
  return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

const isAllCaps = (s: string) => /[A-Z]/.test(s) && s === s.toUpperCase();

/** Expand abbreviations on whole upper-case tokens (AGRIC handled by context). */
function expandAbbreviations(s: string, rules: Rules) {
  const parts = s.split(/(\s+|\/|-|\(|\)|&|,)/);
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    if (!t || /^(\s+|\/|-|\(|\)|&|,)$/.test(t)) continue;
    const up = t.toUpperCase();
    if (t !== up) continue; // only touch tokens written in capitals
    if (up === "AGRIC" || up === "AGRIC.") {
      // look ahead to the next word
      let j = i + 1;
      const delim = parts[j] || "";
      while (j < parts.length && (!parts[j] || /^(\s+|-)$/.test(parts[j]))) j++;
      const next = (parts[j] || "").toUpperCase();
      const nounFollows = /^(\s+|-)$/.test(delim) && /^[A-Z]{3,}/.test(next) && !["AND", "OR"].includes(next);
      parts[i] = nounFollows ? "AGRICULTURAL" : "AGRICULTURE";
      if (nounFollows && delim === "-") parts[i + 1] = " ";
      continue;
    }
    if (rules.abbreviations[up]) parts[i] = rules.abbreviations[up];
  }
  return parts.join("");
}

function titleCaseWord(w: string, first: boolean, rules: Rules, small: Set<string>, acr: Set<string>) {
  const up = w.toUpperCase();
  if (rules.dottedForms[up]) return rules.dottedForms[up];
  if (acr.has(up) || /^L\d{1,2}$/.test(up) || /^([A-Z]\.)+[A-Z]?\.?$/.test(up)) return up;
  const lw = w.toLowerCase();
  if (!first && small.has(lw)) return lw;
  // Geo-Informatics, Qur'an
  return lw.split("-").map((x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x)).join("-");
}

export function titleCase(s: string, rules: Rules) {
  const small = new Set(rules.smallWords.map((x) => x.toLowerCase()));
  const acr = new Set(rules.acronyms.map((x) => x.toUpperCase()));
  const parts = s.split(/(\s+|\/|\(|\)|,)/);
  let first = true;
  return parts.map((t) => {
    if (!t) return t;
    if (/^\s+$/.test(t) || t === ",") return t;
    if (t === "/" || t === "(" || t === ")") { if (t !== ")") first = true; return t; }
    const out = titleCaseWord(t, first, rules, small, acr);
    first = false;
    return out;
  }).join("");
}

/** "AGRIC-ECONOMICS AND EXTENSION:" → "Agricultural Economics and Extension". Mixed-case names keep their casing. */
export function cleanName(raw: string, rules: Rules) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  s = s.replace(/[\s:;,]+$/g, "").replace(/^[\s:;,]+/g, "");
  s = s.replace(/\s*\/\s*/g, "/").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  if (!s) return String(raw || "").trim();
  if (isAllCaps(s)) return titleCase(expandAbbreviations(s, rules), rules).replace(/\s+/g, " ").trim();
  // mixed case: keep the writer's casing, only lower-case joining words ("Literature In English")
  const small = new Set(rules.smallWords.map((x) => x.toLowerCase()));
  return expandAbbreviations(s, rules)
    .replace(/(\S)( +)([A-Z][a-z]{0,3})(?= )/g, (m, pre, sp, w) => (small.has(w.toLowerCase()) && !/[(/]$/.test(pre) ? `${pre}${sp}${w.toLowerCase()}` : m))
    .replace(/\s+/g, " ").trim();
}

/** Readable label for a faculty group (MEDICAL → Health Sciences). Idempotent on its own output. */
export function groupLabel(name: string, rules: Rules) {
  const key = String(name || "").trim().toUpperCase();
  return rules.groupLabels[key] || cleanName(name, rules);
}

/** Which grouping a programme belongs in, given the grouping JAMB put it in. */
export function classify(programName: string, sourceLabel: string, instType: string | null | undefined, rules: Rules, existingLabels?: Set<string>) {
  for (const r of rules.programmeRules) {
    if (!r.from.includes(sourceLabel)) continue;
    if (r.types && !r.types.includes(String(instType || ""))) continue;
    if (r.onlyIfGroupExists && !existingLabels?.has(r.group)) continue;
    if (r.match.some((m) => new RegExp(m, "i").test(programName))) return r.group;
  }
  return sourceLabel;
}

/**
 * "UNIVERSITY OF JOS, JOS, PLATEAU STATE" → "University of Jos".
 * Keeps the town when the first part is shared by several institutions ("Federal Polytechnic, Bida").
 */
export function cleanInstitutionName(name: string, sharedFirstParts: Set<string>, rules: Rules, full = false) {
  if (!isAllCaps(name)) return null;
  const parts = splitTopLevel(name);
  if (!parts.length) return null;
  let label = parts[0];
  const second = parts[1];
  if (full) label = parts.filter((p, i) => i === 0 || !/\bSTATE\.?$/i.test(p)).join(", ");
  else if (sharedFirstParts.has(label.toUpperCase()) && second && !/\bSTATE$/i.test(second) && second.toUpperCase() !== "FCT") label = `${label}, ${second}`;
  const acr = new Set((rules.institutionAcronyms || []).map((x) => x.toUpperCase()));
  return cleanName(label, rules).split(/(\s+|\/|\(|\)|,|-)/).map((t) => (acr.has(t.toUpperCase()) ? t.toUpperCase() : t)).join("")
    .replace(/,\s*\(/g, " (").replace(/\s*\.\s*\(/g, " (");
}

/** Display names for every institution, falling back to the full name where the short one is ambiguous. */
export function institutionDisplayNames(names: string[], rules: Rules) {
  const shared = sharedFirstParts(names);
  const short = new Map(names.map((n) => [n, cleanInstitutionName(n, shared, rules)]));
  const count = new Map<string, number>();
  for (const v of short.values()) if (v) count.set(v.toUpperCase(), (count.get(v.toUpperCase()) || 0) + 1);
  for (const [n, v] of short) if (v && (count.get(v.toUpperCase()) || 0) > 1) short.set(n, cleanInstitutionName(n, shared, rules, true));
  return short;
}

/** Split on commas that are not inside brackets. */
function splitTopLevel(s: string) {
  const out: string[] = []; let depth = 0; let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export function sharedFirstParts(names: string[]) {
  const n = new Map<string, number>();
  for (const name of names) { const k = (splitTopLevel(name)[0] || "").toUpperCase(); n.set(k, (n.get(k) || 0) + 1); }
  return new Set([...n].filter(([, c]) => c > 1).map(([k]) => k));
}

// ─── the transform ────────────────────────────────────────────────────────────

const active = <T extends { active?: boolean }>(x: T) => x.active !== false;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function emptyPlan(inst: TInstitution): Plan {
  return {
    institutionId: inst.id, curated: false, displayName: inst.displayName ?? null, abbreviation: inst.abbreviation ?? null,
    jambAbbreviation: null, faculties: [], programMerges: {}, departmentMoves: {}, facultyMoves: {},
    deactivateFaculties: [], deactivateDepartments: [], deactivatePrograms: [], unplaced: [], warnings: [],
  };
}

/** Retire whatever an institution no longer uses after `plan.faculties` was built. */
function finishPlan(inst: TInstitution, plan: Plan) {
  const facIds = new Set(plan.faculties.map((f) => f.id));
  const depHome = new Map<string, string>();
  const progHome = new Map<string, { dep: string; fac: string }>();
  for (const f of plan.faculties) for (const d of f.departments) {
    depHome.set(d.id, f.id);
    for (const p of d.programs) progHome.set(p.id, { dep: d.id, fac: f.id });
  }
  for (const f of inst.faculties) {
    if (!active(f)) continue;
    if (!facIds.has(f.id)) {
      plan.deactivateFaculties.push(f.id);
      const to = new Set<string>();
      for (const d of f.departments) for (const p of d.programs) {
        const home = progHome.get(plan.programMerges[p.id] || p.id);
        if (home) to.add(home.fac);
      }
      plan.facultyMoves[f.id] = [...to].sort();
    }
    for (const d of f.departments) {
      if (!active(d) || depHome.has(d.id)) continue;
      plan.deactivateDepartments.push(d.id);
      const homes = new Set(d.programs.map((p) => progHome.get(plan.programMerges[p.id] || p.id)?.dep).filter(Boolean) as string[]);
      if (homes.size === 1) plan.departmentMoves[d.id] = [...homes][0];
    }
  }
  return plan;
}

function transformCurated(inst: TInstitution, c: Curated): Plan {
  const plan = emptyPlan(inst);
  plan.curated = true;
  if (c.displayName) plan.displayName = c.displayName;
  if (c.abbreviation && c.abbreviation !== inst.abbreviation) {
    plan.abbreviation = c.abbreviation;
    plan.jambAbbreviation = inst.abbreviation ?? null;
  } else if (inst.jambAbbreviation) plan.jambAbbreviation = inst.jambAbbreviation;

  const progs = new Map<string, TProgram>();
  for (const f of inst.faculties) for (const d of f.departments) for (const p of d.programs) progs.set(p.id, p);
  const placed = new Set<string>();

  for (const cf of c.faculties) {
    const fid = hid("fac", inst.id, cf.name);
    const fac: TFaculty = { id: fid, name: cf.name, kind: "faculty", active: true, departments: [] };
    for (const cd of cf.departments) {
      const did = hid("dep", fid, cd.name);
      const dep: TDepartment = { id: did, name: cd.name, derived: Boolean(cd.placeholder), active: true, programs: [] };
      for (const cp of cd.programmes) {
        // a missing duplicate (already merged away, e.g. in the cleaned bundled data) is fine; a missing main id is not
        const from = (cp.from || []).filter((id, i) => {
          if (progs.has(id)) return true;
          if (i === 0) plan.warnings.push(`${c.file || inst.id}: programme id ${id} (${cp.name}) is not in the catalogue`);
          return false;
        });
        if (from.length) {
          const keep = progs.get(from[0])!;
          dep.programs.push({ ...keep, name: cp.name, active: true, ...(cp.award !== undefined ? { award: cp.award } : {}), ...(cp.duration !== undefined ? { duration: cp.duration } : {}) });
          placed.add(keep.id);
          for (const dup of from.slice(1)) { plan.programMerges[dup] = keep.id; plan.deactivatePrograms.push(dup); placed.add(dup); }
        } else if (!cp.from?.length) {
          dep.programs.push({ id: hid("prg", did, cp.name), name: cp.name, active: true, status: "approved", award: cp.award ?? "Degree", duration: cp.duration ?? null, isNew: true });
        }
      }
      fac.departments.push(dep);
    }
    plan.faculties.push(fac);
  }

  // Anything the file did not mention stays where it is (admin additions, programmes added to IBASS later).
  const planned = new Map(plan.faculties.map((f) => [f.id, f]));
  const plannedDeps = new Set(plan.faculties.flatMap((f) => f.departments.map((d) => d.id)));
  const leftovers = new Map<string, TFaculty>();
  for (const f of inst.faculties) {
    if (!active(f)) continue;
    for (const d of f.departments) {
      if (!active(d) || plannedDeps.has(d.id)) continue;
      const rest = d.programs.filter((p) => !placed.has(p.id) && !plan.programMerges[p.id]);
      const restActive = rest.filter(active);
      if (!restActive.length && d.derived) continue; // emptied IBASS placeholder → retired
      const home = planned.get(f.id) || leftovers.get(f.id) || { ...f, departments: [] as TDepartment[] };
      if (!planned.has(f.id)) leftovers.set(f.id, home);
      home.departments.push({ ...d, programs: rest });
      plan.unplaced.push(...restActive.map((p) => `${p.name} (${p.id})`));
    }
  }
  plan.faculties.push(...leftovers.values());
  return finishPlan(inst, plan);
}

function transformGeneric(inst: TInstitution, rules: Rules, displayNames: Map<string, string | null>): Plan {
  const plan = emptyPlan(inst);
  if (!inst.displayName) plan.displayName = displayNames.get(inst.name) ?? null;
  if (inst.jambAbbreviation) plan.jambAbbreviation = inst.jambAbbreviation;

  const processable = (f: TFaculty) => f.kind !== "faculty"; // kind "faculty" outside UofA/curated = an admin's own
  type Placement = { dep: TDepartment; label: string; from: TFaculty };
  const placements: Placement[] = [];
  const pinned = new Map<string, TDepartment[]>(); // faculty id → departments an admin created or renamed

  const existingLabels = new Set(inst.faculties.filter((f) => active(f) && processable(f) && f.departments.some((d) => active(d) && d.derived)).map((f) => groupLabel(f.name, rules)));
  for (const f of inst.faculties) {
    if (!active(f)) continue;
    if (!processable(f)) { plan.faculties.push(f); continue; }
    const srcLabel = groupLabel(f.name, rules);
    for (const d of f.departments) {
      if (!active(d)) continue;
      if (!d.derived) { pinned.set(f.id, [...(pinned.get(f.id) || []), d]); continue; }
      const label = f.kind === "ibass_group" ? classify(cleanName(d.name, rules), srcLabel, inst.type, rules, existingLabels) : srcLabel;
      placements.push({ dep: d, label, from: f });
    }
  }

  // The same programme listed under two groupings (IBASS duplicates) ends up in one: the grouping that
  // is a discipline (not "National Diploma programmes"/"Unassigned"), then the larger one. Education is
  // never merged across, since "Statistics Education" style programmes are distinct teacher-training degrees.
  const kindRank = (k: string) => (k === "ibass_group" ? 0 : k === "programme_group" ? 1 : 2);
  const labelSize = new Map<string, number>();
  for (const p of placements) labelSize.set(p.label, (labelSize.get(p.label) || 0) + 1);
  const dupGroups = new Map<string, Placement[]>();
  for (const p of placements) { const k = normKey(cleanName(p.dep.name, rules)); dupGroups.set(k, [...(dupGroups.get(k) || []), p]); }
  for (const group of dupGroups.values()) {
    const labelsHere = [...new Set(group.map((p) => p.label))];
    if (labelsHere.length < 2 || labelsHere.includes("Education")) continue;
    const best = [...group].sort((a, b) => kindRank(a.from.kind) - kindRank(b.from.kind) || (labelSize.get(b.label) || 0) - (labelSize.get(a.label) || 0) || a.label.localeCompare(b.label))[0];
    for (const p of group) p.label = best.label;
  }

  // one target faculty row per label
  const labels = [...new Set(placements.map((p) => p.label))];
  const target = new Map<string, TFaculty>();
  const used = new Set<string>();
  for (const label of labels) {
    const fromKind = placements.find((p) => p.label === label)!.from.kind;
    const cands = inst.faculties.filter((f) => active(f) && processable(f) && !used.has(f.id) && groupLabel(f.name, rules) === label);
    let row: TFaculty | undefined = cands.find((f) => f.name === label);
    if (!row && cands.length) {
      const score = (f: TFaculty) => placements.filter((p) => p.label === label && p.from.id === f.id).length;
      row = [...cands].sort((a, b) => score(b) - score(a) || byId(a, b))[0];
    }
    if (!row) row = inst.faculties.find((f) => !active(f) && processable(f) && !used.has(f.id) && (f.name === label || groupLabel(f.name, rules) === label));
    const id = row?.id || hid("fac", inst.id, label);
    used.add(id);
    target.set(label, { id, name: label, kind: row?.kind && row.kind !== "faculty" ? row.kind : fromKind, active: true, departments: [] });
  }

  // departments: merge duplicates (after clean-up) inside each target faculty
  for (const [label, fac] of target) {
    const groups = new Map<string, TDepartment[]>();
    for (const p of placements.filter((x) => x.label === label)) {
      const k = normKey(cleanName(p.dep.name, rules));
      groups.set(k, [...(groups.get(k) || []), p.dep]);
    }
    for (const deps of groups.values()) {
      const keeper = deps.find((d) => d.name === cleanName(d.name, rules)) || [...deps].sort(byId)[0];
      const programs: TProgram[] = [];
      const byKey = new Map<string, TProgram>();
      const allProgs = deps.flatMap((d) => d.programs).sort((a, b) => {
        const ea = a.name === cleanName(a.name, rules) ? 0 : 1; const eb = b.name === cleanName(b.name, rules) ? 0 : 1;
        return (active(a) ? 0 : 1) - (active(b) ? 0 : 1) || ea - eb || byId(a, b);
      });
      for (const p of allProgs) {
        const name = cleanName(p.name, rules);
        const k = normKey(name);
        const keep = byKey.get(k);
        if (keep && active(p)) { plan.programMerges[p.id] = keep.id; plan.deactivatePrograms.push(p.id); continue; }
        if (keep) continue; // an inactive duplicate: leave it as it is
        const out = { ...p, name };
        byKey.set(k, out);
        programs.push(out);
      }
      // a placeholder department is named after its programme
      const depName = programs[0] && normKey(programs[0].name) === normKey(cleanName(keeper.name, rules)) ? programs[0].name : cleanName(keeper.name, rules);
      fac.departments.push({ ...keeper, name: depName, active: true, programs });
    }
    plan.faculties.push(fac);
  }

  // faculties that only hold an admin's departments keep them, under their own name
  for (const [fid, deps] of pinned) {
    const t = plan.faculties.find((f) => f.id === fid);
    if (t) t.departments.push(...deps);
    else { const f = inst.faculties.find((x) => x.id === fid)!; plan.faculties.push({ ...f, departments: deps }); }
  }
  return finishPlan(inst, plan);
}

export interface TransformContext { rules: Rules; curated: Map<string, Curated>; displayNames: Map<string, string | null> }

export function buildContext(allInstitutionNames: string[], dir = OVERRIDES_DIR): TransformContext {
  const rules = loadRules(dir);
  return { rules, curated: new Map(loadCurated(dir).map((c) => [c.institutionId, c])), displayNames: institutionDisplayNames(allInstitutionNames, rules) };
}

/** Plan for one institution, or null when it is not ours to change (UofA, admin-created). */
export function transformInstitution(inst: TInstitution, ctx: TransformContext): Plan | null {
  if (inst.id === DEFAULT_INSTITUTION_ID || inst.source === "admin") return null;
  const curated = ctx.curated.get(inst.id);
  return curated ? transformCurated(inst, curated) : transformGeneric(inst, ctx.rules, ctx.displayNames);
}
