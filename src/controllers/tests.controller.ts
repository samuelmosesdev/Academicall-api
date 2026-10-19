/**
 * General tests.
 *
 * Staff with "tests.manage" set a timed test — one subject, several, a mix of
 * UTME bank questions and their own — and aim it at chosen students or
 * aspirants (institution, faculty, department, programme, level, house,
 * institution of choice, UTME year, plan, or hand-picked people).
 *
 * The question set is frozen when staff save it, answers included. Candidates
 * get the questions without answers; the server times the attempt and marks it,
 * so nobody can read the key from the page.
 */
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError } from "../lib/http";
import { audit } from "../lib/audit";
import { notifyMany } from "../lib/notify";
import { audienceCount, audienceSchema, audienceSummary, audienceWhere, inTestAudience } from "../lib/audience";
import { isStaffRole } from "../lib/access";

// ── Shapes ──────────────────────────────────────────────────────────────────
const pic = z.tuple([z.string().max(600), z.number(), z.number()]);
const question = z.object({
  key: z.string().min(1).max(80),
  section: z.string().min(1).max(40),
  /** Where it came from in the UTME bank (absent for questions written for this test) */
  slug: z.string().max(60).optional().nullable(),
  qid: z.string().max(60).optional().nullable(),
  s: z.string().max(6000).default(""),
  si: pic.optional().nullable(),
  o: z.array(z.string().max(2000)).min(2).max(5),
  oi: z.array(pic.nullable()).max(5).optional().nullable(),
  a: z.number().int().min(0).max(4),
  e: z.string().max(4000).optional().nullable(),
  y: z.union([z.number(), z.string()]).optional().nullable(),
  topic: z.string().max(200).optional().nullable(),
  passage: z.object({ h: z.string().max(400).optional().nullable(), b: z.array(z.string().max(6000)).max(40) }).optional().nullable(),
  block: z.number().optional().nullable(),
  img: z.number().optional().nullable(),
}).refine((q) => q.a < q.o.length, { message: "The correct answer must be one of the options" });

const section = z.object({ key: z.string().min(1).max(40), name: z.string().trim().min(1).max(80), subject: z.string().max(60).optional().nullable() });

const testBody = z.object({
  title: z.string().trim().min(3).max(140),
  instructions: z.string().trim().max(3000).optional().nullable(),
  sections: z.array(section).min(1).max(8),
  questions: z.array(question).max(400),
  durationMin: z.number().int().min(1).max(360),
  opensAt: z.string().datetime().optional().nullable(),
  closesAt: z.string().datetime().optional().nullable(),
  audience: audienceSchema,
  showResults: z.enum(["instant", "after_close", "hidden"]).default("instant"),
  shuffle: z.boolean().default(true),
  maxAttempts: z.number().int().min(1).max(10).default(1),
});

type Q = z.infer<typeof question>;

function checkTest(b: z.infer<typeof testBody>) {
  const keys = new Set<string>();
  const sectionKeys = new Set(b.sections.map((s) => s.key));
  for (const q of b.questions) {
    if (keys.has(q.key)) throw new HttpError(400, "Two questions share the same key. Rebuild the question list.");
    keys.add(q.key);
    if (!sectionKeys.has(q.section)) throw new HttpError(400, `A question belongs to a section that doesn't exist (${q.section}).`);
  }
  if (b.opensAt && b.closesAt && Date.parse(b.closesAt) <= Date.parse(b.opensAt)) throw new HttpError(400, "The test must close after it opens.");
}

const nowIso = () => new Date();
const isOpen = (t: { status: string; opensAt: Date | null; closesAt: Date | null }, at = new Date()) =>
  t.status === "published" && (!t.opensAt || t.opensAt <= at) && (!t.closesAt || t.closesAt > at);

/** Question as a candidate sees it: no answer, no explanation. */
const forCandidate = (q: Q) => {
  const { a: _a, e: _e, slug: _s, qid: _q, ...rest } = q;
  return rest;
};

function shuffleArr<T>(xs: T[]) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mark(test: { questions: any; sections: any }, answers: Record<string, number>) {
  const qs = test.questions as Q[];
  const sections = (test.sections as z.infer<typeof section>[]).map((s) => ({ key: s.key, name: s.name, total: 0, correct: 0 }));
  const bySection = new Map(sections.map((s) => [s.key, s]));
  let correct = 0;
  for (const q of qs) {
    const s = bySection.get(q.section);
    if (s) s.total++;
    if (answers[q.key] === q.a) {
      correct++;
      if (s) s.correct++;
    }
  }
  return { total: qs.length, correct, score: qs.length ? Math.round((correct / qs.length) * 100) : 0, sectionScores: sections };
}

