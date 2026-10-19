import { Request } from "express";
import { HttpError } from "./http";

/** "Muted until …" text when the caller is muted from the moderation queue, else null. */
export function mutedMessage(req: Request) {
  const until = req.user?.mutedUntil ? new Date(req.user.mutedUntil) : null;
  if (!until || until.getTime() <= Date.now()) return null;
  const when = until.toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `You can't post right now. Academicall staff muted your account until ${when} (Lagos time).`;
}

export function assertNotMuted(req: Request) {
  const msg = mutedMessage(req);
  if (msg) throw new HttpError(403, msg, "muted");
}
