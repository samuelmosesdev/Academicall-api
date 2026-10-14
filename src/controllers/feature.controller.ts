import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { broadcastProgramme, canSeeScoped } from "./programme.controller";
import { institutionOf, isStaffRole, loadScopedUser, programmeScope } from "../lib/scope";

const questionSchema = z.object({
  courseId: z.string().optional().nullable(),
  documentId: z.string().optional().nullable(),
  materialId: z.string().optional().nullable(),
  courseCode: z.string().optional().nullable(),
  courseTitle: z.string().optional().nullable(),
  topic: z.string().optional().nullable(),
  faculty: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  level: z.string().optional().nullable(),
  questionText: z.string().min(1),
  options: z.array(z.string()).min(2),
  correctIndex: z.number().int().min(0),
  explanation: z.string().optional().nullable(),
  difficulty: z.string().optional(),
  source: z.string().optional().nullable(),
  marks: z.number().int().min(0).optional(),
  referenceCode: z.string().optional().nullable(),
  hintEnabled: z.boolean().optional(),
  generatedByUserId: z.string().optional().nullable(),
});

export async function listQuestions(req: Request, res: Response) {
  try {
    const materialId = req.query.materialId ? String(req.query.materialId) : undefined;
    const documentId = req.query.documentId ? String(req.query.documentId) : undefined;

    const where: any = {};
    if (materialId) {
      where.OR = [{ materialId }, { documentId: materialId }];
    } else if (documentId) {
      where.documentId = documentId;
    }

    const questions = await prisma.cbtQuestion.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 5000,
    });
    res.json({ questions });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to list questions" });
  }
}

export async function createQuestion(req: Request, res: Response) {
  try {
    const payload = questionSchema.parse(req.body);
    const question = await prisma.cbtQuestion.create({
      data: {
        ...payload,
        materialId: payload.materialId || payload.documentId || null,
        documentId: payload.documentId || payload.materialId || null,
        correctIndex: Number(payload.correctIndex) || 0,
        marks: payload.marks ?? 1,
        hintEnabled: payload.hintEnabled ?? true,
        source: payload.source || "admin",
      },
    });
    res.status(201).json({ question });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    console.error(err);
    res.status(500).json({ error: "Create failed" });
  }
}

export async function createQuestionFromMaterial(req: Request, res: Response) {
  try {
    const { courseCode, courseTitle, faculty, department, level, topic, questionText, options, correctIndex, explanation, difficulty, materialId, documentId, source } = req.body;

    if (!questionText || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ error: "questionText and options required" });
    }

    const mids = materialId || documentId;
    if (!mids) {
      return res.status(400).json({ error: "materialId required" });
    }

    const question = await prisma.cbtQuestion.create({
      data: {
        courseCode: courseCode || null,
        courseTitle: courseTitle || null,
        faculty: faculty || null,
        department: department || null,
        level: level || null,
        topic: topic || null,
        questionText,
        options,
        correctIndex: Number(correctIndex) || 0,
        explanation: explanation || null,
        difficulty: difficulty || "medium",
        materialId: mids,
        documentId: mids,
        source: source || "ai_material",
        generatedByUserId: req.user?.id || null,
      },
    });

    return res.status(201).json({ question });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to create question" });
  }
}

export async function updateQuestion(req: Request, res: Response) {
  try { const question = await prisma.cbtQuestion.update({ where: { id: String(req.params.id) }, data: questionSchema.partial().parse(req.body) }); res.json({ question }); }
  catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Update failed" }); }
}
export async function deleteQuestion(req: Request, res: Response) { await prisma.cbtQuestion.delete({ where: { id: String(req.params.id) } }); res.status(204).send(); }