const resultsVisible = (t: { showResults: string; closesAt: Date | null; status: string }) =>
  t.showResults === "instant" || (t.showResults === "after_close" && (t.status === "closed" || (!!t.closesAt && t.closesAt <= new Date())));

// ── Staff ───────────────────────────────────────────────────────────────────

/** GET /admin/tests?status= */
export const adminList = handle(async (req, res) => {
  const status = String(req.query.status || "");
  const where: any = status && ["draft", "published", "closed", "archived"].includes(status) ? { status } : { status: { not: "archived" } };
  const rows = await prisma.generalTest.findMany({
    where, orderBy: { updatedAt: "desc" }, take: 200,
    select: { id: true, title: true, status: true, questionCount: true, durationMin: true, opensAt: true, closesAt: true, audience: true, audienceCount: true, showResults: true, createdByName: true, publishedAt: true, updatedAt: true, sections: true },
  });
  const counts = await prisma.generalTestAttempt.groupBy({ by: ["testId", "status"], where: { testId: { in: rows.map((r) => r.id) } }, _count: { _all: true }, _avg: { score: true } });
  res.json({
    items: rows.map((r) => {
      const c = counts.filter((x) => x.testId === r.id);
      const sub = c.find((x) => x.status === "submitted");
      return {
        ...r,
        audienceLabel: audienceSummary(audienceSchema.parse(r.audience || {})),
        open: isOpen(r),
        submitted: sub?._count._all || 0,
        inProgress: c.find((x) => x.status === "in_progress")?._count._all || 0,
        averageScore: sub?._avg.score != null ? Math.round(sub._avg.score) : null,
      };
    }),
  });
});

/** GET /admin/tests/:id — full test including answers. */
export const adminGet = handle(async (req, res) => {
  const t = await prisma.generalTest.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw new HttpError(404, "Test not found");
  res.json({ test: { ...t, audienceLabel: audienceSummary(audienceSchema.parse(t.audience || {})) } });
});

/** POST /admin/tests/audience-preview { audience } */
export const audiencePreview = handle(async (req, res) => {
  const a = audienceSchema.parse(req.body?.audience || {});
  const [count, sample] = await Promise.all([
    audienceCount(a),
    prisma.user.findMany({ where: audienceWhere(a), select: { id: true, name: true, role: true, level: true }, take: 5, orderBy: { lastActiveAt: { sort: "desc", nulls: "last" } } }),
  ]);
  res.json({ count, label: audienceSummary(a), sample });
});

/** POST /admin/tests */
export const create = handle(async (req, res) => {
  const b = testBody.parse(req.body);
  checkTest(b);
  const t = await prisma.generalTest.create({
    data: {
      title: b.title, instructions: b.instructions || null, sections: b.sections, questions: b.questions as any, questionCount: b.questions.length,
      durationMin: b.durationMin, opensAt: b.opensAt ? new Date(b.opensAt) : null, closesAt: b.closesAt ? new Date(b.closesAt) : null,
      audience: b.audience, audienceCount: await audienceCount(b.audience), showResults: b.showResults, shuffle: b.shuffle, maxAttempts: b.maxAttempts,
      createdById: req.user!.id, createdByName: req.user!.name || req.user!.email,
    },
  });
  await audit(req.user, "test.create", { id: t.id, label: t.title }, { questions: b.questions.length });
  res.status(201).json({ test: t });
});

/** PUT /admin/tests/:id — drafts change freely; a published test can't change its questions once someone has started. */
export const update = handle(async (req, res) => {
  const t = await prisma.generalTest.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw new HttpError(404, "Test not found");
  const b = testBody.parse(req.body);
  checkTest(b);
  const started = await prisma.generalTestAttempt.count({ where: { testId: t.id } });
  const sameQuestions = JSON.stringify(t.questions) === JSON.stringify(b.questions);
  if (started && !sameQuestions) throw new HttpError(409, `${started} ${started === 1 ? "person has" : "people have"} started this test, so its questions are locked. You can still change the times, audience and settings.`);
  const updated = await prisma.generalTest.update({
    where: { id: t.id },
    data: {
      title: b.title, instructions: b.instructions || null, sections: b.sections, questions: b.questions as any, questionCount: b.questions.length,
      durationMin: b.durationMin, opensAt: b.opensAt ? new Date(b.opensAt) : null, closesAt: b.closesAt ? new Date(b.closesAt) : null,
      audience: b.audience, audienceCount: await audienceCount(b.audience), showResults: b.showResults, shuffle: b.shuffle, maxAttempts: b.maxAttempts,
    },
  });
  await audit(req.user, "test.update", { id: t.id, label: b.title });
  res.json({ test: updated });
});

