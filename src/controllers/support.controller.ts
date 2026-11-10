import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { hasCap, isStaffRole } from "../lib/access";

const ticketStatus = z.enum(["open", "in_progress", "waiting_on_user", "resolved", "closed"]);
const ticketPriority = z.enum(["low", "normal", "high", "urgent"]);
const STAFF_SUPPORT_CAPS = ["support.tickets", "requests.review"];

const createTicketSchema = z.object({
  category: z.enum(["account", "payment", "content", "bug", "other"]),
  subject: z.string().trim().min(3).max(120),
  message: z.string().trim().min(10).max(5000),
  screenshotUrl: z.string().url().nullable().optional(),
});

const staffUpdateSchema = z.object({
  status: ticketStatus.optional(),
  priority: ticketPriority.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  internalNotes: z.string().max(5000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

const replySchema = z.object({
  body: z.string().trim().min(1).max(5000),
  isInternal: z.boolean().optional().default(false),
});

function isSupportStaff(req: Request) {
  return !!req.user && STAFF_SUPPORT_CAPS.some((cap) => hasCap(req.user!, cap));
}

function sendValidationError(err: unknown, res: Response) {
  if (!(err instanceof z.ZodError)) return false;
  res.status(400).json({ error: err.errors });
  return true;
}

export async function createTicket(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    const body = createTicketSchema.parse(req.body);
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.id,
        category: body.category,
        subject: body.subject,
        message: body.message,
        screenshotUrl: body.screenshotUrl ?? null,
      },
    });
    return res.status(201).json({ ticket });
  } catch (err) {
    if (sendValidationError(err, res)) return;
    return next(err);
  }
}

export async function listMyTickets(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        category: true,
        subject: true,
        status: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
      },
    });
    return res.json({ tickets });
  } catch (err) {
    return next(err);
  }
}

export async function getMyTicket(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    const ticket = await prisma.supportTicket.findFirst({
      where: { id: String(req.params.id), userId: req.user.id },
      include: {
        replies: {
          where: { isInternal: false },
          orderBy: { createdAt: "asc" },
          include: { author: { select: { id: true, name: true } } },
        },
      },
    });
    if (!ticket) return res.status(404).json({ error: "Support ticket not found" });
    const { internalNotes: _internalNotes, ...publicTicket } = ticket;
    return res.json({ ticket: publicTicket });
  } catch (err) {
    return next(err);
  }
}

export async function listTickets(req: Request, res: Response, next: NextFunction) {
  try {
    const filters = z.object({
      status: ticketStatus.optional(),
      assigneeId: z.string().uuid().optional(),
    }).safeParse(req.query);
    if (!filters.success) return res.status(400).json({ error: filters.error.errors });

    const tickets = await prisma.supportTicket.findMany({
      where: {
        ...(filters.data.status ? { status: filters.data.status } : {}),
        ...(filters.data.assigneeId ? { assigneeId: filters.data.assigneeId } : {}),
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 100,
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true } },
        replies: {
          orderBy: { createdAt: "asc" },
          include: { author: { select: { id: true, name: true } } },
        },
      },
    });
    return res.json({ tickets });
  } catch (err) {
    return next(err);
  }
}

export async function updateTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const body = staffUpdateSchema.parse(req.body);
    if (body.assigneeId) {
      const assignee = await prisma.user.findUnique({
        where: { id: body.assigneeId },
        select: { id: true, role: true, staffTags: true, permissions: true },
      });
      if (!assignee || !isStaffRole(assignee.role) || !STAFF_SUPPORT_CAPS.some((cap) => hasCap(assignee, cap))) {
        return res.status(400).json({ error: "Assignee must be a staff member with support access" });
      }
    }

    const current = await prisma.supportTicket.findUnique({ where: { id: String(req.params.id) } });
    if (!current) return res.status(404).json({ error: "Support ticket not found" });

    const data = {
      ...body,
      ...(body.status
        ? { resolvedAt: ["resolved", "closed"].includes(body.status) ? new Date() : null }
        : {}),
    };
    const ticket = await prisma.supportTicket.update({
      where: { id: current.id },
      data,
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true } },
        replies: {
          orderBy: { createdAt: "asc" },
          include: { author: { select: { id: true, name: true } } },
        },
      },
    });
    return res.json({ ticket });
  } catch (err) {
    if (sendValidationError(err, res)) return;
    return next(err);
  }
}

export async function addReply(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    const body = replySchema.parse(req.body);
    const isStaff = isStaffRole(req.user.role);
    if (isStaff && !isSupportStaff(req)) {
      return res.status(403).json({ error: "You don't have access to support tickets" });
    }
    if (!isStaff && body.isInternal) {
      return res.status(403).json({ error: "Only support staff can add internal replies" });
    }

    const ticket = await prisma.supportTicket.findUnique({ where: { id: String(req.params.id) } });
    if (!ticket) return res.status(404).json({ error: "Support ticket not found" });
    if (!isStaff && ticket.userId !== req.user.id) {
      return res.status(404).json({ error: "Support ticket not found" });
    }

    const isInternal = isStaff && body.isInternal;
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const reply = await tx.supportTicketReply.create({
        data: {
          ticketId: ticket.id,
          authorId: req.user!.id,
          body: body.body,
          isStaff,
          isInternal,
        },
        include: { author: { select: { id: true, name: true } } },
      });
      if (!isInternal) {
        await tx.supportTicket.update({
          where: { id: ticket.id },
          data: isStaff
            ? { firstRepliedAt: ticket.firstRepliedAt ?? now, status: "waiting_on_user", resolvedAt: null }
            : { status: "open", resolvedAt: null },
        });
      }
      return reply;
    });

    return res.status(201).json({ reply: result });
  } catch (err) {
    if (sendValidationError(err, res)) return;
    return next(err);
  }
}
