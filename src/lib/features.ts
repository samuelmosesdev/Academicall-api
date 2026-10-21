/**
 * Feature switches.
 *
 * An admin can discontinue any feature listed here. A discontinued feature
 * disappears from the web app (menus, pages, dashboard links) and its API
 * answers 403 `feature_off` to everyone except staff, who keep access so they
 * can still manage the content behind it.
 *
 * A feature can also be "limited": on only for an audience (students or
 * aspirants, chosen institutions, beta testers) while everyone else sees it off.
 *
 * The same row carries maintenance mode (everyone but staff sees a "back soon"
 * screen and the API answers 503 maintenance) and a site-wide banner.
 *
 * Stored as one Setting row: key "features" →
 *   { off: { [key]: Entry }, limited: { [key]: Entry & { audience } }, maintenance, banner }
 */
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./prisma";
import { rank } from "./access";
import { STUDENT_ROLES } from "./audience";

export const FEATURES = [
  // students
  { key: "courses", label: "Courses", group: "Students", hint: "My courses page and course suggestions", api: ["/courses", "/me/courses", "/catalog/courses"] },
  { key: "programme", label: "Programme page", group: "Students", hint: "Department page, live programme updates and department feed", api: ["/department", "/feed"] },
  { key: "groups", label: "Study groups", group: "Students", hint: "Study groups, invites and group chat", api: ["/groups"] },
  { key: "materials", label: "Materials", group: "Students", hint: "Course material folders and the reading room", api: ["/material-saves", "/my-materials"] },
  { key: "materialUploads", label: "Material uploads", group: "Students", hint: "Students upload their own files and organise them in folders", api: [] },
  // Enforced in materialShares.controller (not by path): when it's Pro, only sending is paid; receiving stays free.
  { key: "materialSharing", label: "Material sharing", group: "Students", hint: "Send a file or folder from My materials to someone by their Unique ID", api: [] },
  { key: "readingHub", label: "Reading Hub", group: "Students", hint: "Reading Hub documents and reader", api: ["/documents"] },
  { key: "reference", label: "Reference", group: "Students", hint: "Reference page", api: [] },
  { key: "timetable", label: "Timetable", group: "Students", hint: "Class timetable and scheduled classes", api: ["/timetable", "/class-events"] },
  { key: "courseRep", label: "Course Rep panel", group: "Students", hint: "Course Rep tools for scheduling and updates", api: [] },
  { key: "practice", label: "Practice / CBT", group: "Students", hint: "Course quizzes and AI practice questions", api: ["/quizzes"] },
  // aspirants
  { key: "utme", label: "UTME CBT", group: "Aspirants", hint: "UTME past-question practice, timed CBT and history", api: ["/utme"] },
  { key: "aspirantHouse", label: "Aspirant Houses", group: "Aspirants", hint: "Aspirant Houses, house threads and the House desk", api: ["/houses"] },
  { key: "choices", label: "Institution choices", group: "Aspirants", hint: "The My choices page for aspirants", api: ["/aspirant/me"] },
  // everyone
  { key: "news", label: "News", group: "Everyone", hint: "Academicall News, the News desk and subscriptions", api: ["/news"] },
  { key: "vault", label: "Vault", group: "Everyone", hint: "PIN-locked personal Vault", api: ["/vault"] },
  { key: "upgrade", label: "Pro upgrade", group: "Everyone", hint: "Pro upgrade page and Pro prompts", api: ["/subscriptions"] },
  { key: "results", label: "CGPA & results", group: "Students", hint: "CGPA calculator and semester results", api: ["/me/results"] },
  { key: "downloads", label: "Offline downloads", group: "Everyone", hint: "Download materials and UTME packs to use without data", api: [] },
  { key: "tests", label: "General tests", group: "Everyone", hint: "Tests set by staff for chosen students or aspirants", api: ["/tests"] },
  { key: "search", label: "Search", group: "Everyone", hint: "The search box across courses, materials, groups, news and past questions", api: ["/search"] },
  { key: "secretariat", label: "Secretariat", group: "Staff tools", hint: "Secretariat records for people with the Secretary duty", api: ["/secretariat"] },
] as const;

export type FeatureKey = (typeof FEATURES)[number]["key"];
export const FEATURE_KEYS = FEATURES.map((f) => f.key) as string[];
export const SETTINGS_KEY = "features";

type Entry = { at: string; by?: string | null; byName?: string | null; note?: string | null };
/** Who still sees a limited feature. Empty lists mean "no restriction on this axis". */
export type FeatureAudience = { roles?: ("student" | "aspirant")[]; institutionIds?: string[]; beta?: boolean };
export type Maintenance = { on: boolean; message?: string | null; until?: string | null } & Partial<Entry>;
export type Banner = {
  on: boolean;
  text?: string | null;
  tone?: "info" | "warning" | "success";
  linkLabel?: string | null;
  linkUrl?: string | null;
  audience?: "all" | "students" | "aspirants";
  until?: string | null;
} & Partial<Entry>;
export type FeatureState = {
  off: Record<string, Entry>;
  limited: Record<string, Entry & { audience: FeatureAudience }>;
  maintenance: Maintenance;
  banner: Banner;
};

let cache: { at: number; state: FeatureState } | null = null;
const TTL = 10_000;

