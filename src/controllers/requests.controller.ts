import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";

const requestSchema = z.object({
  type: z.string().optional(), title: z.string().optional(), body: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(), meta: z.any().optional(),
});

export async function listRequests(req: Request, res: Response) {
  const requests = await prisma.request.findMany({
    where: req.user?.role === "user" ? { requesterUid: req.user.id } : undefined,
    orderBy: { createdAt: "desc" }, take: 200,
  });
  res.json({ requests });
}

export async function createRequest(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  try {
    const body = requestSchema.parse(req.body);
    const request = await prisma.request.create({ data: { ...body, requesterUid: req.user.id } });
    res.status(201).json({ request });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Create failed" });
  }
}

export async function updateRequest(req: Request, res: Response) {
  try {
    const body = requestSchema.partial().parse(req.body);
    const request = await prisma.request.update({ where: { id: String(req.params.id) }, data: body });
    res.json({ request });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Update failed" });
  }
}