const eventSchema = z.object({ title: z.string().min(1), description: z.string().optional().nullable(), startAt: z.coerce.date().optional().nullable(), endAt: z.coerce.date().optional().nullable(), location: z.string().optional().nullable(), courseId: z.string().optional().nullable(), courseCode: z.string().optional().nullable(), dayOfWeek: z.number().int().min(0).max(6).optional(), startTime: z.string().optional(), endTime: z.string().optional(), reminderMinutes: z.number().int().min(0).optional(), reminderEnabled: z.boolean().optional(), notes: z.string().optional().nullable() });
export async function listEvents(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); const events = await prisma.timetableEvent.findMany({ where: { userId: req.user.id }, orderBy: { startAt: "asc" } }); res.json({ events }); }
export async function createEvent(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); try { const event = await prisma.timetableEvent.create({ data: { ...eventSchema.parse(req.body), userId: req.user.id } }); res.status(201).json({ event }); } catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Create failed" }); } }
export async function updateEvent(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); const event = await prisma.timetableEvent.updateMany({ where: { id: String(req.params.id), userId: req.user.id }, data: eventSchema.partial().parse(req.body) }); if (!event.count) return res.status(404).json({ error: "Event not found" }); res.json({ ok: true }); }
export async function deleteEvent(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); await prisma.timetableEvent.deleteMany({ where: { id: String(req.params.id), userId: req.user.id } }); res.status(204).send(); }

const classEventSchema = z.object({ title: z.string().min(1), courseCode: z.string().optional().nullable(), venue: z.string().optional().nullable(), notes: z.string().optional().nullable(), startsAt: z.coerce.date(), endsAt: z.coerce.date().optional().nullable(), faculty: z.string().optional().nullable(), department: z.string().optional().nullable(), program: z.string().trim().min(1), level: z.string().optional().nullable(), institutionId: z.string().min(1).nullable().optional() });
function normalizeScope(value: unknown) { return String(value || "").trim().toLowerCase().replace(/\s+/g, " "); }
function hasGlobalInstitutionAccess(role: string) { return role === "admin" || role === "alphaAgent"; }
function levelsMatch(first: unknown, second: unknown) {
  const a = normalizeScope(first).replace(/\s*level\s*/g, "");
  const b = normalizeScope(second).replace(/\s*level\s*/g, "");
  return Boolean(a && b && a === b);
}
export async function listClassEvents(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const user = await loadScopedUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const staff = isStaffRole(user.role);
  const scope = staff ? String(req.query.program || "").trim() : programmeScope(user);
  const level = staff
    ? String(req.query.level || "").trim()
    : String((user.courseRepMeta as { level?: string } | null)?.level || user.level || "").trim();
  const institutionId = staff && hasGlobalInstitutionAccess(user.role)
    ? String(req.query.institutionId || "").trim() || undefined
    : institutionOf(user);
  if (!staff && (!scope || (user.role === "courseRep" && !level))) {
    return res.json({ events: [] });
  }
  const events = await prisma.classEvent.findMany({
    where: {
      ...(institutionId ? { institutionId } : {}),
      ...(scope ? { department: { equals: scope, mode: "insensitive" } } : {}),
      ...(level ? { OR: [{ level: { equals: level, mode: "insensitive" } }, { level: null }] } : {}),
    },
    orderBy: { startsAt: "asc" },
    take: 200,
  });
  const authors = await prisma.user.findMany({
    where: { id: { in: [...new Set(events.map((event) => event.createdBy))] } },
    select: { id: true, name: true, nickname: true, email: true },
  });
  const authorsById = new Map(authors.map((author) => [author.id, author]));
  res.json({
    events: events.map((event) => {
      const author = authorsById.get(event.createdBy);
      const savedName = event.createdByName && !event.createdByName.includes("@")
        ? event.createdByName
        : null;
      return {
        ...event,
        createdByName: author?.name || author?.nickname || savedName || "Course Rep",
        createdByEmail: author?.email || null,
      };
    }),
  });
}
export async function createClassEvent(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  if (!["admin", "alphaAgent", "agent", "courseRep"].includes(req.user.role)) return res.status(403).json({ error: "Only Course Reps and staff can schedule class events" });
  try {
    const body = classEventSchema.parse(req.body);
    const targetScope = body.program;
    const author = await loadScopedUser(req.user.id);
    if (!author) return res.status(401).json({ error: "Unauthenticated" });
    if (req.user.role === "courseRep") {
      const meta = author.courseRepMeta as { program?: string; level?: string } | null;
      const assignedScope = meta?.program || "";
      const assignedLevel = meta?.level || author.level || "";
      if (normalizeScope(targetScope) !== normalizeScope(assignedScope) || !levelsMatch(body.level, assignedLevel)) {
        return res.status(403).json({ error: "You can only schedule classes for your assigned program and level" });
      }
    }
    const { program: _program, institutionId: _requestedInstitution, ...eventData } = body;
    if (!hasGlobalInstitutionAccess(author.role) && body.institutionId && body.institutionId !== institutionOf(author)) {
      return res.status(403).json({ error: "You can only schedule classes for your institution" });
    }
    const eventInstitutionId = hasGlobalInstitutionAccess(author.role) && body.institutionId
      ? body.institutionId
      : institutionOf(author);
    if (!(await prisma.institution.findUnique({ where: { id: eventInstitutionId }, select: { id: true } }))) {
      return res.status(400).json({ error: "Select a valid institution for this class" });
    }
    const event = await prisma.classEvent.create({ data: { ...eventData, department: targetScope, institutionId: eventInstitutionId, createdBy: req.user.id, createdByName: author.name || "Course Rep" } });
    broadcastProgramme("classEvent", event, "created");
    res.status(201).json({ event });
  }
  catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Create failed" }); }
}
export async function deleteClassEvent(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const user = await loadScopedUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const existing = await prisma.classEvent.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Class event not found" });
  if (!canSeeScoped(user, existing)) return res.status(403).json({ error: "This class belongs to another programme" });
  const result = await prisma.classEvent.deleteMany({ where: { id: String(req.params.id), ...(isStaffRole(user.role) ? {} : { createdBy: req.user.id }) } });
  if (!result.count) return res.status(404).json({ error: "Class event not found" });
  broadcastProgramme("classEvent", existing, "deleted");
  res.status(204).send();
}

