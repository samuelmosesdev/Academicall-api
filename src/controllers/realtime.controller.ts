import { Request, Response } from "express";
import { addClient } from "../lib/realtime";
import { institutionOf, loadScopedUser, programmeScope, programmeScopeKey } from "../lib/scope";

/**
 * GET /realtime/stream — Server-Sent Events.
 * Auth uses the normal Authorization header (the web client streams with fetch,
 * so the token never appears in a URL or access log).
 */
export async function stream(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  const user = await loadScopedUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const scopes: string[] = [];
  const scope = programmeScope(user);
  if (scope) scopes.push(programmeScopeKey(institutionOf(user), scope));

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (nginx / Render)
  res.flushHeaders?.();
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  // Ask the browser to wait 3 s before reconnecting after a drop.
  res.write(`retry: 3000\n`);
  res.write(`event: ready\ndata: ${JSON.stringify({ userId: user.id, scopes, at: new Date().toISOString() })}\n\n`);
  addClient(user.id, res, scopes);
}
