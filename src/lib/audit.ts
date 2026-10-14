import { prisma } from "./prisma";

/** Record a privileged action in the activity log (shown in Audit Log and the Secretariat journal). */
export async function audit(
  actor: { id?: string; name?: string | null; email?: string } | undefined,
  action: string,
  target?: { id?: string | null; label?: string | null } | null,
  meta?: Record<string, unknown>,
) {
  try {
    await prisma.activityLog.create({
      data: {
        userId: actor?.id || null,
        userName: actor?.name || actor?.email || null,
        action,
        status: "success",
        reference: target?.id || null,
        meta: { ...(meta || {}), ...(target?.label ? { targetName: target.label } : {}), ...(target?.id ? { targetUid: target.id } : {}) } as any,
      },
    });
  } catch (err) {
    console.error("[audit]", action, err);
  }
}
