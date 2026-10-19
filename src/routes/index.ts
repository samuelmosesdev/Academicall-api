import { Router } from "express";
import { authenticate, requireAdmin, requireStaff, requireAdminOrAlpha, requireCap } from "../middleware/auth";
import * as filesCtrl from "../controllers/files.controller";
import * as secCtrl from "../controllers/secretariat.controller";
import * as ogCtrl from "../controllers/og.controller";
import * as myCoursesCtrl from "../controllers/myCourses.controller";
import * as acadCtrl from "../controllers/academics.controller";
import * as authCtrl from "../controllers/auth.controller";
import * as usersCtrl from "../controllers/users.controller";
import * as docsCtrl from "../controllers/documents.controller";
import * as coursesCtrl from "../controllers/courses.controller";
import * as notifCtrl from "../controllers/notifications.controller";
import * as announcementsCtrl from "../controllers/announcements.controller";
import * as requestsCtrl from "../controllers/requests.controller";
import * as enrollmentsCtrl from "../controllers/enrollments.controller";
import * as activityCtrl from "../controllers/activity.controller";
import * as featureCtrl from "../controllers/feature.controller";
import * as quizzesCtrl from "../controllers/quizzes.controller";
import * as paymentsCtrl from "../controllers/payments.controller";
import departmentRoutes from "./department.routes";
import * as institutionsCtrl from "../controllers/institutions.controller";
import * as groupsCtrl from "../controllers/groups.controller";
import * as realtimeCtrl from "../controllers/realtime.controller";
import express from "express";
import { authLimits as L, rateLimit } from "../middleware/rateLimit";
import * as vaultCtrl from "../controllers/vault.controller";
import * as newsCtrl from "../controllers/news.controller";
import { feedSocial, classSocial, updateClassEvent } from "../controllers/programme.controller";
import * as aspCtrl from "../controllers/aspirant.controller";
import * as utmeCtrl from "../controllers/utme.controller";
import * as utmeAdminCtrl from "../controllers/utmeAdmin.controller";
import * as featuresCtrl from "../controllers/features.controller";
import { featureGate, maintenanceGate } from "../lib/features";
import { premiumGate } from "../lib/billing";
import * as billingCtrl from "../controllers/billing.controller";
import * as securityCtrl from "../controllers/security.controller";
import * as meCtrl from "../controllers/me.controller";
import * as modCtrl from "../controllers/moderation.controller";
import * as utmeInsightsCtrl from "../controllers/utmeInsights.controller";
import * as testsCtrl from "../controllers/tests.controller";
import * as searchCtrl from "../controllers/search.controller";
import * as dataCtrl from "../controllers/dataAdmin.controller";
import * as boardCtrl from "../controllers/board.controller";

const router = Router();
const userKey = (r: any) => String(r.user?.id || r.ip);

// Feature switches: a feature an admin discontinued answers 403 feature_off (staff keep access)
router.get("/features", featuresCtrl.publicFeatures);
// Maintenance mode: everyone but staff gets 503 while it's on
router.use(maintenanceGate);
router.use(featureGate);
const billingCheckoutLimit = rateLimit({ name: "billing-checkout", windowMs: 10 * 60_000, max: 5, key: userKey });
const billingVerifyLimit = rateLimit({ name: "billing-verify", windowMs: 10 * 60_000, max: 12, key: userKey });
router.get("/billing", billingCtrl.publicBilling);
router.post("/billing/checkout", authenticate, billingCheckoutLimit, billingCtrl.checkout);
router.get("/billing/verify/:reference", authenticate, billingVerifyLimit, billingCtrl.verify);
router.get("/admin/billing", authenticate, requireCap("settings.manage"), billingCtrl.adminBilling);
router.put("/admin/billing", authenticate, requireCap("settings.manage"), billingCtrl.saveAdminBilling);
router.put("/admin/billing/users/:id", authenticate, requireCap("payments.review"), billingCtrl.grant);
router.use(premiumGate);
router.get("/admin/features", authenticate, requireCap("settings.manage"), featuresCtrl.adminFeatures);
router.put("/admin/features/:key", authenticate, requireCap("settings.manage"), featuresCtrl.setFeature);
router.put("/admin/maintenance", authenticate, requireCap("settings.manage"), featuresCtrl.setMaintenance);
router.put("/admin/banner", authenticate, requireCap("settings.manage"), featuresCtrl.setBanner);
router.get("/admin/beta-testers", authenticate, requireCap("settings.manage"), featuresCtrl.listBetaTesters);
router.put("/admin/beta-testers/:id", authenticate, requireCap("settings.manage"), featuresCtrl.setBetaTester);

