import { Router, type RequestHandler } from "express";
import { authenticate, requireAdmin, requireStaff, requireAdminOrAlpha } from "../middleware/auth";
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
import { classSocial, feedSocial, updateClassEvent } from "../controllers/programme.controller";
import * as quizzesCtrl from "../controllers/quizzes.controller";
import * as paymentsCtrl from "../controllers/payments.controller";
import * as groupsCtrl from "../controllers/groups.controller";
import * as institutionsCtrl from "../controllers/institutions.controller";
import * as realtimeCtrl from "../controllers/realtime.controller";
import departmentRoutes from "./department.routes";

const router = Router();
const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// Health
router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "academicall-api", time: new Date().toISOString() });
});

// Public academic catalogue (needed during profile completion).
router.get("/institutions", asyncRoute(institutionsCtrl.listInstitutions));
router.get("/institutions/:id", asyncRoute(institutionsCtrl.getInstitution));
router.get("/institutions/:id/tree", asyncRoute(institutionsCtrl.getInstitutionTree));
router.post("/institutions", authenticate, requireAdmin, asyncRoute(institutionsCtrl.createInstitution));
router.post("/institutions/:id/faculties", authenticate, requireAdmin, asyncRoute(institutionsCtrl.createFaculty));
router.post("/faculties/:id/departments", authenticate, requireAdmin, asyncRoute(institutionsCtrl.createDepartment));
router.post("/academic-departments/:id/programs", authenticate, requireAdmin, asyncRoute(institutionsCtrl.createProgram));

// Long-lived authenticated event stream. All writes remain on REST endpoints.
router.get("/realtime/stream", authenticate, asyncRoute(realtimeCtrl.stream));

// Paystack webhook (public — verified via signature, not JWT)
router.post("/payments/webhook/paystack", paymentsCtrl.paystackWebhook);

// Auth (public)
router.post("/auth/register", authCtrl.register);
router.post("/auth/login", authCtrl.login);
router.post("/auth/password/change", authenticate, authCtrl.changePassword);
router.post("/auth/password-reset/request", authCtrl.requestPasswordReset);
router.post("/auth/password-reset/confirm", authCtrl.confirmPasswordReset);
router.post("/auth/google", authCtrl.googleLogin);
router.get("/auth/me", authenticate, authCtrl.me);
router.post("/auth/verification/send", authenticate, authCtrl.sendVerification);
router.post("/auth/verification/verify", authenticate, authCtrl.verifyEmail);

// Users
router.get("/users/me", authenticate, authCtrl.me);
router.patch("/users/me", authenticate, usersCtrl.updateMe);
router.get("/users", authenticate, requireStaff, usersCtrl.listUsers);
router.get("/users/course-rep-status", authenticate, usersCtrl.courseRepStatus);
router.post("/users/agents", authenticate, requireAdmin, usersCtrl.createAgent);
router.get("/users/:id", authenticate, requireStaff, usersCtrl.getUser);
router.patch("/users/:id", authenticate, requireAdminOrAlpha, usersCtrl.adminUpdateUser);
router.post("/users/:id/reset-password", authenticate, requireAdmin, usersCtrl.adminResetPassword);
router.delete("/users/:id", authenticate, requireAdmin, usersCtrl.deleteUser);

// Documents
router.get("/documents/mine", authenticate, docsCtrl.listMyDocuments);
router.get("/documents", authenticate, docsCtrl.listDocuments);
router.get("/documents/:id", authenticate, docsCtrl.getDocument);
router.post("/documents", authenticate, docsCtrl.createDocument);
router.patch("/documents/:id", authenticate, docsCtrl.updateDocument);
router.post("/documents/:id/approve", authenticate, requireStaff, docsCtrl.approveDocument);
router.delete("/documents/:id", authenticate, docsCtrl.deleteDocument);

// Announcements and approval requests
router.get("/announcements", authenticate, announcementsCtrl.listAnnouncements);
router.get("/announcements/reads", authenticate, announcementsCtrl.listAnnouncementReads);
router.post("/announcements/:id/read", authenticate, announcementsCtrl.markAnnouncementRead);
router.post("/announcements", authenticate, announcementsCtrl.createAnnouncement);
router.patch("/announcements/:id", authenticate, requireStaff, announcementsCtrl.updateAnnouncement);
router.delete("/announcements/:id", authenticate, requireStaff, announcementsCtrl.deleteAnnouncement);
router.get("/requests", authenticate, requestsCtrl.listRequests);
router.post("/requests", authenticate, requestsCtrl.createRequest);
router.patch("/requests/:id", authenticate, requireStaff, requestsCtrl.updateRequest);
router.get("/profile-change-requests", authenticate, requestsCtrl.listProfileChangeRequests);
router.post("/profile-change-requests", authenticate, requestsCtrl.createProfileChangeRequest);
router.patch("/profile-change-requests/:id", authenticate, requireStaff, requestsCtrl.updateProfileChangeRequest);
router.delete("/profile-change-requests/:id", authenticate, requireStaff, requestsCtrl.deleteProfileChangeRequest);

// Courses
router.get("/courses", authenticate, coursesCtrl.listCourses);
router.get("/courses/:id", authenticate, coursesCtrl.getCourse);
router.post("/courses", authenticate, coursesCtrl.createCourse);
router.get("/enrollments", authenticate, enrollmentsCtrl.listEnrollments);
router.post("/enrollments", authenticate, enrollmentsCtrl.createEnrollment);
router.patch("/enrollments/:id", authenticate, enrollmentsCtrl.updateEnrollment);
router.delete("/enrollments/:id", authenticate, enrollmentsCtrl.deleteEnrollment);
router.get("/activity", authenticate, requireStaff, activityCtrl.listActivity);
router.post("/activity", authenticate, activityCtrl.createActivity);
router.post("/activity/:id/revert", authenticate, requireAdminOrAlpha, activityCtrl.revertActivity);
router.get("/questions", authenticate, featureCtrl.listQuestions);
router.post("/questions", authenticate, requireStaff, featureCtrl.createQuestion);
router.post("/questions/from-material", authenticate, featureCtrl.createQuestionFromMaterial);
router.patch("/questions/:id", authenticate, requireStaff, featureCtrl.updateQuestion);
router.delete("/questions/:id", authenticate, requireStaff, featureCtrl.deleteQuestion);
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
router.delete("/feed/:kind/:id", authenticate, requireStaff, featureCtrl.deleteFeedPost);
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
router.patch("/payments/claims/:id/approve", authenticate, requireStaff, featureCtrl.approveClaim);
router.get("/settings/:key", authenticate, featureCtrl.getSetting);
router.put("/settings/:key", authenticate, requireAdmin, featureCtrl.updateSetting);
router.get("/chat", authenticate, requireStaff, featureCtrl.listChat);
router.post("/chat", authenticate, requireStaff, featureCtrl.createChat);
router.patch("/chat/:id", authenticate, requireStaff, featureCtrl.updateChat);
router.patch("/courses/:id", authenticate, requireStaff, coursesCtrl.updateCourse);
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

router.use("/department", departmentRoutes);

export default router;