const claimSchema = z.object({ plan: z.string().optional(), reference: z.string().optional(), amount: z.number().int().optional(), meta: z.any().optional() });
export async function listClaims(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); const claims = await prisma.paymentClaim.findMany({ where: ["user", "newsAgent"].includes(req.user.role) ? { userId: req.user.id } : undefined, include: { user: { select: { id: true, name: true, email: true, uniqueId: true, plan: true } } }, orderBy: { createdAt: "desc" }, take: 100 }); res.json({ claims }); }
export async function createClaim(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); try { const claim = await prisma.paymentClaim.create({ data: { ...claimSchema.parse(req.body), userId: req.user.id, status: "awaiting_review" } }); res.status(201).json({ claim }); } catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Claim failed" }); } }
export async function approveClaim(req: Request, res: Response) { const claim = await prisma.paymentClaim.update({ where: { id: String(req.params.id) }, data: { status: "activated" } }); await prisma.user.update({ where: { id: claim.userId }, data: { plan: "pro" } }); res.json({ claim }); }

export async function getSetting(req: Request, res: Response) { const setting = await prisma.setting.findUnique({ where: { key: String(req.params.key) } }); res.json({ value: setting?.value ?? null }); }
export async function updateSetting(req: Request, res: Response) { const setting = await prisma.setting.upsert({ where: { key: String(req.params.key) }, create: { key: String(req.params.key), value: req.body }, update: { value: req.body } }); res.json({ value: setting.value }); }