export async function getFeatureState(fresh = false): Promise<FeatureState> {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.state;
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  const raw = (row?.value as any) || {};
  const off: FeatureState["off"] = {};
  const limited: FeatureState["limited"] = {};
  for (const [k, v] of Object.entries(raw.off || {})) if (FEATURE_KEYS.includes(k)) off[k] = v as Entry;
  for (const [k, v] of Object.entries(raw.limited || {})) if (FEATURE_KEYS.includes(k) && !off[k]) limited[k] = v as any;
  const state: FeatureState = {
    off,
    limited,
    maintenance: { on: false, ...(raw.maintenance || {}) },
    banner: { on: false, ...(raw.banner || {}) },
  };
  // A maintenance window or banner with an end time switches itself off.
  const now = Date.now();
  if (state.maintenance.on && state.maintenance.until && Date.parse(state.maintenance.until) < now) state.maintenance = { ...state.maintenance, on: false };
  if (state.banner.on && state.banner.until && Date.parse(state.banner.until) < now) state.banner = { ...state.banner, on: false };
  cache = { at: Date.now(), state };
  return state;
}

export async function saveFeatureState(state: FeatureState) {
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: state as any }, update: { value: state as any } });
  cache = { at: Date.now(), state };
}

export const offList = (s: FeatureState) => Object.keys(s.off);

/** Longest API prefix wins, so "/news" doesn't swallow an unrelated "/newsletter". */
export function featureForPath(path: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const f of FEATURES) {
    for (const p of f.api) {
      if ((path === p || path.startsWith(p + "/") || path.startsWith(p + "?")) && (!best || p.length > best.len)) best = { key: f.key, len: p.length };
    }
  }
  return best?.key || null;
}

export type Viewer = { id: string; role: string; institutionId: string | null; betaTester: boolean; staff: boolean } | null;
const viewerCache = new Map<string, { at: number; v: Viewer }>();

/** Who is calling, from the bearer token if there is one (cached briefly). */
export async function viewerFrom(req: Request): Promise<Viewer> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  let sub: string;
  try {
    sub = (jwt.verify(header.slice(7), process.env.JWT_SECRET || "dev-secret") as { sub: string }).sub;
  } catch {
    return null;
  }
  const hit = viewerCache.get(sub);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const u = await prisma.user.findUnique({ where: { id: sub }, select: { id: true, role: true, status: true, institutionId: true, betaTester: true } });
  const v: Viewer = u && u.status === "active" ? { id: u.id, role: u.role, institutionId: u.institutionId, betaTester: u.betaTester, staff: rank(u.role) >= 2 } : null;
  viewerCache.set(sub, { at: Date.now(), v });
  if (viewerCache.size > 20_000) viewerCache.clear();
  return v;
}

/** Is this viewer inside a limited feature's audience? */
export function inAudience(v: Viewer, a: FeatureAudience) {
  if (!v) return false;
  if (v.staff) return true;
  if (a.beta && !v.betaTester) return false;
  if (a.roles?.length) {
    const kind = v.role === "aspirant" ? "aspirant" : (STUDENT_ROLES as readonly string[]).includes(v.role) ? "student" : null;
    if (!kind || !a.roles.includes(kind)) return false;
  }
  if (a.institutionIds?.length && (!v.institutionId || !a.institutionIds.includes(v.institutionId))) return false;
  return true;
}

/** Feature keys that are off for this viewer (switched off, or limited to an audience they're not in). */
export function offFor(state: FeatureState, v: Viewer) {
  const out = new Set(Object.keys(state.off));
  for (const [k, entry] of Object.entries(state.limited)) if (!inAudience(v, entry.audience || {})) out.add(k);
  return [...out];
}

export function bannerFor(state: FeatureState, v: Viewer) {
  const b = state.banner;
  if (!b?.on || !b.text) return null;
  if (b.audience === "aspirants" && v?.role !== "aspirant" && !v?.staff) return null;
  if (b.audience === "students" && v?.role === "aspirant") return null;
  return { text: b.text, tone: b.tone || "info", linkLabel: b.linkLabel || null, linkUrl: b.linkUrl || null, until: b.until || null, at: b.at || null };
}

/** Mounted once on the API router: blocks the API of a switched-off (or limited) feature. */
export async function featureGate(req: Request, res: Response, next: NextFunction) {
  try {
    const key = featureForPath(req.path);
    if (!key) return next();
    const state = await getFeatureState();
    if (!state.off[key] && !state.limited[key]) return next();
    const v = await viewerFrom(req);
    if (v?.staff) return next();
    if (!state.off[key] && state.limited[key] && inAudience(v, state.limited[key].audience || {})) return next();
    return res.status(403).json({ error: "This feature isn't available right now.", code: "feature_off", feature: key });
  } catch {
    return next();
  }
}

/** Calls that keep working during maintenance so staff can sign in and the app can show the notice. */
const MAINTENANCE_ALLOW = [/^\/health$/, /^\/features$/, /^\/auth\/(login|google|me|2fa\/.*)$/, /^\/users\/me$/, /^\/payments\/webhook\//, /^\/og\//, /^\/admin\/backups\/report$/];

/** Maintenance mode: everyone but staff gets 503 while it's on. */
export async function maintenanceGate(req: Request, res: Response, next: NextFunction) {
  try {
    const state = await getFeatureState();
    if (!state.maintenance.on) return next();
    if (MAINTENANCE_ALLOW.some((rx) => rx.test(req.path))) return next();
    const v = await viewerFrom(req);
    if (v?.staff) return next();
    res.set("Retry-After", "300");
    return res.status(503).json({ error: state.maintenance.message || "Academicall is being updated. Back soon.", code: "maintenance", until: state.maintenance.until || null });
  } catch {
    return next();
  }
}
