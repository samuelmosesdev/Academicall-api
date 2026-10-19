/**
 * UTME coaching and question reports.
 *
 *  - Candidates: progress insights (score trend per subject, weak topics,
 *    today's count against their daily target, days to the exam) and a
 *    "Report this question" button in the exam and review screens.
 *  - Control room: the report queue and the most-missed / most-reported lists.
 */
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handle, HttpError, pageParams } from "../lib/http";
import { audit } from "../lib/audit";
import { notifyMany } from "../lib/notify";

/** Start of today in Lagos (UTC+1, no DST), as a Date. */
function lagosDayStart(d = new Date()) {
  const shifted = new Date(d.getTime() + 3600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 3600_000);
}

/** GET /utme/insights */
export const insights = handle(async (req, res) => {
  const userId = req.user!.id;
  const [attempts, user] = await Promise.all([
    prisma.utmeAttempt.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 300, select: { id: true, subjects: true, topicStats: true, total: true, correct: true, createdAt: true, style: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { utmeExamDate: true, utmeDailyTarget: true } }),
  ]);

  // Score trend per subject (each point is one session's score out of 100 for that subject)
  const trend: Record<string, { slug: string; name: string; points: { at: Date; score: number; total: number }[] }> = {};
  // Topic accuracy, all sessions combined
  const topics: Record<string, Record<string, [number, number]>> = {};
  const names: Record<string, string> = {};
  for (const a of attempts) {
    for (const s of (a.subjects as any[]) || []) {
      names[s.slug] = s.name;
      (trend[s.slug] ||= { slug: s.slug, name: s.name, points: [] }).points.push({ at: a.createdAt, score: s.score, total: s.total });
    }
    for (const [slug, map] of Object.entries((a.topicStats as any) || {})) {
      for (const [topic, pair] of Object.entries(map as Record<string, [number, number]>)) {
        const cur = ((topics[slug] ||= {})[topic] ||= [0, 0]);
        cur[0] += pair[0];
        cur[1] += pair[1];
      }
    }
  }

  const subjects = Object.values(trend).map((t) => {
    const pts = t.points.slice(-12);
    const last = pts.slice(-3), prev = pts.slice(-6, -3);
    const avg = (xs: typeof pts) => (xs.length ? Math.round(xs.reduce((n, p) => n + p.score, 0) / xs.length) : null);
    const topicRows = Object.entries(topics[t.slug] || {}).map(([topic, [answered, correct]]) => ({ topic, answered, correct, accuracy: answered ? Math.round((correct / answered) * 100) : 0 }));
    return {
      slug: t.slug,
      name: t.name,
      sessions: t.points.length,
      latest: pts[pts.length - 1]?.score ?? null,
      recentAverage: avg(last),
      change: avg(last) != null && avg(prev) != null ? (avg(last) as number) - (avg(prev) as number) : null,
      points: pts.map((p) => ({ at: p.at, score: p.score })),
      topics: topicRows.sort((a, b) => b.answered - a.answered),
    };
  });

  // Weakest topics overall: enough answers to judge (≥ 5), lowest accuracy first.
  const weak = subjects
    .flatMap((s) => s.topics.filter((t) => t.answered >= 5).map((t) => ({ slug: s.slug, subject: s.name, ...t })))
    .sort((a, b) => a.accuracy - b.accuracy || b.answered - a.answered)
    .slice(0, 8);

  const todayStart = lagosDayStart();
  const today = attempts.filter((a) => a.createdAt >= todayStart).reduce((n, a) => n + a.total, 0);
  let streak = 0;
  for (let d = 0; d < 365; d++) {
    const start = new Date(todayStart.getTime() - d * 86_400_000);
    const end = new Date(start.getTime() + 86_400_000);
    if (attempts.some((a) => a.createdAt >= start && a.createdAt < end)) streak++;
    else if (d > 0) break;
  }
  const exam = user?.utmeExamDate || null;
  const daysToExam = exam ? Math.ceil((Date.parse(`${exam}T08:00:00+01:00`) - Date.now()) / 86_400_000) : null;

  res.json({
    goals: { examDate: exam, dailyTarget: user?.utmeDailyTarget ?? null, daysToExam },
    today: { answered: today, target: user?.utmeDailyTarget ?? null },
    streak,
    sessions: attempts.length,
    subjects,
    weak,
    hasTopicData: Object.keys(topics).length > 0,
  });
});

