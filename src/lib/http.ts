import { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra?: Record<string, unknown>) { super(message); }
}

/** Wrap an async handler: HttpError → its status, ZodError → 400 with readable messages, unique violations → 409. */
export const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    await fn(req, res);
  } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
    if (err instanceof z.ZodError) {
      const first = err.errors[0];
      return res.status(400).json({ error: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input", issues: err.errors });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return res.status(409).json({ error: "That record already exists" });
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return res.status(404).json({ error: "Not found" });
    if (typeof err?.status === "number") return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
};

export const pageParams = (q: any, { def = 25, max = 100 } = {}) => {
  const pageSize = Math.min(Math.max(Number(q.pageSize) || def, 1), max);
  const page = Math.max(Number(q.page) || 1, 1);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};