// Two-step sign-in, devices and sign-in history (self)
const twoFactorLimit = rateLimit({ name: "2fa-verify", windowMs: 15 * 60_000, max: 15, key: (r: any) => String(r.body?.challengeId || r.ip), failuresOnly: true, message: "Too many wrong codes. Wait a few minutes." });
const twoFactorSendLimit = rateLimit({ name: "2fa-send", windowMs: 15 * 60_000, max: 6, key: (r: any) => String(r.user?.id || r.body?.challengeId || r.ip), message: "Too many codes requested. Wait a few minutes." });
router.post("/auth/2fa/verify", twoFactorLimit, authCtrl.verifyTwoFactor);
router.post("/auth/2fa/resend", twoFactorSendLimit, authCtrl.resendTwoFactor);
router.get("/me/2fa", authenticate, securityCtrl.status);
router.post("/me/2fa/totp/start", authenticate, securityCtrl.totpStart);
router.post("/me/2fa/totp/confirm", authenticate, twoFactorLimit, securityCtrl.totpConfirm);
router.post("/me/2fa/email/start", authenticate, twoFactorSendLimit, securityCtrl.emailStart);
router.post("/me/2fa/email/confirm", authenticate, twoFactorLimit, securityCtrl.emailConfirm);
router.post("/me/2fa/backup-codes", authenticate, securityCtrl.regenerateBackupCodes);
router.delete("/me/2fa", authenticate, securityCtrl.disable);
router.get("/me/sessions", authenticate, securityCtrl.mySessions);
router.post("/me/sessions/sign-out-others", authenticate, securityCtrl.endOtherSessions);
router.delete("/me/sessions/:id", authenticate, securityCtrl.endMySession);
router.get("/me/logins", authenticate, securityCtrl.myLogins);
// Staff: security overview, per-person devices and 2FA reset
router.get("/admin/security", authenticate, requireCap("settings.manage"), securityCtrl.adminOverview);
router.put("/admin/security", authenticate, requireCap("settings.manage"), securityCtrl.adminSaveSettings);
router.get("/users/:id/security", authenticate, requireCap("users.password"), securityCtrl.userSecurity);
router.post("/users/:id/2fa/reset", authenticate, requireCap("users.password"), securityCtrl.resetUserTwoFactor);
router.delete("/users/:id/sessions/:sid", authenticate, requireCap("users.password"), securityCtrl.endUserSession);

// Push devices + notification preferences, privacy, blocks, CGPA, my data
router.post("/me/devices", authenticate, meCtrl.registerDevice);
router.delete("/me/devices", authenticate, meCtrl.removeDevice);
router.get("/me/notification-prefs", authenticate, meCtrl.getPrefs);
router.put("/me/notification-prefs", authenticate, meCtrl.savePrefs);
router.get("/me/privacy", authenticate, meCtrl.getPrivacy);
router.put("/me/privacy", authenticate, meCtrl.savePrivacy);
router.get("/me/blocks", authenticate, meCtrl.listBlocks);
router.post("/me/blocks/:userId", authenticate, meCtrl.block);
router.delete("/me/blocks/:userId", authenticate, meCtrl.unblock);
router.get("/me/results", authenticate, meCtrl.listResults);
router.put("/me/results/semester", authenticate, meCtrl.saveSemester);
router.delete("/me/results/semester", authenticate, meCtrl.deleteSemester);
router.put("/me/results/settings", authenticate, meCtrl.saveResultSettings);
router.get("/me/data-export", authenticate, meCtrl.downloadMyData);
router.get("/me/data-requests", authenticate, meCtrl.myDataRequests);
router.post("/me/data-requests", authenticate, meCtrl.createDataRequest);

// Reports + moderation queue
const reportLimit = rateLimit({ name: "reports", windowMs: 60_000, max: 10, key: userKey });
router.post("/reports", authenticate, reportLimit, modCtrl.createReport);
router.get("/admin/moderation/summary", authenticate, requireCap("moderation.manage"), modCtrl.summary);
router.get("/admin/moderation/reports", authenticate, requireCap("moderation.manage"), modCtrl.listReports);
router.post("/admin/moderation/reports/:id/action", authenticate, requireCap("moderation.manage"), modCtrl.actOnReport);
router.get("/admin/moderation/restrictions", authenticate, requireCap("moderation.manage"), modCtrl.listRestrictions);
router.post("/admin/moderation/restrictions/:id/lift", authenticate, requireCap("moderation.manage"), modCtrl.liftRestriction);

// Search
router.get("/search", authenticate, searchCtrl.search);

// General tests
router.get("/admin/tests", authenticate, requireCap("tests.manage"), testsCtrl.adminList);
router.post("/admin/tests", authenticate, requireCap("tests.manage"), testsCtrl.create);
router.get("/admin/tests/options", authenticate, requireCap("tests.manage"), testsCtrl.options);
router.get("/admin/tests/people", authenticate, requireCap("tests.manage"), testsCtrl.people);
router.post("/admin/tests/audience-preview", authenticate, requireCap("tests.manage"), testsCtrl.audiencePreview);
router.get("/admin/tests/:id", authenticate, requireCap("tests.manage"), testsCtrl.adminGet);
router.put("/admin/tests/:id", authenticate, requireCap("tests.manage"), testsCtrl.update);
router.post("/admin/tests/:id/publish", authenticate, requireCap("tests.manage"), testsCtrl.publish);
router.post("/admin/tests/:id/close", authenticate, requireCap("tests.manage"), testsCtrl.close);
router.post("/admin/tests/:id/reopen", authenticate, requireCap("tests.manage"), testsCtrl.reopen);
router.post("/admin/tests/:id/duplicate", authenticate, requireCap("tests.manage"), testsCtrl.duplicate);
router.delete("/admin/tests/:id", authenticate, requireCap("tests.manage"), testsCtrl.remove);
router.get("/admin/tests/:id/results", authenticate, requireCap("tests.manage"), testsCtrl.results);
router.get("/tests", authenticate, testsCtrl.myTests);
router.post("/tests/:id/start", authenticate, testsCtrl.start);
router.put("/tests/:id/answers", authenticate, testsCtrl.saveAnswers);
router.post("/tests/:id/submit", authenticate, testsCtrl.submit);
router.get("/tests/:id/result", authenticate, testsCtrl.myResult);

