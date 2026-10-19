/**
 * UTME CBT practice history.
 *
 * The question bank ships as static files with the web app (public/utme), so
 * scoring happens in the browser; the API keeps each candidate's finished
 * sessions so their progress follows them across devices.
 */
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError, pageParams } from "../lib/http";

const subjectRow = z.object({
  slug: z.string().max(60),
  name: z.string().max(80),
  total: z.number().int().min(0).max(400),
  correct: z.number().int().min(0).max(400),
  score: z.number().int().min(0).max(100),
});

const attemptBody = z.object({
  mode: z.enum(["topic", "year", "mixed"]),
  style: z.enum(["exam", "practice"]),
  subjects: z.array(subjectRow).min(1).max(4),
  config: z.record(z.any()).default({}),
  answers: z.record(z.number().int().min(-1).max(4)).optional(),
  durationSec: z.number().int().min(0).max(6 * 3600),
  timeLimitSec: z.number().int().min(0).max(6 * 3600).nullable().optional(),
  /** { slug: { topic: [answered, correct] } } */
  topicStats: z.record(z.record(z.tuple([z.number().int().min(0).max(400), z.number().int().min(0).max(400)]))).optional(),
  /** "slug:qid" of questions answered wrongly */
  missed: z.array(z.string().max(80)).max(400).optional(),
});

/** POST /utme/attempts — save a finished session. */
export const saveAttempt = handle(async (req, res) => {
  const body = attemptBody.parse(req.body);
  for (const s of body.subjects) if (s.correct > s.total) throw new HttpError(400, "Scores don't add up");
  if (body.answers && Object.keys(body.answers).length > 400) throw new HttpError(400, "Too many answers");
  const total = body.subjects.reduce((n, s) => n + s.total, 0);
  const correct = body.subjects.reduce((n, s) => n + s.correct, 0);
  const score = body.subjects.reduce((n, s) => n + s.score, 0);
  const row = await prisma.utmeAttempt.create({
    data: {
      userId: req.user!.id,
      mode: body.mode,
      style: body.style,
      subjects: body.subjects,
      config: body.config,
      answers: body.answers,
      total,
      correct,
      score,
      maxScore: body.subjects.length * 100,
      durationSec: body.durationSec,
      timeLimitSec: body.timeLimitSec ?? null,
      topicStats: body.topicStats ?? undefined,
      missed: body.missed ?? [],
    },
  });
  res.status(201).json(publicAttempt(row));
});

/** GET /utme/attempts — my history, newest first, plus a few totals. */
export const listAttempts = handle(async (req, res) => {
  const { take, skip } = pageParams(req.query, { def: 20, max: 50 });
  const where = { userId: req.user!.id };
  const [rows, count, agg] = await Promise.all([
    prisma.utmeAttempt.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
    prisma.utmeAttempt.count({ where }),
    prisma.utmeAttempt.aggregate({ where, _sum: { total: true, correct: true, durationSec: true } }),
  ]);
  res.json({
    items: rows.map(publicAttempt),
    total: count,
    stats: {
      sessions: count,
      questions: agg._sum.total || 0,
      correct: agg._sum.correct || 0,
      minutes: Math.round((agg._sum.durationSec || 0) / 60),
    },
  });
});

/** GET /utme/attempts/:id — one session with its answers, for review. */
export const getAttempt = handle(async (req, res) => {
  const row = await prisma.utmeAttempt.findUnique({ where: { id: String(req.params.id) } });
  if (!row || row.userId !== req.user!.id) throw new HttpError(404, "Session not found");
  res.json({ ...publicAttempt(row), answers: row.answers || {} });
});

/** DELETE /utme/attempts/:id */
export const deleteAttempt = handle(async (req, res) => {
  const row = await prisma.utmeAttempt.findUnique({ where: { id: String(req.params.id) } });
  if (!row || row.userId !== req.user!.id) throw new HttpError(404, "Session not found");
  await prisma.utmeAttempt.delete({ where: { id: row.id } });
  res.json({ ok: true });
});

function publicAttempt(r: any) {
  return {
    id: r.id,
    mode: r.mode,
    style: r.style,
    subjects: r.subjects,
    config: r.config,
    total: r.total,
    correct: r.correct,
    score: r.score,
    maxScore: r.maxScore,
    durationSec: r.durationSec,
    timeLimitSec: r.timeLimitSec,
    createdAt: r.createdAt,
  };
}