/** POST /admin/tests/:id/publish — goes live for its audience and tells them. */
export const publish = handle(async (req, res) => {
  const t = await prisma.generalTest.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw new HttpError(404, "Test not found");
  if (t.questionCount < 1) throw new HttpError(400, "Add at least one question first.");
  if (t.closesAt && t.closesAt <= new Date()) throw new HttpError(400, "The closing time has already passed. Move it later first.");
  const a = audienceSchema.parse(t.audience || {});
  const people = await prisma.user.findMany({ where: audienceWhere(a), select: { id: true } });
  if (!people.length) throw new HttpError(400, "Nobody matches this audience yet. Widen it before publishing.");
  const updated = await prisma.generalTest.update({ where: { id: t.id }, data: { status: "published", publishedAt: t.publishedAt || new Date(), audienceCount: people.length } });
  const when = t.opensAt && t.opensAt > new Date()
    ? `Opens ${t.opensAt.toLocaleString("en-GB", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
    : "Open now";
  if (req.body?.notify !== false) {
    await notifyMany(people.map((p) => p.id), {
      type: "test", title: `New test: ${t.title}`,
      body: `${t.questionCount} questions · ${t.durationMin} min · ${when}${t.closesAt ? ` · closes ${t.closesAt.toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}`,
      data: { link: `/dashboard/tests?open=${t.id}`, testId: t.id }, createdById: req.user!.id,
    });
  }
  await audit(req.user, "test.publish", { id: t.id, label: t.title }, { audience: people.length });
  res.json({ test: updated, notified: req.body?.notify !== false ? people.length : 0 });
});

/** POST /admin/tests/:id/close */
export const close = handle(async (req, res) => {
  const t = await prisma.generalTest.update({ where: { id: String(req.params.id) }, data: { status: "closed", closesAt: new Date() } });
  // Submit anything still running so nobody loses their answers.
  const running = await prisma.generalTestAttempt.findMany({ where: { testId: t.id, status: "in_progress" } });
  for (const at of running) await finishAttempt(t, at);
  await audit(req.user, "test.close", { id: t.id, label: t.title }, { autoSubmitted: running.length });
  res.json({ test: t, autoSubmitted: running.length });
});

/** POST /admin/tests/:id/reopen { closesAt } */
export const reopen = handle(async (req, res) => {
  const closesAt = req.body?.closesAt ? new Date(String(req.body.closesAt)) : null;
  if (closesAt && closesAt <= new Date()) throw new HttpError(400, "Pick a closing time in the future.");
  const t = await prisma.generalTest.update({ where: { id: String(req.params.id) }, data: { status: "published", closesAt } });
  await audit(req.user, "test.reopen", { id: t.id, label: t.title });
  res.json({ test: t });
});

/** POST /admin/tests/:id/duplicate */
export const duplicate = handle(async (req, res) => {
  const t = await prisma.generalTest.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw new HttpError(404, "Test not found");
  const copy = await prisma.generalTest.create({
    data: {
      title: `${t.title} (copy)`.slice(0, 140), instructions: t.instructions, sections: t.sections as any, questions: t.questions as any, questionCount: t.questionCount,
      durationMin: t.durationMin, audience: t.audience as any, audienceCount: t.audienceCount, showResults: t.showResults, shuffle: t.shuffle, maxAttempts: t.maxAttempts,
      createdById: req.user!.id, createdByName: req.user!.name || req.user!.email,
    },
  });
  res.status(201).json({ test: copy });
});

/** DELETE /admin/tests/:id — drafts with no attempts are deleted; anything else is archived. */
export const remove = handle(async (req, res) => {
  const t = await prisma.generalTest.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw new HttpError(404, "Test not found");
  const attempts = await prisma.generalTestAttempt.count({ where: { testId: t.id } });
  if (t.status === "draft" && !attempts) {
    await prisma.generalTest.delete({ where: { id: t.id } });
    await audit(req.user, "test.delete", { id: t.id, label: t.title });
    return res.json({ ok: true, deleted: true });
  }
  await prisma.generalTest.update({ where: { id: t.id }, data: { status: "archived" } });
  await audit(req.user, "test.archive", { id: t.id, label: t.title });
  res.json({ ok: true, archived: true });
});

