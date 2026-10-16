import { NotificationType } from "@prisma/client";
import { prisma } from "./prisma";
import { publishToUsers } from "./realtime";

/**
 * Write the same in-app notification for many people at once, then nudge their
 * open tabs over the real-time stream so badges update without a refresh.
 */
export async function notifyMany(
  userIds: Iterable<string>,
  n: { type: NotificationType; title: string; body?: string | null; data?: Record<string, unknown>; createdById?: string | null },
) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await prisma.notification.createMany({
      data: chunk.map((userId) => ({
        userId,
        type: n.type,
        title: n.title.slice(0, 200),
        body: n.body ? n.body.slice(0, 500) : null,
        data: (n.data || {}) as any,
        createdById: n.createdById || null,
      })),
    });
  }
  publishToUsers(ids, { type: "notification", data: { kind: n.type, ...(n.data || {}) } });
  return ids.length;
}

/** Title-case the official ALL-CAPS JAMB names (same rule as the web app). */
export function prettyName(name = "") {
  const s = String(name || "");
  if (!s || s !== s.toUpperCase()) return s;
  const small = new Set(["and", "of", "the", "in", "for", "to", "&", "on", "at"]);
  const keep = /^(FCT|ND|NCE|HND|ICT|UNN|ABU|UTME|II|III|IV|OND|USA|UK)\.?,?$/i;
  return s
    .toLowerCase()
    .split(/(\s+|\/|-|\()/)
    .map((w, i) => {
      if (!w.trim() || /^[\s/(-]$/.test(w)) return w;
      if (keep.test(w)) return w.toUpperCase();
      if (i > 0 && small.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join("");
}

export const institutionTitle = (i?: { name?: string | null; displayName?: string | null } | null) =>
  (i?.displayName || prettyName(i?.name || "")) || "Institution";
