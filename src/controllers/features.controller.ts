/**
 * Feature switches: the public view of what's on for the caller, and the admin
 * switchboard (on / limited to an audience / off), maintenance mode, the
 * site-wide banner and the beta-tester list.
 */
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError } from "../lib/http";
import { audit } from "../lib/audit";
import { FEATURES, FEATURE_KEYS, bannerFor, getFeatureState, offFor, saveFeatureState, viewerFrom } from "../lib/features";

const who = (req: any) => ({ at: new Date().toISOString(), by: req.user!.id, byName: req.user!.name || req.user!.email });

/** GET /features — public: which features are off for the caller, maintenance and the banner. */
export const publicFeatures = handle(async (req, res) => {
  const state = await getFeatureState();
  const v = await viewerFrom(req);
  res.set("Cache-Control", "no-cache");
  res.json({
    off: offFor(state, v),
    maintenance: state.maintenance.on ? { on: true, message: state.maintenance.message || null, until: state.maintenance.until || null } : { on: false },
    banner: bannerFor(state, v),
  });
});

/** GET /admin/features — the switchboard. */
export const adminFeatures = handle(async (_req, res) => {
  const state = await getFeatureState(true);
  const [betaCount, institutions] = await Promise.all([
    prisma.user.count({ where: { betaTester: true, status: "active" } }),
    (async () => {
      const ids = [...new Set(Object.values(state.limited).flatMap((l) => l.audience?.institutionIds || []))];
      return ids.length ? prisma.institution.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, displayName: true, abbreviation: true } }) : [];
    })(),
  ]);
  res.json({
    features: FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      group: f.group,
      hint: f.hint,
      mode: state.off[f.key] ? "off" : state.limited[f.key] ? "limited" : "on",
      enabled: !state.off[f.key],
      off: state.off[f.key] || null,
      limited: state.limited[f.key] || null,
    })),
    maintenance: state.maintenance,
    banner: state.banner,
    betaCount,
    institutions,
  });
});

const audience = z.object({
  roles: z.array(z.enum(["student", "aspirant"])).max(2).default([]),
  institutionIds: z.array(z.string()).max(100).default([]),
  beta: z.boolean().default(false),
});
const body = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["on", "off", "limited"]).optional(),
  audience: audience.optional(),
  note: z.string().trim().max(300).optional().nullable(),
});

/** PUT /admin/features/:key — on, off, or limited to an audience. */
export const setFeature = handle(async (req, res) => {
  const key = String(req.params.key);
  if (!FEATURE_KEYS.includes(key)) throw new HttpError(404, "Unknown feature");
  const b = body.parse(req.body);
  const mode = b.mode || (b.enabled === false ? "off" : "on");
  const state = await getFeatureState(true);
  const off = { ...state.off };
  const limited = { ...state.limited };
  delete off[key];
  delete limited[key];
  if (mode === "off") off[key] = { ...who(req), note: b.note || null };
  if (mode === "limited") {
    const a = audience.parse(b.audience || {});
    if (!a.roles.length && !a.institutionIds.length && !a.beta) throw new HttpError(400, "Pick who should still see it: students, aspirants, institutions or beta testers.");
    limited[key] = { ...who(req), note: b.note || null, audience: a };
  }
  await saveFeatureState({ ...state, off, limited });
  const f = FEATURES.find((x) => x.key === key)!;
  await audit(req.user as any, mode === "off" ? "feature.off" : mode === "limited" ? "feature.limited" : "feature.on", { id: key, label: f.label }, {
    ...(b.note ? { note: b.note } : {}),
    ...(mode === "limited" ? { audience: limited[key].audience } : {}),
  });
  res.json({ key, mode, enabled: mode !== "off", off: off[key] || null, limited: limited[key] || null });
});

const maintenanceBody = z.object({
  on: z.boolean(),
  message: z.string().trim().max(300).optional().nullable(),
  until: z.string().datetime().optional().nullable(),
});

/** PUT /admin/maintenance */
export const setMaintenance = handle(async (req, res) => {
  const b = maintenanceBody.parse(req.body);
  const state = await getFeatureState(true);
  const maintenance = { ...b, ...who(req) };
  await saveFeatureState({ ...state, maintenance });
  await audit(req.user as any, b.on ? "maintenance.on" : "maintenance.off", null, b.message ? { message: b.message, until: b.until || null } : undefined);
  res.json({ maintenance });
});

const bannerBody = z.object({
  on: z.boolean(),
  text: z.string().trim().max(240).optional().nullable(),
  tone: z.enum(["info", "warning", "success"]).default("info"),
  linkLabel: z.string().trim().max(40).optional().nullable(),
  linkUrl: z.string().trim().max(300).optional().nullable(),
  audience: z.enum(["all", "students", "aspirants"]).default("all"),
  until: z.string().datetime().optional().nullable(),
});

/** PUT /admin/banner */
export const setBanner = handle(async (req, res) => {
  const b = bannerBody.parse(req.body);
  if (b.on && !b.text) throw new HttpError(400, "Write the banner text first.");
  if (b.linkUrl && !/^(\/|https:\/\/)/.test(b.linkUrl)) throw new HttpError(400, "Links must start with / or https://");
  const state = await getFeatureState(true);
  const banner = { ...b, ...who(req) };
  await saveFeatureState({ ...state, banner });
  await audit(req.user as any, b.on ? "banner.on" : "banner.off", null, b.text ? { text: b.text } : undefined);
  res.json({ banner });
});

/** GET /admin/beta-testers?q= */
export const listBetaTesters = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const select = { id: true, name: true, email: true, role: true, uniqueId: true, betaTester: true } as const;
  const [testers, matches] = await Promise.all([
    prisma.user.findMany({ where: { betaTester: true }, select, orderBy: { name: "asc" }, take: 300 }),
    q.length >= 2
      ? prisma.user.findMany({
          where: { status: "active", OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { uniqueId: { contains: q.toUpperCase() } }] },
          select, take: 12,
        })
      : Promise.resolve([]),
  ]);
  res.json({ testers, matches });
});

/** PUT /admin/beta-testers/:id { betaTester } */
export const setBetaTester = handle(async (req, res) => {
  const { betaTester } = z.object({ betaTester: z.boolean() }).parse(req.body);
  const u = await prisma.user.update({ where: { id: String(req.params.id) }, data: { betaTester }, select: { id: true, name: true, email: true, betaTester: true } });
  await audit(req.user as any, betaTester ? "beta.add" : "beta.remove", { id: u.id, label: u.name || u.email });
  res.json({ user: u });
});