// Data requests + backups (admins)
router.post("/admin/backups/report", dataCtrl.reportBackup);
router.get("/admin/data-requests", authenticate, requireCap("settings.manage"), dataCtrl.listRequests);
router.patch("/admin/data-requests/:id", authenticate, requireCap("settings.manage"), dataCtrl.updateRequest);
router.get("/admin/users/:id/export", authenticate, requireCap("settings.manage"), dataCtrl.exportUser);
router.get("/admin/backups", authenticate, requireCap("settings.manage"), dataCtrl.listBackups);
router.post("/admin/backups/run", authenticate, requireCap("settings.manage"), dataCtrl.runBackup);

const vaultUnlockLimit = rateLimit({ name: "vault-unlock", windowMs: 15 * 60_000, max: 12, key: userKey, failuresOnly: true, message: "Too many PIN attempts. Wait a few minutes." });
const vaultOtpLimit = rateLimit({ name: "vault-otp", windowMs: 60 * 60_000, max: 5, key: userKey, message: "Too many reset codes requested. Try again in an hour." });
const vaultResetLimit = rateLimit({ name: "vault-reset", windowMs: 15 * 60_000, max: 8, key: userKey, failuresOnly: true });
const vaultUpload = express.raw({ type: () => true, limit: `${Math.ceil(vaultCtrl.VAULT_LIMITS.maxFileBytes / 1048576) + 1}mb` });

// Academicall Vault (PIN-locked; data routes need X-Vault-Token)
router.get("/vault/status", authenticate, vaultCtrl.status);
router.post("/vault/pin", authenticate, vaultCtrl.createPin);
router.post("/vault/unlock", authenticate, vaultUnlockLimit, vaultCtrl.unlock);
router.post("/vault/pin/change", authenticate, vaultUnlockLimit, vaultCtrl.changePin);
router.post("/vault/recovery/send", authenticate, vaultOtpLimit, vaultCtrl.sendRecovery);
router.post("/vault/recovery/reset", authenticate, vaultResetLimit, vaultCtrl.resetWithCode);
router.get("/vault/folders", authenticate, vaultCtrl.requireVault, vaultCtrl.listFolders);
router.post("/vault/folders", authenticate, vaultCtrl.requireVault, vaultCtrl.createFolder);
router.patch("/vault/folders/:id", authenticate, vaultCtrl.requireVault, vaultCtrl.updateFolder);
router.delete("/vault/folders/:id", authenticate, vaultCtrl.requireVault, vaultCtrl.deleteFolder);
router.get("/vault/folders/:id/files", authenticate, vaultCtrl.requireVault, vaultCtrl.listFiles);
router.post("/vault/folders/:id/files", authenticate, vaultCtrl.requireVault, vaultUpload, vaultCtrl.uploadFile);
router.get("/vault/files/:id/content", authenticate, vaultCtrl.requireVault, vaultCtrl.fileContent);
router.patch("/vault/files/:id", authenticate, vaultCtrl.requireVault, vaultCtrl.updateFile);
router.delete("/vault/files/:id", authenticate, vaultCtrl.requireVault, vaultCtrl.deleteFile);

// Academicall News (public reading; sign in to read in full, react and comment)
router.get("/news", newsCtrl.optionalAuth, newsCtrl.listNews);
router.get("/news/suggest", newsCtrl.suggest);
router.get("/news/for-you", authenticate, newsCtrl.forYou);
router.get("/news/subscriptions", authenticate, newsCtrl.listSubscriptions);
router.post("/news/subscriptions", authenticate, newsCtrl.subscribe);
router.patch("/news/subscriptions/prefs", authenticate, newsCtrl.subscriptionPrefs);
router.delete("/news/subscriptions/:id", authenticate, newsCtrl.unsubscribe);
// Chief News Agent: oversees every story and every News Agent
router.get("/news/chief/overview", authenticate, newsCtrl.requireNewsChief, newsCtrl.chiefOverview);
router.get("/news/chief/posts", authenticate, newsCtrl.requireNewsChief, newsCtrl.chiefPosts);
router.patch("/news/chief/posts/:id", authenticate, newsCtrl.requireNewsChief, newsCtrl.chiefModerate);
router.delete("/news/chief/posts/:id", authenticate, newsCtrl.requireNewsChief, newsCtrl.chiefDelete);
router.get("/news/chief/agents", authenticate, newsCtrl.requireNewsChief, newsCtrl.chiefAgents);
router.patch("/news/chief/agents/:id", authenticate, newsCtrl.requireNewsChief, newsCtrl.chiefSetAgent);
router.delete("/news/chief/agents/:id/duty", authenticate, newsCtrl.requireNewsChief, newsCtrl.chiefRemoveDuty);
router.get("/news/desk/posts", authenticate, newsCtrl.requireNewsDesk, newsCtrl.deskList);
router.post("/news/desk/posts", authenticate, newsCtrl.requireNewsDesk, newsCtrl.createPost);
router.patch("/news/desk/posts/:id", authenticate, newsCtrl.requireNewsDesk, newsCtrl.updatePost);
router.delete("/news/desk/posts/:id", authenticate, newsCtrl.requireNewsDesk, newsCtrl.deletePost);
router.get("/news/:id/comments", newsCtrl.optionalAuth, newsCtrl.listComments);
router.post("/news/:id/comments", authenticate, newsCtrl.addComment);
router.delete("/news/comments/:commentId", authenticate, newsCtrl.deleteComment);
router.post("/news/:id/reactions", authenticate, newsCtrl.react);
router.get("/news/:slug", newsCtrl.optionalAuth, newsCtrl.getNews);

