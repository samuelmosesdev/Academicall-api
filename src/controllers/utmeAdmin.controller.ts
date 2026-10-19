import { randomUUID } from "crypto";
import { Request, Response } from "express";
import sharp from "sharp";
import { z } from "zod";
import { effectiveCaps } from "../lib/access";
import { audit } from "../lib/audit";
import { handle, HttpError } from "../lib/http";
import { prisma } from "../lib/prisma";

const slugSchema = z.string().trim().min(1).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const qidSchema = z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine((value) => !value.includes(".."));

const imageSchema = z.tuple([
  z.string().min(1).max(240).refine((value) =>
    !value.includes("\\") &&
    !value.includes("..") &&
    (/^\/utme\/media\/[0-9a-f-]{36}$/i.test(value) || /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value))
  ),
  z.number().int().min(1).max(10000),
  z.number().int().min(1).max(10000),
]);

const questionSchema = z.object({
  s: z.string().trim().max(12000).default(""),
  si: imageSchema.nullable().optional(),
  o: z.array(z.string().trim().max(4000)).min(2).max(5),
  oi: z.array(imageSchema.nullable()).min(2).max(5).nullable().optional(),
  a: z.number().int().min(0).max(4),
  e: z.string().trim().max(20000).nullable().optional(),
  y: z.number().int().min(1970).max(2100),
  t: z.number().int().min(0).max(1000).optional(),
  tn: z.string().trim().min(1).max(120).optional(),
  img: z.number().int().min(0).max(10).optional(),
  block: z.number().int().min(0).max(10).optional(),
  k: z.number().int().min(0).max(4).optional(),
  p: z.string().trim().min(1).max(120).optional(),
  pt: z.string().trim().min(1).max(20000).optional(),
  ph: z.string().trim().max(500).optional(),
}).strict().superRefine((data, ctx) => {
  if (!data.s && !data.si) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["s"], message: "Question text or image is required" });
  if (data.a >= data.o.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["a"], message: "Answer must refer to an available option" });
  if (data.oi && data.oi.length !== data.o.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oi"], message: "Option pictures must match the number of options" });
  if (data.o.some((option, i) => !option && !data.oi?.[i])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oi"], message: "Every option needs text or an image" });
  }
  if (data.t == null && !data.tn) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tn"], message: "Choose or enter a topic" });
  if (data.pt && data.p) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["p"], message: "Use an existing passage or enter new passage text, not both" });
  if (data.ph && !data.pt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ph"], message: "Passage heading requires passage text" });
});

const noteSchema = z.string().trim().max(500).optional().nullable();
const writeSchema = z.object({ data: questionSchema, note: noteSchema }).strict();

function params(req: Request) {
  return {
    slug: slugSchema.parse(req.params.slug),
    qid: req.params.qid == null ? undefined : qidSchema.parse(req.params.qid),
  };
}

function actor(req: Request) {
  return { id: req.user!.id, name: req.user!.name, email: req.user!.email };
}

/** GET /utme/patches — public changes layered over the shipped bank. */
export const publicPatches = handle(async (req, res) => {
  const slug = req.query.slug == null ? undefined : slugSchema.parse(String(req.query.slug));
  const items = await prisma.utmeQuestionPatch.findMany({
    where: slug ? { slug } : undefined,
    orderBy: { updatedAt: "desc" },
    select: { slug: true, qid: true, status: true, isNew: true, data: true },
  });
  res.json({ items });
});

/** GET /admin/utme/patches?slug= — changes and editor attribution. */
export const listPatches = handle(async (req, res) => {
  const slug = req.query.slug == null ? undefined : slugSchema.parse(String(req.query.slug));
  const items = await prisma.utmeQuestionPatch.findMany({
    where: slug ? { slug } : undefined,
    orderBy: { updatedAt: "desc" },
    include: { updatedBy: { select: { name: true } } },
  });
  res.json({
    items: items.map(({ updatedBy, ...item }) => ({ ...item, by: updatedBy ? { name: updatedBy.name } : null })),
  });
});

/** GET /admin/utme/summary — current patch counts by subject. */
export const summary = handle(async (_req, res) => {
  const patches = await prisma.utmeQuestionPatch.findMany({ select: { slug: true, status: true } });
  const subjects: Record<string, { edited: number; added: number; removed: number }> = {};
  for (const patch of patches) {
    const counts = subjects[patch.slug] || (subjects[patch.slug] = { edited: 0, added: 0, removed: 0 });
    if (patch.status === "edited") counts.edited++;
    else if (patch.status === "added") counts.added++;
    else if (patch.status === "removed") counts.removed++;
  }
  res.json({ subjects });
});