// ── Question reports ────────────────────────────────────────────────────────
export const REPORT_REASONS = ["wrong_answer", "typo", "missing_image", "unclear", "wrong_topic", "other"] as const;
export const REPORT_LABELS: Record<string, string> = {
  wrong_answer: "Wrong answer", typo: "Typo or wrong spelling", missing_image: "Picture or diagram missing", unclear: "Question is unclear", wrong_topic: "Wrong topic or year", other: "Something else",
};

/** POST /utme/reports { slug, qid, reason, note } */
export const reportQuestion = handle(async (req, res) => {
  const b = z.object({
    slug: z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/),
    qid: z.string().trim().min(1).max(60),
    reason: z.enum(REPORT_REASONS),
    note: z.string().trim().max(600).optional().nullable(),
  }).parse(req.body);
  const recent = await prisma.utmeQuestionReport.count({ where: { userId: req.user!.id, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
  if (recent >= 30) throw new HttpError(429, "Thanks — you've sent plenty of reports this hour. We're on them.");
  const dup = await prisma.utmeQuestionReport.findFirst({ where: { userId: req.user!.id, slug: b.slug, qid: b.qid, status: "open" } });
  if (dup) return res.json({ ok: true, duplicate: true });
  await prisma.utmeQuestionReport.create({ data: { ...b, note: b.note || null, userId: req.user!.id, userName: req.user!.name || null } });
  res.status(201).json({ ok: true });
});

/** GET /admin/utme/reports?status=open&slug= — grouped by question. */
export const listReports = handle(async (req, res) => {
  const status = ["open", "fixed", "dismissed"].includes(String(req.query.status)) ? String(req.query.status) : "open";
  const where: any = { status };
  if (req.query.slug) where.slug = String(req.query.slug);
  const { take, skip, page, pageSize } = pageParams(req.query, { def: 30, max: 100 });
  const groups = await prisma.utmeQuestionReport.groupBy({
    by: ["slug", "qid"], where, _count: { _all: true }, _max: { createdAt: true },
    orderBy: [{ _count: { qid: "desc" } }, { _max: { createdAt: "desc" } }], take, skip,
  });
  const totalGroups = (await prisma.utmeQuestionReport.groupBy({ by: ["slug", "qid"], where })).length;
  const rows = groups.length
    ? await prisma.utmeQuestionReport.findMany({ where: { ...where, OR: groups.map((g) => ({ slug: g.slug, qid: g.qid })) }, orderBy: { createdAt: "desc" } })
    : [];
  res.json({
    page, pageSize, total: totalGroups,
    items: groups.map((g) => {
      const mine = rows.filter((r) => r.slug === g.slug && r.qid === g.qid);
      const reasons: Record<string, number> = {};
      mine.forEach((r) => (reasons[r.reason] = (reasons[r.reason] || 0) + 1));
      return {
        slug: g.slug, qid: g.qid, count: g._count._all, lastAt: g._max.createdAt,
        reasons: Object.entries(reasons).map(([k, n]) => ({ reason: k, label: REPORT_LABELS[k] || k, count: n })).sort((a, b) => b.count - a.count),
        notes: mine.filter((r) => r.note).slice(0, 5).map((r) => ({ note: r.note, by: r.userName, at: r.createdAt })),
        resolution: mine[0]?.resolution || null, resolvedByName: mine[0]?.resolvedByName || null, resolvedAt: mine[0]?.resolvedAt || null,
      };
    }),
  });
});

/** POST /admin/utme/reports/resolve { slug, qid, status: fixed|dismissed, resolution } — closes every open report on that question. */
export const resolveReports = handle(async (req, res) => {
  const b = z.object({ slug: z.string(), qid: z.string(), status: z.enum(["fixed", "dismissed"]), resolution: z.string().trim().max(400).optional().nullable() }).parse(req.body);
  const open = await prisma.utmeQuestionReport.findMany({ where: { slug: b.slug, qid: b.qid, status: "open" }, select: { id: true, userId: true } });
  if (!open.length) throw new HttpError(409, "There are no open reports on this question.");
  await prisma.utmeQuestionReport.updateMany({
    where: { id: { in: open.map((o) => o.id) } },
    data: { status: b.status, resolution: b.resolution || null, resolvedById: req.user!.id, resolvedByName: req.user!.name || req.user!.email, resolvedAt: new Date() },
  });
  if (b.status === "fixed") {
    await notifyMany(open.map((o) => o.userId).filter(Boolean) as string[], {
      type: "general", title: "We fixed a question you reported", body: b.resolution || "Thanks for flagging it. The corrected question is live in UTME CBT.", data: { link: "/dashboard/utme" }, createdById: req.user!.id,
    });
  }
  await audit(req.user, `utme.report_${b.status}`, { id: `${b.slug}:${b.qid}`, label: `${b.slug} ${b.qid}` }, { reports: open.length, resolution: b.resolution || null });
  res.json({ ok: true, closed: open.length });
});

/** GET /admin/utme/stats?days=90 — most-missed and most-reported questions, and subject activity. */
export const stats = handle(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);
  const since = new Date(Date.now() - days * 86_400_000);
  const slug = req.query.slug ? String(req.query.slug) : null;
  const attempts = await prisma.utmeAttempt.findMany({ where: { createdAt: { gt: since } }, select: { missed: true, answers: true, subjects: true }, orderBy: { createdAt: "desc" }, take: 8000 });
  const missed = new Map<string, number>();
  const seen = new Map<string, number>();
  const subjects = new Map<string, { slug: string; name: string; sessions: number; answered: number; correct: number }>();
  for (const a of attempts) {
    for (const k of a.missed || []) if (!slug || k.startsWith(`${slug}:`)) missed.set(k, (missed.get(k) || 0) + 1);
    for (const k of Object.keys((a.answers as any) || {})) if (!slug || k.startsWith(`${slug}:`)) seen.set(k, (seen.get(k) || 0) + 1);
    for (const s of (a.subjects as any[]) || []) {
      const cur = subjects.get(s.slug) || { slug: s.slug, name: s.name, sessions: 0, answered: 0, correct: 0 };
      cur.sessions++; cur.answered += s.total; cur.correct += s.correct;
      subjects.set(s.slug, cur);
    }
  }
  const mostMissed = [...missed.entries()]
    .map(([k, n]) => { const i = k.indexOf(":"); const s = seen.get(k) || n; return { slug: k.slice(0, i), qid: k.slice(i + 1), missed: n, answered: s, missRate: Math.round((n / Math.max(s, n)) * 100) }; })
    .filter((r) => r.answered >= 3)
    .sort((a, b) => b.missRate - a.missRate || b.missed - a.missed)
    .slice(0, 30);
  const reported = await prisma.utmeQuestionReport.groupBy({ by: ["slug"], where: { createdAt: { gt: since } }, _count: { _all: true } });
  res.json({
    days,
    sessions: attempts.length,
    mostMissed,
    subjects: [...subjects.values()].map((s) => ({ ...s, accuracy: s.answered ? Math.round((s.correct / s.answered) * 100) : 0 })).sort((a, b) => b.sessions - a.sessions),
    reportsBySubject: reported.map((r) => ({ slug: r.slug, count: r._count._all })).sort((a, b) => b.count - a.count),
    openReports: await prisma.utmeQuestionReport.count({ where: { status: "open" } }),
  });
});