// UTME CBT practice history (the bank itself is static in the web app)
// UTME control room: every editor endpoint is guarded by its own capability.
const utmeMediaUpload = express.raw({ type: () => true, limit: "7mb" });
router.get("/utme/patches", utmeAdminCtrl.publicPatches);
router.get("/utme/media/:id", utmeAdminCtrl.media);
router.get("/admin/utme/summary", authenticate, requireCap("utme.manage"), utmeAdminCtrl.summary);
router.get("/admin/utme/patches", authenticate, requireCap("utme.manage"), utmeAdminCtrl.listPatches);
router.get("/admin/utme/team", authenticate, requireCap("utme.manage"), utmeAdminCtrl.team);
router.post("/admin/utme/media", authenticate, requireCap("utme.manage"), utmeMediaUpload, utmeAdminCtrl.uploadMedia);
router.post("/admin/utme/questions/:slug/bulk", authenticate, requireCap("utme.manage"), utmeAdminCtrl.bulkAdd);
router.post("/admin/utme/questions/:slug", authenticate, requireCap("utme.manage"), utmeAdminCtrl.addQuestion);
router.put("/admin/utme/questions/:slug/:qid", authenticate, requireCap("utme.manage"), utmeAdminCtrl.saveQuestion);
router.delete("/admin/utme/questions/:slug/:qid", authenticate, requireCap("utme.manage"), utmeAdminCtrl.removeQuestion);
router.post("/admin/utme/questions/:slug/:qid/restore", authenticate, requireCap("utme.manage"), utmeAdminCtrl.restoreQuestion);
router.post("/admin/utme/questions/:slug/:qid/revert", authenticate, requireCap("utme.manage"), utmeAdminCtrl.revertQuestion);
router.get("/utme/insights", authenticate, utmeInsightsCtrl.insights);
router.put("/utme/goals", authenticate, meCtrl.saveUtmeGoals);
router.post("/utme/reports", authenticate, utmeInsightsCtrl.reportQuestion);
router.get("/admin/utme/reports", authenticate, requireCap("utme.manage"), utmeInsightsCtrl.listReports);
router.post("/admin/utme/reports/resolve", authenticate, requireCap("utme.manage"), utmeInsightsCtrl.resolveReports);
router.get("/admin/utme/stats", authenticate, requireCap("utme.manage"), utmeInsightsCtrl.stats);
router.get("/utme/attempts", authenticate, utmeCtrl.listAttempts);
router.post("/utme/attempts", authenticate, utmeCtrl.saveAttempt);
router.get("/utme/attempts/:id", authenticate, utmeCtrl.getAttempt);
router.delete("/utme/attempts/:id", authenticate, utmeCtrl.deleteAttempt);

// Aspirants: institutions of choice
router.get("/aspirant/me", authenticate, aspCtrl.getMe);
router.put("/aspirant/me", authenticate, aspCtrl.saveMe);
router.post("/aspirant/me/admitted", authenticate, aspCtrl.markAdmitted);
// Aspirant Houses (members read + reply; House Leaders start threads, pin, mention and manage members)
router.get("/houses", authenticate, aspCtrl.myHouses);
router.get("/houses/:id", authenticate, aspCtrl.getHouse);
router.post("/houses/:id/read", authenticate, aspCtrl.markRead);
router.get("/houses/:id/threads", authenticate, aspCtrl.listThreads);
router.post("/houses/:id/threads", authenticate, aspCtrl.createThread);
router.get("/houses/:id/threads/:threadId", authenticate, aspCtrl.getThread);
router.patch("/houses/:id/threads/:threadId", authenticate, aspCtrl.updateThread);
router.delete("/houses/:id/threads/:threadId", authenticate, aspCtrl.deleteThread);
router.post("/houses/:id/threads/:threadId/replies", authenticate, aspCtrl.addReply);
router.delete("/houses/:id/replies/:replyId", authenticate, aspCtrl.deleteReply);
router.get("/houses/:id/members", authenticate, aspCtrl.listMembers);
router.patch("/houses/:id/members/:userId", authenticate, aspCtrl.setMemberStatus);
// Admin: aspirants + houses
router.get("/admin/aspirants", authenticate, requireCap("aspirants.view", "aspirants.manage"), aspCtrl.adminListAspirants);
router.get("/admin/aspirants/:id", authenticate, requireCap("aspirants.view", "aspirants.manage"), aspCtrl.adminGetAspirant);
router.patch("/admin/aspirants/:id", authenticate, requireCap("aspirants.manage"), aspCtrl.adminUpdateAspirant);
router.get("/admin/houses", authenticate, requireCap("houses.manage", "users.houseLeader"), aspCtrl.adminListHouses);
router.post("/admin/houses", authenticate, requireCap("houses.manage"), aspCtrl.adminCreateHouse);
router.get("/admin/houses/leader-candidates", authenticate, requireCap("users.houseLeader"), aspCtrl.leaderCandidates);
router.patch("/admin/houses/:id", authenticate, requireCap("houses.manage"), aspCtrl.adminUpdateHouse);
router.post("/admin/houses/:id/leaders", authenticate, requireCap("users.houseLeader"), aspCtrl.addLeader);
router.delete("/admin/houses/:id/leaders/:userId", authenticate, requireCap("users.houseLeader"), aspCtrl.removeLeader);
// Student dashboard board (curated by admins and agents with board.manage)
router.get("/board", authenticate, boardCtrl.getBoard);
router.get("/admin/board", authenticate, requireCap("board.manage"), boardCtrl.adminBoard);
router.post("/admin/board/slides", authenticate, requireCap("board.manage"), boardCtrl.createSlide);
router.patch("/admin/board/slides/:id", authenticate, requireCap("board.manage"), boardCtrl.updateSlide);
router.delete("/admin/board/slides/:id", authenticate, requireCap("board.manage"), boardCtrl.deleteSlide);
router.post("/admin/board/reorder", authenticate, requireCap("board.manage"), boardCtrl.reorder);
router.put("/admin/board/settings", authenticate, requireCap("board.manage"), boardCtrl.saveSettings);

