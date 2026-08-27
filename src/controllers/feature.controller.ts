import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

const questionSchema = z.object({
  courseId: z.string().uuid().optional().nullable(), courseCode: z.string().optional().nullable(),
  courseTitle: z.string().optional().nullable(), topic: z.string().optional().nullable(),
  faculty: z.string().optional().nullable(), department: z.string().optional().nullable(),
  level: z.string().optional().nullable(), questionText: z.string().min(1),
  options: z.array(z.string()).length(4), correctIndex: z.number().int().min(0).max(3),
  explanation: z.string().optional().nullable(), difficulty: z.string().optional(),
});

export async function listQuestions(_req: Request, res: Response) {
  const questions = await prisma.cbtQuestion.findMany({ orderBy: { createdAt: "desc" }, take: 5000 });
  res.json({ questions });
}
export async function createQuestion(req: Request, res: Response) {
  try { const question = await prisma.cbtQuestion.create({ data: questionSchema.parse(req.body) }); res.status(201).json({ question }); }
  catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Create failed" }); }
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

const claimSchema = z.object({ plan: z.string().optional(), reference: z.string().optional(), amount: z.number().int().optional(), meta: z.any().optional() });
export async function listClaims(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); const claims = await prisma.paymentClaim.findMany({ where: req.user.role === "user" ? { userId: req.user.id } : undefined, include: { user: { select: { id: true, name: true, email: true, uniqueId: true, plan: true } } }, orderBy: { createdAt: "desc" }, take: 100 }); res.json({ claims }); }
export async function createClaim(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); try { const claim = await prisma.paymentClaim.create({ data: { ...claimSchema.parse(req.body), userId: req.user.id, status: "awaiting_review" } }); res.status(201).json({ claim }); } catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors }); res.status(500).json({ error: "Claim failed" }); } }
export async function approveClaim(req: Request, res: Response) { const claim = await prisma.paymentClaim.update({ where: { id: String(req.params.id) }, data: { status: "activated" } }); await prisma.user.update({ where: { id: claim.userId }, data: { plan: "pro" } }); res.json({ claim }); }

export async function getSetting(req: Request, res: Response) { const setting = await prisma.setting.findUnique({ where: { key: String(req.params.key) } }); res.json({ value: setting?.value ?? null }); }
export async function updateSetting(req: Request, res: Response) { const setting = await prisma.setting.upsert({ where: { key: String(req.params.key) }, create: { key: String(req.params.key), value: req.body }, update: { value: req.body } }); res.json({ value: setting.value }); }

export async function listChat(req: Request, res: Response) { const messages = await prisma.staffChatMessage.findMany({ where: { deleted: false }, orderBy: { createdAt: "desc" }, take: 200 }); res.json({ messages: messages.reverse() }); }
export async function createChat(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); const { authorUid, authorName, authorRole, authorPhoto, authorPlan, authorSubscription, type, text, mediaUrl, mediaWidth, mediaHeight, mediaDuration, reactions, replyTo, clientAt, meeting } = req.body; const message = await prisma.staffChatMessage.create({ data: { authorId: req.user.id, authorUid, authorName, authorRole, authorPhoto, authorPlan, authorSubscription, type, text, mediaUrl, mediaWidth, mediaHeight, mediaDuration, reactions, replyTo, clientAt, meeting } }); res.status(201).json({ message }); }
export async function updateChat(req: Request, res: Response) { if (!req.user) return res.status(401).json({ error: "Unauthenticated" }); const message = await prisma.staffChatMessage.update({ where: { id: String(req.params.id) }, data: req.body }); res.json({ message }); }