/**
 * Account-backed history for course-bank practice sessions.
 */
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError } from "../lib/http";

export const PRACTICE_LIMITS = { attempts: 40, seenPerCourse: 3000, importAttempts: 40, importCourses: 200 };

const code = z.string().trim().min(1).max(40);
const qid = z.string().min(1).max(80);

const attemptBody = z.object({
  clientId: z.string().min(6).max(64).optional(),
  courseCode: code.nullable().optional(),
  courseTitle: z.string().trim().max(200).nullable().optional(),
  mode: z.string().trim().max(30).nullable().optional(),
  quiz: z.boolean().optional(),
  correct: z.number().int().min(0).max(1000),
  total: z.number().int().min(0).max(1000),
  pct: z.number().int().min(0).max(100),
  durationSec: z.number().int().min(0).max(12 * 3600).nullable().optional(),
  at: z.string().datetime().optional(),
});

const publicAttempt = (attempt: {
  id: string;
  clientId: string | null;
  courseCode: string | null;
  courseTitle: string | null;
  mode: string | null;
  quiz: boolean;
  correct: number;
  total: number;
  pct: number;
  durationSec: number | null;
  createdAt: Date;
}) => ({
  id: attempt.id,
  clientId: attempt.clientId,
  courseCode: attempt.courseCode,
  courseTitle: attempt.courseTitle,
  mode: attempt.mode,
  quiz: attempt.quiz,
  correct: attempt.correct,
  total: attempt.total,
  pct: attempt.pct,
  durationSec: attempt.durationSec,
  at: attempt.createdAt,
});

async function history(userId: string) {
  const [attempts, seenRows] = await Promise.all([
    prisma.practiceAttempt.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: PRACTICE_LIMITS.attempts }),
    prisma.practiceSeen.findMany({ where: { userId }, select: { courseCode: true, questionIds: true } }),
  ]);
  return {
    attempts: attempts.map(publicAttempt),
    seen: Object.fromEntries(seenRows.map((row) => [row.courseCode, row.questionIds])),
  };
}

async function addSeen(userId: string, courseCode: string, ids: string[]) {
  if (!ids.length) return;
  await prisma.$transaction(async (tx) => {
    const row = await tx.practiceSeen.findUnique({ where: { userId_courseCode: { userId, courseCode } } });
    const merged = Array.from(new Set([...(row?.questionIds || []), ...ids])).slice(-PRACTICE_LIMITS.seenPerCourse);
    await tx.practiceSeen.upsert({
      where: { userId_courseCode: { userId, courseCode } },
      create: { userId, courseCode, questionIds: merged },
      update: { questionIds: merged },
    });
  });
}

function importedDate(at?: string) {
  if (!at) return undefined;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) || date.getTime() > Date.now() ? new Date() : date;
}

export const getHistory = handle(async (req, res) => {
  res.json(await history(req.user!.id));
});

export const saveAttempt = handle(async (req, res) => {
  const body = attemptBody.extend({ questionIds: z.array(qid).max(500).optional() }).parse(req.body);
  if (body.correct > body.total) throw new HttpError(400, "Scores don't add up");
  const userId = req.user!.id;
  const data = {
    userId,
    clientId: body.clientId ?? null,
    courseCode: body.courseCode ?? null,
    courseTitle: body.courseTitle ?? null,
    mode: body.mode ?? null,
    quiz: !!body.quiz,
    correct: body.correct,
    total: body.total,
    pct: body.pct,
    durationSec: body.durationSec ?? null,
  };
  if (body.clientId) {
    await prisma.practiceAttempt.upsert({
      where: { userId_clientId: { userId, clientId: body.clientId } },
      create: data,
      update: {},
    });
  } else {
    await prisma.practiceAttempt.create({ data });
  }
  if (body.courseCode && body.questionIds?.length) await addSeen(userId, body.courseCode, body.questionIds);
  res.status(201).json(await history(userId));
});

export const importHistory = handle(async (req, res) => {
  const body = z.object({
    attempts: z.array(attemptBody).max(PRACTICE_LIMITS.importAttempts).default([]),
    seen: z.record(z.array(qid).max(PRACTICE_LIMITS.seenPerCourse)).default({}),
  }).parse(req.body);
  const userId = req.user!.id;
  if (Object.keys(body.seen).length > PRACTICE_LIMITS.importCourses) throw new HttpError(400, "Too many courses");

  for (const attempt of body.attempts) {
    if (attempt.correct > attempt.total) continue;
    const data = {
      userId,
      clientId: attempt.clientId ?? null,
      courseCode: attempt.courseCode ?? null,
      courseTitle: attempt.courseTitle ?? null,
      mode: attempt.mode ?? null,
      quiz: !!attempt.quiz,
      correct: attempt.correct,
      total: attempt.total,
      pct: attempt.pct,
      durationSec: attempt.durationSec ?? null,
      createdAt: importedDate(attempt.at),
    };
    if (attempt.clientId) {
      await prisma.practiceAttempt.upsert({
        where: { userId_clientId: { userId, clientId: attempt.clientId } },
        create: data,
        update: {},
      });
    } else {
      await prisma.practiceAttempt.create({ data });
    }
  }
  for (const [courseCode, ids] of Object.entries(body.seen)) {
    const parsedCode = code.safeParse(courseCode);
    if (parsedCode.success) await addSeen(userId, parsedCode.data, ids);
  }
  res.json(await history(userId));
});