// Link previews (public; read by the Firebase Hosting function ogPage)
router.get("/og/meta", ogCtrl.meta);
router.get(["/og/image/default.png", "/og/image/default.jpg"], ogCtrl.defaultImage);
router.get(["/og/image/default-:kind.png", "/og/image/default-:kind.jpg"], ogCtrl.defaultImage);
router.get("/og/image/news/:slug", ogCtrl.newsImage);
router.get("/og/image/study/:code", ogCtrl.studyImage);

// Health
router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "academicall-api", time: new Date().toISOString() });
});

// Paystack webhook (public — verified via signature, not JWT)
router.post("/payments/webhook/paystack", paymentsCtrl.paystackWebhook);

// Auth (public)
router.post("/auth/register", L.register, authCtrl.register);
router.post("/auth/login", L.loginPerIp, L.loginPerAccount, authCtrl.login);
router.post("/auth/password/change", authenticate, L.passwordChange, authCtrl.changePassword);
router.post("/auth/password-reset/request", L.resetRequestPerIp, L.resetRequestPerEmail, authCtrl.requestPasswordReset);
router.post("/auth/password-reset/confirm", L.resetConfirm, authCtrl.confirmPasswordReset);
router.post("/auth/google", L.google, authCtrl.googleLogin);
router.get("/auth/me", authenticate, authCtrl.me);
router.post("/auth/verification/send", authenticate, L.verifySend, authCtrl.sendVerification);
router.post("/auth/verification/verify", authenticate, L.verifyCheck, authCtrl.verifyEmail);

// Users
router.get("/users/me", authenticate, authCtrl.me);
router.patch("/users/me", authenticate, usersCtrl.updateMe);
router.get("/users", authenticate, requireStaff, usersCtrl.listUsers);
router.get("/users/course-rep-status", authenticate, usersCtrl.courseRepStatus);
router.post("/users/agents", authenticate, requireCap("staff.manage"), usersCtrl.createAgent);
router.get("/users/:id", authenticate, requireCap("users.view"), usersCtrl.getUser);
router.patch("/users/:id", authenticate, requireStaff, usersCtrl.adminUpdateUser); // field-level checks inside
router.put("/users/:id/access", authenticate, requireStaff, usersCtrl.updateAccess);
router.post("/users/:id/reset-password", authenticate, requireCap("users.password"), usersCtrl.adminResetPassword);
router.post("/users/:id/force-password-change", authenticate, requireCap("users.password"), usersCtrl.forcePasswordChange);
router.post("/users/:id/sign-out", authenticate, requireCap("users.password"), usersCtrl.revokeSessions);
router.delete("/users/:id", authenticate, requireCap("users.delete"), usersCtrl.deleteUser);

// Staff access control
router.get("/access/catalog", authenticate, requireStaff, usersCtrl.accessCatalog);
router.get("/access/staff", authenticate, requireCap("staff.manage", "users.view"), usersCtrl.listStaffAccess);

// Document Center (every upload, restorable)
router.get("/files/summary", authenticate, requireCap("files.center"), filesCtrl.summary);
router.get("/files/materials", authenticate, requireCap("files.center"), filesCtrl.listMaterials);
router.post("/files/materials/:id/restore", authenticate, requireCap("files.center"), requireCap("documents.manage"), filesCtrl.restoreMaterial);
router.post("/files/materials/:id/status", authenticate, requireCap("files.center"), requireCap("documents.review"), filesCtrl.setMaterialStatus);
router.delete("/files/materials/:id", authenticate, requireCap("files.center"), requireCap("documents.manage"), filesCtrl.removeMaterial);
router.get("/files/group", authenticate, requireCap("files.center"), filesCtrl.listGroupFiles);
router.post("/files/group/:id/restore", authenticate, requireCap("files.center"), filesCtrl.restoreGroupFile);
router.get("/files/vault", authenticate, requireCap("vault.recover"), filesCtrl.vaultUsers);
router.get("/files/vault/:userId", authenticate, requireCap("vault.recover"), filesCtrl.vaultUserFiles);
router.post("/files/vault/:userId/unlock", authenticate, requireCap("vault.recover"), filesCtrl.unlockVault);
router.post("/files/vault-files/:id/restore", authenticate, requireCap("vault.recover"), filesCtrl.restoreVaultFile);
router.post("/files/vault-files/:id/open", authenticate, requireCap("vault.recover"), filesCtrl.openVaultFile);

