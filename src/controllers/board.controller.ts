/**
 * Student dashboard board — the big panel at the top of the student dashboard.
 *
 * Only admins and agents with the "board.manage" permission decide what it shows:
 *  - message slides: a title, a line of text and an optional button, over a background
 *  - image slides: a full-bleed design with no text at all
 * Settings pick the default background image, whether slides rotate, and how fast.
 */
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError } from "../lib/http";
import { audit } from "../lib/audit";

const SETTINGS_KEY = "dashboardBoard";
const DEFAULT_SETTINGS = { backgroundUrl: null as string | null, rotate: true, intervalSec: 7, showGreeting: true };

async function readSettings() {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  return { ...DEFAULT_SETTINGS, ...((row?.value as object) || {}) };
}

const audienceFor = (role?: string) => (role === "aspirant" ? "aspirants" : "students");

/** GET /board — what the signed-in person's dashboard board shows right now. */
export const getBoard = handle(async (req, res) => {
  const now = new Date();
  const audience = typeof req.query.audience === "string" && ["students", "aspirants"].includes(req.query.audience) ? req.query.audience : audienceFor(req.user?.role);
  const [settings, slides] = await Promise.all([
    readSettings(),
    prisma.dashboardSlide.findMany({
      where: {
        active: true,
        audience: { in: [audience, "all"] },
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      take: 12,
    }),
  ]);
  res.json({ settings, slides: slides.map(slideOut) });
});

/**
 * Slide style flags ride inside the `theme` column so no migration is needed:
 * "midnight" is a plain slide, "midnight;bold" has a bold headline. Unknown flags are ignored.
 * When DashboardSlide gains a real `style Json?` column, move the flags there and keep this
 * parser for rows written before the switch.
 */
const THEME_NAMES = ["midnight", "violet", "lemon", "aqua"] as const;
type ThemeName = (typeof THEME_NAMES)[number];
function parseTheme(raw?: string | null): { theme: ThemeName; titleBold: boolean } {
  const [name, ...flags] = String(raw || "midnight").split(";");
  const theme = (THEME_NAMES as readonly string[]).includes(name) ? (name as ThemeName) : "midnight";
  return { theme, titleBold: flags.includes("bold") };
}
const packTheme = (theme: ThemeName, titleBold: boolean) => (titleBold ? `${theme};bold` : theme);

const slideOut = (s: any) => ({
  id: s.id, kind: s.kind, title: s.title, body: s.body, imageUrl: s.imageUrl, ctaLabel: s.ctaLabel, ctaUrl: s.ctaUrl, ...parseTheme(s.theme),
  audience: s.audience, active: s.active, sortOrder: s.sortOrder, startsAt: s.startsAt, endsAt: s.endsAt, createdByName: s.createdByName, updatedAt: s.updatedAt,
});

/** GET /admin/board — every slide (any state) + settings. */
export const adminBoard = handle(async (_req, res) => {
  const [settings, slides] = await Promise.all([readSettings(), prisma.dashboardSlide.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }], take: 100 })]);
  res.json({ settings, slides: slides.map(slideOut) });
});

const url = z.string().trim().url("Use a full https link").refine((u) => /^https:\/\//.test(u) || process.env.NODE_ENV !== "production", "Links must be https");
const internalOrUrl = z.string().trim().max(500).refine((u) => u.startsWith("/") || /^https?:\/\//.test(u), "Use a page path like /news or a full link");
const slideSchema = z.object({
  kind: z.enum(["message", "image"]).default("message"),
  title: z.string().trim().max(120).optional().nullable(),
  body: z.string().trim().max(400).optional().nullable(),
  imageUrl: url.optional().nullable(),
  ctaLabel: z.string().trim().max(40).optional().nullable(),
  ctaUrl: internalOrUrl.optional().nullable(),
  theme: z.enum(THEME_NAMES).default("midnight"),
  /** Show the headline in bold. Stored as a flag on `theme` (see parseTheme). */
  titleBold: z.boolean().default(false),
  audience: z.enum(["students", "aspirants", "all"]).default("students"),
  active: z.boolean().default(true),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
});

function check(s: Partial<z.infer<typeof slideSchema>>) {
  if (s.kind === "image" && !s.imageUrl) throw new HttpError(400, "Image slides need an image");
  if (s.kind === "message" && !s.title && !s.body) throw new HttpError(400, "Message slides need a title or a message");
  if (s.startsAt && s.endsAt && s.endsAt <= s.startsAt) throw new HttpError(400, "The end date must be after the start date");
}

/** POST /admin/board/slides */
export const createSlide = handle(async (req, res) => {
  const { titleBold, theme, ...body } = slideSchema.parse(req.body || {});
  check(body);
  const last = await prisma.dashboardSlide.aggregate({ _max: { sortOrder: true } });
  const slide = await prisma.dashboardSlide.create({
    data: { ...body, theme: packTheme(theme, titleBold), ...(body.kind === "image" ? { title: body.title || null, body: null, ctaLabel: null } : {}), sortOrder: (last._max.sortOrder ?? -1) + 1, createdById: req.user!.id, createdByName: req.user!.name || req.user!.email },
  });
  await audit(req.user, "board.slide.create", { id: slide.id, label: slide.title || "Image slide" });
  res.status(201).json({ slide: slideOut(slide) });
});

/** PATCH /admin/board/slides/:id */
export const updateSlide = handle(async (req, res) => {
  const existing = await prisma.dashboardSlide.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw new HttpError(404, "Slide not found");
  const { titleBold, theme, ...body } = slideSchema.partial().parse(req.body || {});
  check({ ...existing, ...body } as any);
  const data: Record<string, unknown> = { ...body };
  if (theme !== undefined || titleBold !== undefined) {
    const current = parseTheme(existing.theme);
    data.theme = packTheme(theme ?? current.theme, titleBold ?? current.titleBold);
  }
  const slide = await prisma.dashboardSlide.update({ where: { id: existing.id }, data });
  res.json({ slide: slideOut(slide) });
});

/** DELETE /admin/board/slides/:id */
export const deleteSlide = handle(async (req, res) => {
  const slide = await prisma.dashboardSlide.delete({ where: { id: String(req.params.id) } });
  await audit(req.user, "board.slide.delete", { id: slide.id, label: slide.title || "Image slide" });
  res.json({ ok: true });
});

/** POST /admin/board/reorder { ids: [] } */
export const reorder = handle(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string()).max(100) }).parse(req.body || {});
  await prisma.$transaction(ids.map((id, i) => prisma.dashboardSlide.update({ where: { id }, data: { sortOrder: i } })));
  res.json({ ok: true });
});

/** PUT /admin/board/settings */
export const saveSettings = handle(async (req, res) => {
  const body = z.object({
    backgroundUrl: url.optional().nullable(),
    rotate: z.boolean().optional(),
    intervalSec: z.coerce.number().int().min(3).max(30).optional(),
    showGreeting: z.boolean().optional(),
  }).parse(req.body || {});
  const value = { ...(await readSettings()), ...body };
  await prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
  await audit(req.user, "board.settings", null, body);
  res.json({ settings: value });
});
