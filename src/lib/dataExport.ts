/**
 * "Download my data": everything Academicall holds about one person, as JSON.
 *
 * Secrets never leave: password, reset and 2FA hashes are dropped, and Vault
 * files are listed by name only (their contents stay encrypted on the server).
 */
import { prisma } from "./prisma";

const SECRET_FIELDS = [
  "passwordHash", "passwordResetHash", "passwordResetExpiresAt", "emailVerificationHash", "emailVerificationExpiresAt",
  "twoFactorSecret", "twoFactorBackupHashes", "fcmToken", "deviceToken", "fcmTokens", "firebaseUid", "googleUid", "permissions",
];

export async function exportUserData(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { institution: { select: { name: true, displayName: true } } } });
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  const account: Record<string, unknown> = { ...user };
  for (const f of SECRET_FIELDS) delete account[f];

  const by = { where: { userId } };
  const [
    enrollments, materialSaves, timetable, notifications, groupMemberships, groupMessages, newsComments, houseThreads, houseReplies,
    aspirations, utmeAttempts, results, testAttempts, vaultFolders, vaultFiles, paymentClaims, payments, subscriptions,
    requests, profileChanges, uploads, sessions, logins, reports, restrictions, blocks,
  ] = await Promise.all([
    prisma.enrollment.findMany(by),
    prisma.materialSave.findMany(by),
    prisma.timetableEvent.findMany(by),
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 1000, select: { type: true, title: true, body: true, createdAt: true, readAt: true } }),
    prisma.studyGroupMember.findMany({ where: { userId }, include: { group: { select: { name: true, code: true } } } }),
    prisma.studyGroupMessage.findMany({ where: { senderId: userId }, orderBy: { createdAt: "desc" }, take: 5000, select: { groupId: true, type: true, text: true, attachmentName: true, createdAt: true, deletedAt: true } }),
    prisma.newsComment.findMany({ where: { userId }, select: { postId: true, body: true, createdAt: true, deletedAt: true } }),
    prisma.houseThread.findMany({ where: { authorId: userId }, select: { houseId: true, title: true, body: true, createdAt: true, deletedAt: true } }),
    prisma.houseReply.findMany({ where: { authorId: userId }, select: { threadId: true, body: true, createdAt: true, deletedAt: true } }),
    prisma.aspiration.findMany({ where: { userId }, include: { institution: { select: { name: true } } } }),
    prisma.utmeAttempt.findMany({ where: { userId }, select: { mode: true, style: true, subjects: true, total: true, correct: true, score: true, maxScore: true, durationSec: true, createdAt: true } }),
    prisma.academicResult.findMany(by),
    prisma.generalTestAttempt.findMany({ where: { userId }, include: { test: { select: { title: true } } } }),
    prisma.vaultFolder.findMany({ where: { userId }, select: { name: true, createdAt: true } }),
    prisma.vaultFile.findMany({ where: { userId }, select: { name: true, createdAt: true } as any }),
    prisma.paymentClaim.findMany(by),
    prisma.payment.findMany(by),
    prisma.subscription.findMany(by),
    prisma.request.findMany({ where: { requesterUid: userId } }),
    prisma.profileChangeRequest.findMany(by),
    prisma.document.findMany({ where: { uploadedById: userId }, select: { title: true, fileName: true, createdAt: true } as any }),
    prisma.userSession.findMany({ where: { userId }, select: { platform: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, revokedAt: true } }),
    prisma.loginEvent.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 500, select: { method: true, outcome: true, ip: true, userAgent: true, createdAt: true } }),
    prisma.contentReport.findMany({ where: { reporterId: userId }, select: { targetType: true, reason: true, note: true, status: true, createdAt: true } }),
    prisma.userRestriction.findMany({ where: { userId }, select: { kind: true, reason: true, until: true, createdAt: true, liftedAt: true } }),
    prisma.userBlock.findMany({ where: { blockerId: userId }, select: { blockedId: true, createdAt: true } }),
  ]);

  return {
    about: "This is a copy of the information Academicall holds about you. Vault files are listed by name only; open them in the app.",
    exportedAt: new Date().toISOString(),
    account,
    enrollments, materialSaves, timetable, notifications,
    studyGroups: { memberships: groupMemberships, messagesSent: groupMessages },
    news: { comments: newsComments },
    aspirant: { choices: aspirations, houseThreads, houseReplies },
    utmePractice: utmeAttempts,
    results,
    tests: testAttempts.map((t) => ({ test: t.test.title, status: t.status, score: t.score, correct: t.correct, total: t.total, startedAt: t.startedAt, submittedAt: t.submittedAt })),
    vault: { folders: vaultFolders, files: vaultFiles },
    payments: { claims: paymentClaims, payments, subscriptions },
    requests: { general: requests, profileChanges },
    uploads,
    security: { devices: sessions, signIns: logins },
    safety: { reportsYouMade: reports, restrictionsOnYou: restrictions, peopleYouBlocked: blocks },
  };
}