// Secretariat
router.get("/secretariat/overview", authenticate, secCtrl.requireSecretariat, secCtrl.overview);
router.get("/secretariat/records", authenticate, secCtrl.requireSecretariat, secCtrl.listRecords);
router.post("/secretariat/records", authenticate, secCtrl.requireSecretariat, secCtrl.createRecord);
router.get("/secretariat/records/:id", authenticate, secCtrl.requireSecretariat, secCtrl.getRecord);
router.patch("/secretariat/records/:id", authenticate, secCtrl.requireSecretariat, secCtrl.updateRecord);
router.delete("/secretariat/records/:id", authenticate, secCtrl.requireSecretariat, secCtrl.deleteRecord);
router.get("/secretariat/activity", authenticate, secCtrl.requireSecretariat, secCtrl.activityJournal);

// Documents
router.get("/documents", authenticate, docsCtrl.listDocuments);
router.get("/documents/:id", authenticate, docsCtrl.getDocument);
router.post("/documents", authenticate, docsCtrl.createDocument);
router.patch("/documents/:id", authenticate, docsCtrl.updateDocument);
router.post("/documents/:id/approve", authenticate, requireCap("documents.review"), docsCtrl.approveDocument);
router.delete("/documents/:id", authenticate, docsCtrl.deleteDocument);

// Announcements and approval requests
router.get("/announcements", authenticate, announcementsCtrl.listAnnouncements);
router.get("/announcements/reads", authenticate, announcementsCtrl.listAnnouncementReads);
router.post("/announcements/:id/read", authenticate, announcementsCtrl.markAnnouncementRead);
router.post("/announcements", authenticate, requireCap("announcements.publish"), announcementsCtrl.createAnnouncement);
router.patch("/announcements/:id", authenticate, requireCap("announcements.publish"), announcementsCtrl.updateAnnouncement);
router.delete("/announcements/:id", authenticate, requireCap("announcements.publish"), announcementsCtrl.deleteAnnouncement);
router.get("/requests", authenticate, requestsCtrl.listRequests);
router.post("/requests", authenticate, requestsCtrl.createRequest);
router.patch("/requests/:id", authenticate, requireCap("requests.review"), requestsCtrl.updateRequest);
router.get("/profile-change-requests", authenticate, requestsCtrl.listProfileChangeRequests);
router.post("/profile-change-requests", authenticate, requestsCtrl.createProfileChangeRequest);
router.patch("/profile-change-requests/:id", authenticate, requireCap("requests.review"), requestsCtrl.updateProfileChangeRequest);
router.delete("/profile-change-requests/:id", authenticate, requireCap("requests.review"), requestsCtrl.deleteProfileChangeRequest);

