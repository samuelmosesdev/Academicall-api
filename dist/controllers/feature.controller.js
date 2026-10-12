"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listQuestions = listQuestions;
exports.createQuestion = createQuestion;
exports.createQuestionFromMaterial = createQuestionFromMaterial;
exports.updateQuestion = updateQuestion;
exports.deleteQuestion = deleteQuestion;
exports.listEvents = listEvents;
exports.createEvent = createEvent;
exports.updateEvent = updateEvent;
exports.deleteEvent = deleteEvent;
exports.listClassEvents = listClassEvents;
exports.createClassEvent = createClassEvent;
exports.deleteClassEvent = deleteClassEvent;
exports.listClaims = listClaims;
exports.createClaim = createClaim;
exports.approveClaim = approveClaim;
exports.getSetting = getSetting;
exports.updateSetting = updateSetting;
exports.listChat = listChat;
exports.createChat = createChat;
exports.updateChat = updateChat;
exports.listFeedPosts = listFeedPosts;
exports.createFeedPost = createFeedPost;
exports.updateFeedPost = updateFeedPost;
exports.listMaterialSaves = listMaterialSaves;
exports.createMaterialSave = createMaterialSave;
exports.deleteMaterialSave = deleteMaterialSave;
exports.deleteFeedPost = deleteFeedPost;
exports.subscriptionCount = subscriptionCount;
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const questionSchema = zod_1.z.object({
    courseId: zod_1.z.string().optional().nullable(),
    documentId: zod_1.z.string().optional().nullable(),
    materialId: zod_1.z.string().optional().nullable(),
    courseCode: zod_1.z.string().optional().nullable(),
    courseTitle: zod_1.z.string().optional().nullable(),
    topic: zod_1.z.string().optional().nullable(),
    faculty: zod_1.z.string().optional().nullable(),
    department: zod_1.z.string().optional().nullable(),
    level: zod_1.z.string().optional().nullable(),
    questionText: zod_1.z.string().min(1),
    options: zod_1.z.array(zod_1.z.string()).min(2),
    correctIndex: zod_1.z.number().int().min(0),
    explanation: zod_1.z.string().optional().nullable(),
    difficulty: zod_1.z.string().optional(),
    source: zod_1.z.string().optional().nullable(),
    marks: zod_1.z.number().int().min(0).optional(),
    referenceCode: zod_1.z.string().optional().nullable(),
    hintEnabled: zod_1.z.boolean().optional(),
    generatedByUserId: zod_1.z.string().optional().nullable(),
});
async function listQuestions(req, res) {
    try {
        const materialId = req.query.materialId ? String(req.query.materialId) : undefined;
        const documentId = req.query.documentId ? String(req.query.documentId) : undefined;
        const where = {};
        if (materialId) {
            where.OR = [{ materialId }, { documentId: materialId }];
        }
        else if (documentId) {
            where.documentId = documentId;
        }
        const questions = await prisma_1.prisma.cbtQuestion.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: 5000,
        });
        res.json({ questions });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || "Failed to list questions" });
    }
}
async function createQuestion(req, res) {
    try {
        const payload = questionSchema.parse(req.body);
        const question = await prisma_1.prisma.cbtQuestion.create({
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        console.error(err);
        res.status(500).json({ error: "Create failed" });
    }
}
async function createQuestionFromMaterial(req, res) {
    try {
        const { courseCode, courseTitle, faculty, department, level, topic, questionText, options, correctIndex, explanation, difficulty, materialId, documentId, source } = req.body;
        if (!questionText || !Array.isArray(options) || options.length < 2) {
            return res.status(400).json({ error: "questionText and options required" });
        }
        const mids = materialId || documentId;
        if (!mids) {
            return res.status(400).json({ error: "materialId required" });
        }
        const question = await prisma_1.prisma.cbtQuestion.create({
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
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || "Failed to create question" });
    }
}
async function updateQuestion(req, res) {
    try {
        const question = await prisma_1.prisma.cbtQuestion.update({ where: { id: String(req.params.id) }, data: questionSchema.partial().parse(req.body) });
        res.json({ question });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Update failed" });
    }
}
async function deleteQuestion(req, res) { await prisma_1.prisma.cbtQuestion.delete({ where: { id: String(req.params.id) } }); res.status(204).send(); }
const eventSchema = zod_1.z.object({ title: zod_1.z.string().min(1), description: zod_1.z.string().optional().nullable(), startAt: zod_1.z.coerce.date().optional().nullable(), endAt: zod_1.z.coerce.date().optional().nullable(), location: zod_1.z.string().optional().nullable(), courseId: zod_1.z.string().optional().nullable(), courseCode: zod_1.z.string().optional().nullable(), dayOfWeek: zod_1.z.number().int().min(0).max(6).optional(), startTime: zod_1.z.string().optional(), endTime: zod_1.z.string().optional(), reminderMinutes: zod_1.z.number().int().min(0).optional(), reminderEnabled: zod_1.z.boolean().optional(), notes: zod_1.z.string().optional().nullable() });
async function listEvents(req, res) { if (!req.user)
    return res.status(401).json({ error: "Unauthenticated" }); const events = await prisma_1.prisma.timetableEvent.findMany({ where: { userId: req.user.id }, orderBy: { startAt: "asc" } }); res.json({ events }); }
async function createEvent(req, res) { if (!req.user)
    return res.status(401).json({ error: "Unauthenticated" }); try {
    const event = await prisma_1.prisma.timetableEvent.create({ data: { ...eventSchema.parse(req.body), userId: req.user.id } });
    res.status(201).json({ event });
}
catch (err) {
    if (err instanceof zod_1.z.ZodError)
        return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Create failed" });
} }
async function updateEvent(req, res) { if (!req.user)
    return res.status(401).json({ error: "Unauthenticated" }); const event = await prisma_1.prisma.timetableEvent.updateMany({ where: { id: String(req.params.id), userId: req.user.id }, data: eventSchema.partial().parse(req.body) }); if (!event.count)
    return res.status(404).json({ error: "Event not found" }); res.json({ ok: true }); }
async function deleteEvent(req, res) { if (!req.user)
    return res.status(401).json({ error: "Unauthenticated" }); await prisma_1.prisma.timetableEvent.deleteMany({ where: { id: String(req.params.id), userId: req.user.id } }); res.status(204).send(); }
const classEventSchema = zod_1.z.object({ title: zod_1.z.string().min(1), courseCode: zod_1.z.string().optional().nullable(), venue: zod_1.z.string().optional().nullable(), notes: zod_1.z.string().optional().nullable(), startsAt: zod_1.z.coerce.date(), endsAt: zod_1.z.coerce.date().optional().nullable(), faculty: zod_1.z.string().optional().nullable(), department: zod_1.z.string().optional().nullable(), program: zod_1.z.string().trim().min(1), level: zod_1.z.string().optional().nullable() });
function normalizeScope(value) { return String(value || "").trim().toLowerCase().replace(/\s+/g, " "); }
function levelsMatch(first, second) {
    const a = normalizeScope(first).replace(/\s*level\s*/g, "");
    const b = normalizeScope(second).replace(/\s*level\s*/g, "");
    return Boolean(a && b && a === b);
}
async function listClassEvents(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user.role);
    const user = isStaff ? null : await prisma_1.prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, department: true, program: true, level: true, courseRepMeta: true } });
    const meta = user?.courseRepMeta;
    const scope = user?.role === "courseRep" ? meta?.program : user?.program;
    const level = user?.role === "courseRep" ? meta?.level : user?.level;
    if (!isStaff && (!scope || (user?.role === "courseRep" && !level))) {
        return res.json({ events: [] });
    }
    const events = await prisma_1.prisma.classEvent.findMany({
        where: isStaff ? {} : {
            department: { equals: scope, mode: "insensitive" },
            ...(level ? { OR: [{ level: { equals: level, mode: "insensitive" } }, { level: null }] } : {}),
        },
        orderBy: { startsAt: "asc" },
        take: 200,
    });
    const authors = await prisma_1.prisma.user.findMany({
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
async function createClassEvent(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    if (!["admin", "alphaAgent", "agent", "courseRep"].includes(req.user.role))
        return res.status(403).json({ error: "Only Course Reps and staff can schedule class events" });
    try {
        const body = classEventSchema.parse(req.body);
        const targetScope = body.program;
        if (req.user.role === "courseRep") {
            const rep = await prisma_1.prisma.user.findUnique({ where: { id: req.user.id }, select: { department: true, program: true, level: true, courseRepMeta: true } });
            const meta = rep?.courseRepMeta;
            const assignedScope = meta?.program || "";
            const assignedLevel = meta?.level || "";
            if (normalizeScope(targetScope) !== normalizeScope(assignedScope) || !levelsMatch(body.level, assignedLevel)) {
                return res.status(403).json({ error: "You can only schedule classes for your assigned program and level" });
            }
        }
        const { program: _program, ...eventData } = body;
        const author = await prisma_1.prisma.user.findUnique({
            where: { id: req.user.id },
            select: { name: true, nickname: true },
        });
        const event = await prisma_1.prisma.classEvent.create({ data: { ...eventData, department: targetScope, createdBy: req.user.id, createdByName: author?.name || author?.nickname || "Course Rep" } });
        res.status(201).json({ event });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Create failed" });
    }
}
async function deleteClassEvent(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const canDeleteAny = ["admin", "alphaAgent", "agent"].includes(req.user.role);
    const result = await prisma_1.prisma.classEvent.deleteMany({ where: { id: String(req.params.id), ...(canDeleteAny ? {} : { createdBy: req.user.id }) } });
    if (!result.count)
        return res.status(404).json({ error: "Class event not found" });
    res.status(204).send();
}
const claimSchema = zod_1.z.object({ plan: zod_1.z.string().optional(), reference: zod_1.z.string().optional(), amount: zod_1.z.number().int().optional(), meta: zod_1.z.any().optional() });
async function listClaims(req, res) { if (!req.user)
    return res.status(401).json({ error: "Unauthenticated" }); const claims = await prisma_1.prisma.paymentClaim.findMany({ where: req.user.role === "user" ? { userId: req.user.id } : undefined, include: { user: { select: { id: true, name: true, email: true, uniqueId: true, plan: true } } }, orderBy: { createdAt: "desc" }, take: 100 }); res.json({ claims }); }
async function createClaim(req, res) { if (!req.user)
    return res.status(401).json({ error: "Unauthenticated" }); try {
    const claim = await prisma_1.prisma.paymentClaim.create({ data: { ...claimSchema.parse(req.body), userId: req.user.id, status: "awaiting_review" } });
    res.status(201).json({ claim });
}
catch (err) {
    if (err instanceof zod_1.z.ZodError)
        return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Claim failed" });
} }
async function approveClaim(req, res) { const claim = await prisma_1.prisma.paymentClaim.update({ where: { id: String(req.params.id) }, data: { status: "activated" } }); await prisma_1.prisma.user.update({ where: { id: claim.userId }, data: { plan: "pro" } }); res.json({ claim }); }
async function getSetting(req, res) { const setting = await prisma_1.prisma.setting.findUnique({ where: { key: String(req.params.key) } }); res.json({ value: setting?.value ?? null }); }
async function updateSetting(req, res) { const setting = await prisma_1.prisma.setting.upsert({ where: { key: String(req.params.key) }, create: { key: String(req.params.key), value: req.body }, update: { value: req.body } }); res.json({ value: setting.value }); }
async function listChat(req, res) { const messages = await prisma_1.prisma.staffChatMessage.findMany({ where: { deleted: false }, orderBy: { createdAt: "desc" }, take: 200 }); res.json({ messages: messages.reverse() }); }
async function createChat(req, res) { if (!req.user)
    return res.status(401).json({ error: "Unauthenticated" }); const { authorUid, authorName, authorRole, authorPhoto, authorPlan, authorSubscription, type, text, mediaUrl, mediaWidth, mediaHeight, mediaDuration, reactions, replyTo, clientAt, meeting } = req.body; const message = await prisma_1.prisma.staffChatMessage.create({ data: { authorId: req.user.id, authorUid, authorName, authorRole, authorPhoto, authorPlan, authorSubscription, type, text, mediaUrl, mediaWidth, mediaHeight, mediaDuration, reactions, replyTo, clientAt, meeting } }); res.status(201).json({ message }); }
const chatUpdateSchema = zod_1.z.object({
    text: zod_1.z.string().nullable().optional(), edited: zod_1.z.boolean().optional(),
    editedAt: zod_1.z.coerce.date().nullable().optional(), reactions: zod_1.z.any().optional(),
    deleted: zod_1.z.boolean().optional(), deletedAt: zod_1.z.coerce.date().nullable().optional(),
    deletedBy: zod_1.z.string().nullable().optional(), deletedByName: zod_1.z.string().nullable().optional(), deletedByRole: zod_1.z.string().nullable().optional(),
});
async function updateChat(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const existing = await prisma_1.prisma.staffChatMessage.findUnique({ where: { id: String(req.params.id) } });
    if (!existing)
        return res.status(404).json({ error: "Message not found" });
    const isAdmin = req.user.role === "admin";
    const isReactionOnly = Object.keys(req.body || {}).length === 1 && Object.prototype.hasOwnProperty.call(req.body, "reactions");
    if (!isReactionOnly && existing.authorId !== req.user.id && !isAdmin)
        return res.status(403).json({ error: "Forbidden" });
    try {
        const body = chatUpdateSchema.parse(req.body);
        const message = await prisma_1.prisma.staffChatMessage.update({ where: { id: existing.id }, data: body });
        return res.json({ message });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        return res.status(500).json({ error: "Message update failed" });
    }
}
const postSchema = zod_1.z.object({ title: zod_1.z.string().optional(), body: zod_1.z.string().optional(), courseCode: zod_1.z.string().nullable().optional(), faculty: zod_1.z.string().nullable().optional(), department: zod_1.z.string().nullable().optional(), program: zod_1.z.string().nullable().optional(), level: zod_1.z.string().nullable().optional(), pinned: zod_1.z.boolean().optional(), comments: zod_1.z.any().optional(), reactions: zod_1.z.any().optional() });
async function listFeedPosts(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const kind = String(req.params.kind);
    const isStaff = ["admin", "alphaAgent", "agent"].includes(req.user.role);
    const user = isStaff ? null : await prisma_1.prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, department: true, program: true, level: true, courseRepMeta: true } });
    const meta = user?.courseRepMeta;
    const scope = user?.role === "courseRep" ? meta?.program : user?.program;
    const requestedScope = String(req.query.program || "").trim();
    if (!isStaff && requestedScope && normalizeScope(scope) !== normalizeScope(requestedScope))
        return res.status(403).json({ error: "You cannot access posts outside your academic program" });
    const level = user?.role === "courseRep" ? meta?.level : user?.level;
    if (!isStaff && (!scope || (user?.role === "courseRep" && !level)))
        return res.json({ posts: [] });
    const posts = await prisma_1.prisma.feedPost.findMany({ where: { kind, ...(isStaff ? {} : { department: scope, level }) }, orderBy: [{ pinned: "desc" }, { createdAt: "desc" }], take: 100 });
    const authors = await prisma_1.prisma.user.findMany({
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
async function createFeedPost(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    if (!["admin", "alphaAgent", "agent", "courseRep"].includes(req.user.role))
        return res.status(403).json({ error: "Insufficient permissions to create feed posts" });
    try {
        const body = postSchema.parse(req.body);
        const targetScope = String(body.program || "").trim();
        if (req.user.role === "courseRep") {
            const rep = await prisma_1.prisma.user.findUnique({ where: { id: req.user.id }, select: { department: true, program: true, level: true, courseRepMeta: true } });
            const meta = rep?.courseRepMeta;
            const assignedScope = meta?.program || "";
            const assignedLevel = meta?.level || "";
            if (String(req.params.kind) !== "course" || !targetScope || normalizeScope(targetScope) !== normalizeScope(assignedScope) || !levelsMatch(body.level, assignedLevel)) {
                return res.status(403).json({ error: "Course Reps can only post to their assigned program and level" });
            }
        }
        if (body.department && !targetScope)
            return res.status(400).json({ error: "Program is required for scoped feed posts" });
        const { program: _program, ...postData } = body;
        const author = await prisma_1.prisma.user.findUnique({
            where: { id: req.user.id },
            select: { name: true, nickname: true },
        });
        const post = await prisma_1.prisma.feedPost.create({ data: { ...postData, department: targetScope || null, kind: String(req.params.kind), authorId: req.user.id, authorName: author?.name || author?.nickname || "User", authorRole: req.user.role } });
        res.status(201).json({ post });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Post creation failed" });
    }
}
async function updateFeedPost(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const body = postSchema.partial().parse(req.body);
    const reactionOrCommentOnly = Object.keys(body).every((key) => key === "reactions" || key === "comments");
    const result = await prisma_1.prisma.feedPost.updateMany({ where: { id: String(req.params.id), ...(reactionOrCommentOnly ? {} : { authorId: req.user.id }) }, data: body });
    if (!result.count)
        return res.status(404).json({ error: "Post not found" });
    res.json({ ok: true });
}
const saveSchema = zod_1.z.object({ materialId: zod_1.z.string().min(1), title: zod_1.z.string().optional(), url: zod_1.z.string().optional(), meta: zod_1.z.any().optional() });
async function listMaterialSaves(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const saves = await prisma_1.prisma.materialSave.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" } });
    res.json({ saves });
}
async function createMaterialSave(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    try {
        const body = saveSchema.parse(req.body);
        const save = await prisma_1.prisma.materialSave.upsert({ where: { id: `${req.user.id}:${body.materialId}` }, create: { id: `${req.user.id}:${body.materialId}`, ...body, userId: req.user.id }, update: body });
        res.status(201).json({ save });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError)
            return res.status(400).json({ error: err.errors });
        res.status(500).json({ error: "Save failed" });
    }
}
async function deleteMaterialSave(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    await prisma_1.prisma.materialSave.deleteMany({ where: { id: String(req.params.id), userId: req.user.id } });
    res.status(204).send();
}
async function deleteFeedPost(req, res) {
    if (!req.user)
        return res.status(401).json({ error: "Unauthenticated" });
    const canDeleteAny = ["admin", "alphaAgent", "agent"].includes(req.user.role);
    const result = await prisma_1.prisma.feedPost.deleteMany({ where: { id: String(req.params.id), ...(canDeleteAny ? {} : { authorId: req.user.id }) } });
    if (!result.count)
        return res.status(404).json({ error: "Post not found" });
    res.status(204).send();
}
async function subscriptionCount(_req, res) {
    const count = await prisma_1.prisma.subscription.count({ where: { status: "active" } });
    res.json({ count });
}
//# sourceMappingURL=feature.controller.js.map