/** GET /admin/utme/team — active staff with the capability and their recent activity. */
export const team = handle(async (_req, res) => {
  const [staff, changes] = await Promise.all([
    prisma.user.findMany({
      where: { status: "active", role: { in: ["admin", "alphaAgent", "agent"] } },
      select: { id: true, name: true, email: true, role: true, staffTags: true, permissions: true },
    }),
    prisma.utmeQuestionPatch.groupBy({
      by: ["updatedById"],
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
  ]);
  const activity = new Map(changes.filter((item) => item.updatedById).map((item) => [item.updatedById!, item]));
  const people = staff
    .filter((user) => effectiveCaps(user).includes("utme.manage"))
    .map((user) => {
      const change = activity.get(user.id);
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        changes: change?._count._all || 0,
        lastChange: change?._max.updatedAt || null,
      };
    })
    .sort((a, b) => b.changes - a.changes || (a.name || "").localeCompare(b.name || ""));
  res.json({ people });
});

/** PUT /admin/utme/questions/:slug/:qid */
export const saveQuestion = handle(async (req, res) => {
  const { slug, qid } = params(req);
  const body = writeSchema.parse(req.body);
  const existing = await prisma.utmeQuestionPatch.findUnique({ where: { slug_qid: { slug, qid: qid! } } });
  const status = existing?.status === "removed" ? "removed" : existing?.isNew ? "added" : "edited";
  const patch = await prisma.utmeQuestionPatch.upsert({
    where: { slug_qid: { slug, qid: qid! } },
    create: { slug, qid: qid!, status, data: body.data, note: body.note || null, updatedById: req.user!.id },
    update: { status, data: body.data, note: body.note || null, updatedById: req.user!.id },
  });
  await audit(actor(req), "utme.question_edited", { id: `${slug}:${qid}`, label: `${slug} ${qid}` }, { status });
  res.json({ item: patch });
});

/** POST /admin/utme/questions/:slug */
export const addQuestion = handle(async (req, res) => {
  const { slug } = params(req);
  const body = writeSchema.parse(req.body);
  const qid = `x-${randomUUID()}`;
  const patch = await prisma.utmeQuestionPatch.create({
    data: { slug, qid, status: "added", isNew: true, data: body.data, note: body.note || null, updatedById: req.user!.id },
  });
  await audit(actor(req), "utme.question_added", { id: `${slug}:${qid}`, label: `${slug} ${qid}` });
  res.status(201).json({ item: patch });
});

/** POST /admin/utme/questions/:slug/bulk */
export const bulkAdd = handle(async (req, res) => {
  const { slug } = params(req);
  const body = z.object({
    items: z.array(z.unknown()).min(1).max(500),
    skipInvalid: z.boolean().default(false),
  }).strict().parse(req.body);
  const valid: z.infer<typeof questionSchema>[] = [];
  const errors: { row: number; error: string }[] = [];
  body.items.forEach((item, i) => {
    const parsed = questionSchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
    else errors.push({ row: i + 1, error: parsed.error.errors[0]?.message || "Invalid question" });
  });
  if (errors.length && !body.skipInvalid) {
    throw new HttpError(400, "Some questions need fixing.", "invalid_questions", { errors });
  }
  if (!valid.length) throw new HttpError(400, "No valid questions to add.", "invalid_questions", { errors });
  await prisma.utmeQuestionPatch.createMany({
    data: valid.map((data) => ({
      slug,
      qid: `x-${randomUUID()}`,
      status: "added",
      isNew: true,
      data,
      updatedById: req.user!.id,
    })),
  });
  await audit(actor(req), "utme.questions_bulk_added", { id: slug, label: slug }, { added: valid.length, skipped: errors.length });
  res.status(201).json({ added: valid.length, errors });
});

/** DELETE /admin/utme/questions/:slug/:qid */
export const removeQuestion = handle(async (req, res) => {
  const { slug, qid } = params(req);
  const body = z.object({ note: noteSchema }).strict().parse(req.body || {});
  const existing = await prisma.utmeQuestionPatch.findUnique({ where: { slug_qid: { slug, qid: qid! } } });
  if (existing?.status === "removed") throw new HttpError(409, "This question is already removed.");
  const patch = await prisma.utmeQuestionPatch.upsert({
    where: { slug_qid: { slug, qid: qid! } },
    create: { slug, qid: qid!, status: "removed", isNew: false, note: body.note || null, updatedById: req.user!.id },
    update: { status: "removed", note: body.note || null, updatedById: req.user!.id },
  });
  await audit(actor(req), "utme.question_removed", { id: `${slug}:${qid}`, label: `${slug} ${qid}` });
  res.json({ item: patch });
});

/** POST /admin/utme/questions/:slug/:qid/restore */
export const restoreQuestion = handle(async (req, res) => {
  const { slug, qid } = params(req);
  const existing = await prisma.utmeQuestionPatch.findUnique({ where: { slug_qid: { slug, qid: qid! } } });
  if (!existing || existing.status !== "removed") throw new HttpError(404, "Removed question not found.");
  if (!existing.data && !existing.isNew) {
    await prisma.utmeQuestionPatch.delete({ where: { id: existing.id } });
  } else {
    await prisma.utmeQuestionPatch.update({
      where: { id: existing.id },
      data: { status: existing.isNew ? "added" : "edited", updatedById: req.user!.id, note: null },
    });
  }
  await audit(actor(req), "utme.question_restored", { id: `${slug}:${qid}`, label: `${slug} ${qid}` });
  res.json({ ok: true });
});

/** POST /admin/utme/questions/:slug/:qid/revert */
export const revertQuestion = handle(async (req, res) => {
  const { slug, qid } = params(req);
  if (qid!.startsWith("x-")) throw new HttpError(400, "Added questions cannot be reverted to the shipped bank.");
  const existing = await prisma.utmeQuestionPatch.findUnique({ where: { slug_qid: { slug, qid: qid! } } });
  if (!existing) throw new HttpError(404, "Question has no changes to revert.");
  await prisma.utmeQuestionPatch.delete({ where: { id: existing.id } });
  await audit(actor(req), "utme.question_reverted", { id: `${slug}:${qid}`, label: `${slug} ${qid}` });
  res.json({ ok: true });
});

/** POST /admin/utme/media — store a bounded, re-encoded WebP in the existing UtmeMedia table. */
export const uploadMedia = handle(async (req, res) => {
  const slug = req.query.slug == null ? null : slugSchema.parse(String(req.query.slug));
  if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > 7 * 1024 * 1024) {
    throw new HttpError(400, "Choose an image no larger than 7 MB.");
  }
  let image: sharp.Sharp;
  try {
    image = sharp(req.body, { limitInputPixels: 20_000_000, animated: false });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp", "gif"].includes(metadata.format || "")) {
      throw new HttpError(400, "Use a JPEG, PNG, WebP or GIF image.");
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "That file isn't a supported image.");
  }
  let data: Buffer;
  let width: number;
  let height: number;
  try {
    const resized = await image
      .rotate()
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    width = resized.info.width;
    height = resized.info.height;
    const watermark = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="wm" width="340" height="180" patternUnits="userSpaceOnUse" patternTransform="rotate(-25)"><text x="12" y="100" fill="white" fill-opacity=".28" font-family="Arial,sans-serif" font-size="26" font-weight="700">ACADEMICALL</text></pattern></defs><rect width="100%" height="100%" fill="url(#wm)"/></svg>`
    );
    data = await sharp(resized.data)
      .composite([{ input: watermark }])
      .webp({ quality: 86 })
      .toBuffer();
  } catch {
    throw new HttpError(400, "That file couldn't be processed as an image.");
  }
  const id = randomUUID();
  await prisma.utmeMedia.create({
    data: { id, slug, mime: "image/webp", width, height, bytes: Uint8Array.from(data), createdById: req.user!.id },
  });
  await audit(actor(req), "utme.media_uploaded", { id, label: slug || "UTME" }, { width, height, bytes: data.length });
  res.status(201).json({ path: `/utme/media/${id}`, width, height });
});

/** GET /utme/media/:id — public image referenced by a bank patch. */
export const media = handle(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const image = await prisma.utmeMedia.findUnique({ where: { id }, select: { mime: true, bytes: true } });
  if (!image) throw new HttpError(404, "Image not found.");
  res.setHeader("Content-Type", image.mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(Buffer.from(image.bytes));
});