// Courses
router.get("/courses", authenticate, coursesCtrl.listCourses);
router.get("/courses/:id", authenticate, coursesCtrl.getCourse);
router.post("/courses", authenticate, requireCap("courses.manage"), coursesCtrl.createCourse);
// A student's own course list + suggestions from their programme's curricula
router.get("/me/courses", authenticate, myCoursesCtrl.getMyCourses);
router.get("/me/courses/suggestions", authenticate, myCoursesCtrl.getSuggestions);
router.post("/me/courses", authenticate, myCoursesCtrl.addMyCourse);
router.post("/me/courses/bulk", authenticate, myCoursesCtrl.addMyCoursesBulk);
router.delete("/me/courses/:id", authenticate, myCoursesCtrl.removeMyCourse);
router.get("/catalog/courses", authenticate, myCoursesCtrl.searchCatalog);
router.get("/enrollments", authenticate, enrollmentsCtrl.listEnrollments);
router.post("/enrollments", authenticate, enrollmentsCtrl.createEnrollment);
router.patch("/enrollments/:id", authenticate, enrollmentsCtrl.updateEnrollment);
router.delete("/enrollments/:id", authenticate, enrollmentsCtrl.deleteEnrollment);
router.get("/activity", authenticate, requireCap("activity.view"), activityCtrl.listActivity);
router.post("/activity", authenticate, activityCtrl.createActivity);
router.post("/activity/:id/revert", authenticate, requireAdminOrAlpha, requireCap("activity.view"), activityCtrl.revertActivity);
router.get("/questions", authenticate, featureCtrl.listQuestions);
router.post("/questions", authenticate, requireCap("cbt.manage"), featureCtrl.createQuestion);
router.post("/questions/from-material", authenticate, featureCtrl.createQuestionFromMaterial);
router.patch("/questions/:id", authenticate, requireCap("cbt.manage"), featureCtrl.updateQuestion);
router.delete("/questions/:id", authenticate, requireCap("cbt.manage"), featureCtrl.deleteQuestion);
router.get("/quizzes/mine", authenticate, quizzesCtrl.listMine);
router.get("/quizzes", authenticate, quizzesCtrl.listByMaterial);
router.post("/quizzes", authenticate, quizzesCtrl.createQuiz);
router.get("/quizzes/:id", authenticate, quizzesCtrl.getQuiz);
router.patch("/quizzes/:id", authenticate, quizzesCtrl.updateQuiz);
router.get("/timetable", authenticate, featureCtrl.listEvents);
router.post("/timetable", authenticate, featureCtrl.createEvent);
router.patch("/timetable/:id", authenticate, featureCtrl.updateEvent);
router.delete("/timetable/:id", authenticate, featureCtrl.deleteEvent);
router.get("/class-events", authenticate, featureCtrl.listClassEvents);
router.post("/class-events", authenticate, featureCtrl.createClassEvent);
router.patch("/class-events/:id", authenticate, updateClassEvent);
router.delete("/class-events/:id", authenticate, featureCtrl.deleteClassEvent);
router.post("/class-events/:id/comments", authenticate, classSocial.addComment);
router.delete("/class-events/:id/comments/:commentId", authenticate, classSocial.deleteComment);
router.post("/class-events/:id/reactions", authenticate, classSocial.react);
router.post("/class-events/:id/comments/:commentId/reactions", authenticate, classSocial.reactComment);
router.get("/feed/:kind", authenticate, featureCtrl.listFeedPosts);
router.post("/feed/:kind", authenticate, featureCtrl.createFeedPost);
router.patch("/feed/:kind/:id", authenticate, featureCtrl.updateFeedPost);
router.delete("/feed/:kind/:id", authenticate, requireCap("feeds.moderate"), featureCtrl.deleteFeedPost);
router.post("/feed/:kind/:id/comments", authenticate, feedSocial.addComment);
router.delete("/feed/:kind/:id/comments/:commentId", authenticate, feedSocial.deleteComment);
router.post("/feed/:kind/:id/reactions", authenticate, feedSocial.react);
router.post("/feed/:kind/:id/comments/:commentId/reactions", authenticate, feedSocial.reactComment);
router.get("/material-saves", authenticate, featureCtrl.listMaterialSaves);
router.post("/material-saves", authenticate, featureCtrl.createMaterialSave);
router.delete("/material-saves/:id", authenticate, featureCtrl.deleteMaterialSave);
router.get("/payments/claims", authenticate, featureCtrl.listClaims);
router.get("/subscriptions/count", authenticate, requireStaff, featureCtrl.subscriptionCount);
router.post("/payments/claims", authenticate, featureCtrl.createClaim);
router.patch("/payments/claims/:id/approve", authenticate, requireCap("payments.review"), featureCtrl.approveClaim);
router.get("/settings/:key", authenticate, featureCtrl.getSetting);
router.put("/settings/:key", authenticate, requireCap("settings.manage"), featureCtrl.updateSetting);
router.get("/chat", authenticate, requireStaff, featureCtrl.listChat);
router.post("/chat", authenticate, requireStaff, featureCtrl.createChat);
router.patch("/chat/:id", authenticate, requireStaff, featureCtrl.updateChat);
router.patch("/courses/:id", authenticate, requireCap("courses.manage"), coursesCtrl.updateCourse);
router.delete("/courses/:id", authenticate, requireAdmin, coursesCtrl.deleteCourse);

// Notifications
router.get("/notifications", authenticate, notifCtrl.listMyNotifications);
router.get("/notifications/admin", authenticate, requireStaff, notifCtrl.listAdminNotifications);
router.patch("/notifications/:id/read", authenticate, notifCtrl.markRead);
router.post("/notifications/admin/mark-all-read", authenticate, requireStaff, notifCtrl.markAllAdminRead);
router.patch("/notifications/:id/archive", authenticate, notifCtrl.archiveNotification);
router.post("/notifications", authenticate, notifCtrl.createNotification);
router.post("/notifications/device-token", authenticate, notifCtrl.registerDeviceToken);
router.put("/notifications/device-token", authenticate, notifCtrl.registerDeviceToken);
router.delete("/notifications/device-token", authenticate, notifCtrl.removeDeviceToken);
router.post("/notifications/fcm-token", authenticate, notifCtrl.registerFcmToken);
router.put("/notifications/fcm-token", authenticate, notifCtrl.registerFcmToken);
router.delete("/notifications/fcm-token", authenticate, notifCtrl.removeFcmToken);

router.use("/department", departmentRoutes);

// Real-time stream (Server-Sent Events)
router.get("/realtime/stream", authenticate, realtimeCtrl.stream);

// Institutions → faculties → departments → programmes (public reads: needed before profile setup)
router.get("/institutions", institutionsCtrl.listInstitutions);
router.get("/institutions/:id", institutionsCtrl.getInstitution);
router.get("/institutions/:id/tree", institutionsCtrl.getInstitutionTree);
router.post("/institutions", authenticate, requireAdmin, institutionsCtrl.createInstitution);
router.post("/institutions/:id/faculties", authenticate, requireAdmin, institutionsCtrl.createFaculty);
router.post("/faculties/:id/departments", authenticate, requireAdmin, institutionsCtrl.createDepartment);
router.post("/academic-departments/:id/programs", authenticate, requireAdmin, institutionsCtrl.createProgram);