/** GET /admin/tests/:id/results — every candidate, best attempt first; ?format=csv to download. */
export const results = handle(async (req, res) => {
  const t = await prisma.generalTest.findUnique({ where: { id: String(req.params.id) } });
  if (!t) throw new HttpError(404, "Test not found");
  const rows = await prisma.generalTestAttempt.findMany({
    where: { testId: t.id },
    include: { user: { select: { id: true, name: true, email: true, uniqueId: true, role: true, level: true, department: true, institution: { select: { abbreviation: true, name: true } } } } },
    orderBy: [{ score: { sort: "desc", nulls: "last" } }, { submittedAt: "asc" }],
  });
  // Question analysis: how many got each question right.
  const qs = t.questions as Q[];
  const right = new Map<string, number>();
  const submitted = rows.filter((r) => r.status === "submitted");
  for (const r of submitted) for (const q of qs) if (((r.answers as any) || {})[q.key] === q.a) right.set(q.key, (right.get(q.key) || 0) + 1);
  const items = rows.map((r, i) => ({
    id: r.id, rank: r.status === "submitted" ? i + 1 : null, status: r.status, attemptNo: r.attemptNo, score: r.score, correct: r.correct, total: r.total,
    sectionScores: r.sectionScores, startedAt: r.startedAt, submittedAt: r.submittedAt,
    durationSec: r.submittedAt ? Math.round((r.submittedAt.getTime() - r.startedAt.getTime()) / 1000) : null,
    user: { ...r.user, institution: r.user.institution?.abbreviation || r.user.institution?.name || null },
  }));
  if (String(req.query.format) === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const sections = (t.sections as any[]).map((s) => s.name);
    const head = ["Rank", "Name", "Unique ID", "Email", "Role", "Institution", "Department", "Level", "Status", "Score %", "Correct", "Total", ...sections, "Started", "Submitted", "Minutes"];
    const lines = items.map((r) => [
      r.rank, r.user.name, r.user.uniqueId, r.user.email, r.user.role === "aspirant" ? "Aspirant" : "Student", r.user.institution, r.user.department, r.user.level, r.status,
      r.score, r.correct, r.total, ...sections.map((name) => { const s = ((r.sectionScores as any[]) || []).find((x) => x.name === name); return s ? `${s.correct}/${s.total}` : ""; }),
      r.startedAt.toISOString(), r.submittedAt?.toISOString() || "", r.durationSec != null ? Math.round(r.durationSec / 60) : "",
    ].map(esc).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${t.title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "test"}-results.csv"`);
    return res.send([head.map(esc).join(","), ...lines].join("\n"));
  }
  const scores = submitted.map((r) => r.score || 0);
  res.json({
    test: { id: t.id, title: t.title, questionCount: t.questionCount, sections: t.sections, status: t.status, audienceCount: t.audienceCount },
    summary: {
      submitted: submitted.length,
      inProgress: rows.length - submitted.length,
      notStarted: Math.max(0, t.audienceCount - new Set(rows.map((r) => r.userId)).size),
      average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      highest: scores.length ? Math.max(...scores) : null,
      lowest: scores.length ? Math.min(...scores) : null,
    },
    items,
    questions: qs.map((q, i) => ({ n: i + 1, key: q.key, section: q.section, stem: q.s.slice(0, 160), right: right.get(q.key) || 0, of: submitted.length })),
  });
});

// ── Candidates ──────────────────────────────────────────────────────────────
async function myTest(req: any) {
  const t = await prisma.generalTest.findUnique({ where: { id: String(req.params.id) } });
  if (!t || !["published", "closed"].includes(t.status)) throw new HttpError(404, "Test not found");
  if (!isStaffRole(req.user!.role) && !(await inTestAudience(req.user!.id, audienceSchema.parse(t.audience || {})))) throw new HttpError(404, "Test not found");
  return t;
}

async function finishAttempt(t: any, at: any, answers?: Record<string, number>) {
  const final = answers ?? ((at.answers as any) || {});
  const m = mark(t, final);
  return prisma.generalTestAttempt.update({
    where: { id: at.id },
    data: { status: "submitted", submittedAt: new Date(Math.min(Date.now(), at.deadlineAt.getTime())), answers: final, total: m.total, correct: m.correct, score: m.score, sectionScores: m.sectionScores },
  });
}

/** Attempts past their deadline are submitted with whatever was saved. */
async function settleExpired(userId: string) {
  const late = await prisma.generalTestAttempt.findMany({ where: { userId, status: "in_progress", deadlineAt: { lt: new Date() } }, include: { test: true } });
  for (const at of late) await finishAttempt(at.test, at);
}

/** GET /tests — tests set for me. */
export const myTests = handle(async (req, res) => {
  await settleExpired(req.user!.id);
  const tests = await prisma.generalTest.findMany({
    where: { status: { in: ["published", "closed"] } },
    orderBy: [{ opensAt: { sort: "desc", nulls: "last" } }, { publishedAt: "desc" }],
    take: 200,
    select: { id: true, title: true, instructions: true, sections: true, questionCount: true, durationMin: true, opensAt: true, closesAt: true, showResults: true, maxAttempts: true, status: true, audience: true, createdByName: true, publishedAt: true },
  });
  const mine: typeof tests = [];
  for (const t of tests) if (await inTestAudience(req.user!.id, audienceSchema.parse(t.audience || {}))) mine.push(t);
  const attempts = await prisma.generalTestAttempt.findMany({ where: { userId: req.user!.id, testId: { in: mine.map((t) => t.id) } }, orderBy: { attemptNo: "desc" } });
  const now = new Date();
  res.json({
    items: mine.map((t) => {
      const ats = attempts.filter((a) => a.testId === t.id);
      const running = ats.find((a) => a.status === "in_progress");
      const done = ats.filter((a) => a.status === "submitted");
      const best = done.reduce<typeof done[number] | null>((b, a) => (!b || (a.score || 0) > (b.score || 0) ? a : b), null);
      const open = isOpen(t, now);
      const { audience: _a, ...rest } = t;
      return {
        ...rest,
        state: running ? "in_progress" : open ? (done.length >= t.maxAttempts ? "done" : "open") : t.opensAt && t.opensAt > now && t.status === "published" ? "upcoming" : "closed",
        attemptsUsed: ats.length,
        running: running ? { id: running.id, deadlineAt: running.deadlineAt } : null,
        best: best ? { score: resultsVisible(t) ? best.score : null, submittedAt: best.submittedAt, attemptId: best.id } : null,
        resultsVisible: resultsVisible(t),
      };
    }),
  });
});

/** POST /tests/:id/start — begin (or resume) an attempt; returns questions without answers. */
export const start = handle(async (req, res) => {
  const t = await myTest(req);
  await settleExpired(req.user!.id);
  let at = await prisma.generalTestAttempt.findFirst({ where: { testId: t.id, userId: req.user!.id, status: "in_progress" } });
  if (!at) {
    if (!isOpen(t)) throw new HttpError(403, t.opensAt && t.opensAt > new Date() ? "This test hasn't opened yet." : "This test has closed.");
    const used = await prisma.generalTestAttempt.count({ where: { testId: t.id, userId: req.user!.id } });
    if (used >= t.maxAttempts) throw new HttpError(403, t.maxAttempts === 1 ? "You've already taken this test." : `You've used all ${t.maxAttempts} attempts.`);
    const qs = t.questions as Q[];
    // Shuffle within each section, keep sections in order (and passages together).
    let order: string[] = [];
    for (const s of t.sections as any[]) {
      const inSec = qs.filter((q) => q.section === s.key);
      if (!t.shuffle) { order.push(...inSec.map((q) => q.key)); continue; }
      const groups = new Map<string, Q[]>();
      for (const q of inSec) {
        const g = q.passage ? `p:${JSON.stringify(q.passage.b).slice(0, 80)}` : `q:${q.key}`;
        groups.set(g, [...(groups.get(g) || []), q]);
      }
      order.push(...shuffleArr([...groups.values()]).flat().map((q) => q.key));
    }
    const deadline = new Date(Math.min(Date.now() + t.durationMin * 60_000, t.closesAt ? t.closesAt.getTime() : Infinity));
    at = await prisma.generalTestAttempt.create({ data: { testId: t.id, userId: req.user!.id, attemptNo: used + 1, order, deadlineAt: deadline, total: qs.length, answers: {} } });
  }
  const byKey = new Map((t.questions as Q[]).map((q) => [q.key, q]));
  res.json({
    attempt: { id: at.id, attemptNo: at.attemptNo, startedAt: at.startedAt, deadlineAt: at.deadlineAt, answers: at.answers || {}, serverNow: nowIso() },
    test: { id: t.id, title: t.title, instructions: t.instructions, sections: t.sections, durationMin: t.durationMin, questionCount: t.questionCount },
    questions: (at.order as string[]).map((k) => byKey.get(k)).filter(Boolean).map((q) => forCandidate(q as Q)),
  });
});

/** PUT /tests/:id/answers { answers } — autosave while the clock runs. */
export const saveAnswers = handle(async (req, res) => {
  const answers = z.record(z.number().int().min(-1).max(4)).parse(req.body?.answers || {});
  const at = await prisma.generalTestAttempt.findFirst({ where: { testId: String(req.params.id), userId: req.user!.id, status: "in_progress" } });
  if (!at) throw new HttpError(409, "This attempt has ended.");
  if (at.deadlineAt < new Date(Date.now() - 15_000)) throw new HttpError(409, "Time is up.", "time_up");
  await prisma.generalTestAttempt.update({ where: { id: at.id }, data: { answers } });
  res.json({ ok: true, savedAt: new Date() });
});

/** POST /tests/:id/submit { answers } */
export const submit = handle(async (req, res) => {
  const t = await myTest(req);
  const answers = z.record(z.number().int().min(-1).max(4)).parse(req.body?.answers || {});
  const at = await prisma.generalTestAttempt.findFirst({ where: { testId: t.id, userId: req.user!.id, status: "in_progress" } });
  if (!at) throw new HttpError(409, "This attempt has already been submitted.");
  // Answers sent after the deadline (plus a short grace for slow networks) don't count; the last autosave does.
  const late = at.deadlineAt.getTime() + 30_000 < Date.now();
  const done = await finishAttempt(t, at, late ? ((at.answers as any) || {}) : answers);
  res.json({ attemptId: done.id, late, ...(await resultPayload(t, done)) });
});

async function resultPayload(t: any, at: any) {
  if (!resultsVisible(t)) {
    return { visible: false, message: t.showResults === "hidden" ? "Your answers are in. Staff will share results." : "Your answers are in. Results show when the test closes." };
  }
  const qs = t.questions as Q[];
  const answers = (at.answers as any) || {};
  const byKey = new Map(qs.map((q) => [q.key, q]));
  return {
    visible: true,
    score: at.score, correct: at.correct, total: at.total, sectionScores: at.sectionScores,
    review: ((at.order as string[]) || qs.map((q) => q.key)).map((k) => byKey.get(k)).filter(Boolean).map((q: any) => ({ ...q, chosen: answers[q.key] ?? null })),
  };
}

/** GET /tests/:id/result — my latest submitted attempt. */
export const myResult = handle(async (req, res) => {
  const t = await myTest(req);
  await settleExpired(req.user!.id);
  const at = await prisma.generalTestAttempt.findFirst({ where: { testId: t.id, userId: req.user!.id, status: "submitted" }, orderBy: { attemptNo: "desc" } });
  if (!at) throw new HttpError(404, "You haven't finished this test yet.");
  res.json({ attemptId: at.id, title: t.title, submittedAt: at.submittedAt, ...(await resultPayload(t, at)) });
});

/** GET /admin/tests/options — houses for the audience picker. */
export const options = handle(async (_req, res) => {
  const houses = await prisma.aspirantHouse.findMany({
    where: { archived: false }, orderBy: { memberCount: "desc" }, take: 500,
    select: { id: true, name: true, memberCount: true, institution: { select: { id: true, name: true, displayName: true, abbreviation: true } } },
  });
  res.json({ houses, levels: ["100", "200", "300", "400", "500", "600", "700"] });
});

/** GET /admin/tests/people?q= — pick named students or aspirants. */
export const people = handle(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const ids = String(req.query.ids || "").split(",").filter(Boolean).slice(0, 200);
  const select = { id: true, name: true, email: true, uniqueId: true, role: true, level: true } as const;
  if (ids.length) return res.json({ items: await prisma.user.findMany({ where: { id: { in: ids } }, select }) });
  if (q.length < 2) return res.json({ items: [] });
  const items = await prisma.user.findMany({
    where: { status: "active", role: { in: ["user", "courseRep", "aspirant"] }, OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { uniqueId: { contains: q.toUpperCase() } }] },
    select, take: 12,
  });
  res.json({ items });
});