export async function listChat(req: Request, res: Response) { const messages = await prisma.staffChatMessage.findMany({ where: { deleted: false }, orderBy: { createdAt: "desc" }, take: 200 }); res.json({ messages: messages.reverse() }); }
export async function createChat(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); const { authorUid, authorName, authorRole, authorPhoto, authorPlan, authorSubscription, type, text, mediaUrl, mediaWidth, mediaHeight, mediaDuration, reactions, replyTo, clientAt, meeting } = req.body; const message = await prisma.staffChatMessage.create({ data: { authorId: req.user.id, authorUid, authorName, authorRole, authorPhoto, authorPlan, authorSubscription, type, text, mediaUrl, mediaWidth, mediaHeight, mediaDuration, reactions, replyTo, clientAt, meeting } }); res.status(201).json({ message }); }
const chatUpdateSchema = z.object({
  text: z.string().nullable().optional(), edited: z.boolean().optional(),
  editedAt: z.coerce.date().nullable().optional(), reactions: z.any().optional(),
  deleted: z.boolean().optional(), deletedAt: z.coerce.date().nullable().optional(),
  deletedBy: z.string().nullable().optional(), deletedByName: z.string().nullable().optional(), deletedByRole: z.string().nullable().optional(),
});
export async function updateChat(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const existing = await prisma.staffChatMessage.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Message not found" });
  const isAdmin = req.user.role === "admin";
  const isReactionOnly = Object.keys(req.body || {}).length === 1 && Object.prototype.hasOwnProperty.call(req.body, "reactions");
  if (!isReactionOnly && existing.authorId !== req.user.id && !isAdmin) return res.status(403).json({ error: "Forbidden" });
  try {
    const body = chatUpdateSchema.parse(req.body);
    const message = await prisma.staffChatMessage.update({ where: { id: existing.id }, data: body });
    return res.json({ message });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    return res.status(500).json({ error: "Message update failed" });
  }
}