// Admin: academic structure + course catalogue
const acad = [authenticate, requireCap("academics.manage")];
router.get("/admin/academics/summary", ...acad, acadCtrl.summary);
router.get("/admin/academics/institutions", ...acad, acadCtrl.listInstitutions);
router.post("/admin/academics/institutions", ...acad, acadCtrl.createInstitution);
router.get("/admin/academics/institutions/:id", ...acad, acadCtrl.getInstitution);
router.patch("/admin/academics/institutions/:id", ...acad, acadCtrl.updateInstitution);
router.delete("/admin/academics/institutions/:id", ...acad, acadCtrl.deleteInstitution);
router.get("/admin/academics/institutions/:id/faculties", ...acad, acadCtrl.listFaculties);
router.post("/admin/academics/institutions/:id/faculties", ...acad, acadCtrl.createFaculty);
router.patch("/admin/academics/faculties/:id", ...acad, acadCtrl.updateFaculty);
router.delete("/admin/academics/faculties/:id", ...acad, acadCtrl.deleteFaculty);
router.get("/admin/academics/faculties/:id/departments", ...acad, acadCtrl.listDepartments);
router.post("/admin/academics/faculties/:id/departments", ...acad, acadCtrl.createDepartment);
router.patch("/admin/academics/departments/:id", ...acad, acadCtrl.updateDepartment);
router.delete("/admin/academics/departments/:id", ...acad, acadCtrl.deleteDepartment);
router.get("/admin/academics/departments/:id/programmes", ...acad, acadCtrl.listProgrammes);
router.post("/admin/academics/departments/:id/programmes", ...acad, acadCtrl.createProgramme);
router.get("/admin/academics/departments/:id/courses", ...acad, acadCtrl.listDepartmentCourses);
router.post("/admin/academics/departments/:id/courses", ...acad, acadCtrl.assignDepartmentCourse);
router.delete("/admin/academics/departments/:id/courses/:linkId", ...acad, acadCtrl.unassignDepartmentCourse);
router.patch("/admin/academics/programmes/:id", ...acad, acadCtrl.updateProgramme);
router.delete("/admin/academics/programmes/:id", ...acad, acadCtrl.deleteProgramme);
router.post("/admin/academics/programmes/:id/curricula", ...acad, acadCtrl.linkCurriculum);
router.delete("/admin/academics/programmes/:id/curricula/:curriculumId", ...acad, acadCtrl.unlinkCurriculum);
router.get("/admin/academics/courses", ...acad, acadCtrl.listCatalogCourses);
router.post("/admin/academics/courses", ...acad, acadCtrl.createCatalogCourse);
router.get("/admin/academics/courses/:id", ...acad, acadCtrl.getCatalogCourse);
router.patch("/admin/academics/courses/:id", ...acad, acadCtrl.updateCatalogCourse);
router.post("/admin/academics/courses/:id/archive", ...acad, acadCtrl.archiveCatalogCourse);
router.post("/admin/academics/courses/:id/restore", ...acad, acadCtrl.archiveCatalogCourse);
router.delete("/admin/academics/courses/:id", ...acad, acadCtrl.deleteCatalogCourse);
router.get("/admin/academics/curricula", ...acad, acadCtrl.listCurricula);
router.get("/admin/academics/curricula/:id", ...acad, acadCtrl.getCurriculum);
router.patch("/admin/academics/curricula/:id", ...acad, acadCtrl.updateCurriculum);

// Study groups
router.get("/groups", authenticate, groupsCtrl.listMyGroups);
router.post("/groups", authenticate, groupsCtrl.createGroup);
router.get("/groups/discover", authenticate, groupsCtrl.discoverGroups);
router.get("/groups/code/:code", authenticate, groupsCtrl.previewByCode);
router.post("/groups/code/:code/join", authenticate, groupsCtrl.joinByCode);
router.get("/groups/:id", authenticate, groupsCtrl.getGroup);
router.patch("/groups/:id", authenticate, groupsCtrl.updateGroup);
router.delete("/groups/:id", authenticate, groupsCtrl.deleteGroup);
router.delete("/groups/:id/request", authenticate, groupsCtrl.cancelJoinRequest);
router.post("/groups/:id/leave", authenticate, groupsCtrl.leaveGroup);
router.post("/groups/:id/transfer", authenticate, groupsCtrl.transferOwnership);
router.post("/groups/:id/read", authenticate, groupsCtrl.markRead);
router.post("/groups/:id/invite-scope", authenticate, groupsCtrl.inviteScope);
router.get("/groups/:id/members", authenticate, groupsCtrl.listMembers);
router.post("/groups/:id/members/:userId/review", authenticate, groupsCtrl.reviewJoin);
router.post("/groups/:id/members/:userId/role", authenticate, groupsCtrl.setMemberRole);
router.delete("/groups/:id/members/:userId", authenticate, groupsCtrl.removeMember);
router.post("/groups/:id/history-request", authenticate, groupsCtrl.requestHistory);
router.post("/groups/:id/history-requests/:userId", authenticate, groupsCtrl.reviewHistory);
router.get("/groups/:id/messages", authenticate, groupsCtrl.listMessages);
router.post("/groups/:id/messages", authenticate, groupsCtrl.sendMessage);
router.delete("/groups/:id/messages/:messageId", authenticate, groupsCtrl.deleteMessage);
router.post("/groups/:id/messages/:messageId/save", authenticate, groupsCtrl.saveMessageMaterial);

export default router;