const postSchema = z.object({ title: z.string().optional(), body: z.string().optional(), courseCode: z.string().nullable().optional(), faculty: z.string().nullable().optional(), department: z.string().nullable().optional(), program: z.string().nullable().optional(), level: z.string().nullable().optional(), institutionId: z.string().min(1).nullable().optional(), pinned: z.boolean().optional() });
const postPatchSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  courseCode: z.string().nullable().optional(),
  faculty: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
}).strict();
export async function listFeedPosts(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const kind = String(req.params.kind);
  const user = await loadScopedUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const staff = isStaffRole(user.role);
  const scope = staff ? String(req.query.program || "").trim() : programmeScope(user);
  const requestedScope = String(req.query.program || "").trim();
  if (!staff && requestedScope && normalizeScope(scope) !== normalizeScope(requestedScope)) return res.status(403).json({ error: "You cannot access posts outside your academic program" });
  const level = staff
    ? String(req.query.level || "").trim()
    : String((user.courseRepMeta as { level?: string } | null)?.level || user.level || "").trim();
  if (!staff && (!scope || (user.role === "courseRep" && !level))) return res.json({ posts: [] });
  const institutionId = staff && hasGlobalInstitutionAccess(user.role)
    ? String(req.query.institutionId || "").trim() || undefined
    : institutionOf(user);
  const posts = await prisma.feedPost.findMany({
    where: {
      kind,
      ...(institutionId ? { institutionId } : {}),
      ...(scope ? { department: { equals: scope, mode: "insensitive" } } : {}),
      ...(level ? { OR: [{ level: { equals: level, mode: "insensitive" } }, { level: null }] } : {}),
    },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  const authors = await prisma.user.findMany({
    where: { id: { in: [...new Set(posts.map((post) => post.authorId))] } },
    select: { id: true, name: true, nickname: true, email: true },
  });
  const authorsById = new Map(authors.map((author) => [author.id, author]));
  res.json({
    posts: posts.map((post) => {
      const author = authorsById.get(post.authorId);
      const savedName = post.authorName && !post.authorName.includes("@")
        ? post.authorName
        : null;
      return {
        ...post,
        authorName: author?.name || author?.nickname || savedName || "Course Rep",
        authorEmail: author?.email || null,
      };
    }),
  });
}
export async function createFeedPost(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  if (!["admin", "alphaAgent", "agent", "courseRep"].includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions to create feed posts" });
  try {
    const body = postSchema.parse(req.body);
    const targetScope = String(body.program || "").trim();
    const author = await loadScopedUser(req.user.id);
    if (!author) return res.status(401).json({ error: "Unauthenticated" });
    if (req.user.role === "courseRep") {
      const meta = author.courseRepMeta as { program?: string; level?: string } | null;
      const assignedScope = meta?.program || "";
      const assignedLevel = meta?.level || author.level || "";
      if (String(req.params.kind) !== "course" || !targetScope || normalizeScope(targetScope) !== normalizeScope(assignedScope) || !levelsMatch(body.level, assignedLevel)) {
        return res.status(403).json({ error: "Course Reps can only post to their assigned program and level" });
      }
    }
    if (body.department && !targetScope) return res.status(400).json({ error: "Program is required for scoped feed posts" });
    const { program: _program, institutionId: _requestedInstitution, ...postData } = body;
    if (!hasGlobalInstitutionAccess(author.role) && body.institutionId && body.institutionId !== institutionOf(author)) {
      return res.status(403).json({ error: "You can only post to your institution" });
    }
    const postInstitutionId = hasGlobalInstitutionAccess(author.role) && body.institutionId
      ? body.institutionId
      : institutionOf(author);
    if (!(await prisma.institution.findUnique({ where: { id: postInstitutionId }, select: { id: true } }))) {
      return res.status(400).json({ error: "Select a valid institution for this post" });
    }
    const post = await prisma.feedPost.create({ data: { ...postData, department: targetScope || null, institutionId: postInstitutionId, kind: String(req.params.kind), authorId: req.user.id, authorName: author.name || "User", authorRole: req.user.role } });
    broadcastProgramme("feed", post, "created");
    res.status(201).json({ post });
  }
  catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Post creation failed" }); }
}
export async function updateFeedPost(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const parsed = postPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors });
  const user = await loadScopedUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const existing = await prisma.feedPost.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Post not found" });
  const body = parsed.data;
  if (!canSeeScoped(user, existing)) return res.status(403).json({ error: "This post belongs to another programme" });
  if (!isStaffRole(user.role) && Object.keys(body).some((key) => !["title", "body", "courseCode"].includes(key))) {
    return res.status(403).json({ error: "You cannot change a post's academic scope" });
  }
  if (existing.authorId !== user.id && !isStaffRole(user.role)) {
    return res.status(403).json({ error: "You can't change this post" });
  }
  const post = await prisma.feedPost.update({ where: { id: existing.id }, data: body });
  broadcastProgramme("feed", post, "updated");
  res.json({ ok: true, post });
}

const saveSchema = z.object({ materialId: z.string().min(1), title: z.string().optional(), url: z.string().optional(), meta: z.any().optional() });
export async function listMaterialSaves(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const saves = await prisma.materialSave.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
  res.json({ saves });
}
export async function createMaterialSave(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try { const body = saveSchema.parse(req.body); const save = await prisma.materialSave.upsert({ where: { id: `${req.user.id}:${body.materialId}` }, create: { id: `${req.user.id}:${body.materialId}`, ...body, userId: req.user.id }, update: body }); res.status(201).json({ save }); }
  catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Save failed" }); }
}
export async function deleteMaterialSave(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  await prisma.materialSave.deleteMany({ where: { id: String(req.params.id), userId: req.user.id } });
  res.status(204).send();
}
export async function deleteFeedPost(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const user = await loadScopedUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });
  const existing = await prisma.feedPost.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) return res.status(404).json({ error: "Post not found" });
  if (!canSeeScoped(user, existing)) return res.status(403).json({ error: "This post belongs to another programme" });
  const result = await prisma.feedPost.deleteMany({ where: { id: String(req.params.id), ...(isStaffRole(user.role) ? {} : { authorId: req.user.id }) } });
  if (!result.count) return res.status(404).json({ error: "Post not found" });
  broadcastProgramme("feed", existing, "deleted");
  res.status(204).send();
}

export async function subscriptionCount(_req: Request, res: Response) {
  const count = await prisma.subscription.count({ where: { status: "active" } });
  res.json({ count });
}