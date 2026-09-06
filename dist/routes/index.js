"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const authCtrl = __importStar(require("../controllers/auth.controller"));
const usersCtrl = __importStar(require("../controllers/users.controller"));
const docsCtrl = __importStar(require("../controllers/documents.controller"));
const coursesCtrl = __importStar(require("../controllers/courses.controller"));
const notifCtrl = __importStar(require("../controllers/notifications.controller"));
const announcementsCtrl = __importStar(require("../controllers/announcements.controller"));
const requestsCtrl = __importStar(require("../controllers/requests.controller"));
const enrollmentsCtrl = __importStar(require("../controllers/enrollments.controller"));
const activityCtrl = __importStar(require("../controllers/activity.controller"));
const featureCtrl = __importStar(require("../controllers/feature.controller"));
const paymentsCtrl = __importStar(require("../controllers/payments.controller"));
const router = (0, express_1.Router)();
// Health
router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "academicall-api", time: new Date().toISOString() });
});
// Paystack webhook (public — verified via signature, not JWT)
router.post("/payments/webhook/paystack", paymentsCtrl.paystackWebhook);
// Auth (public)
router.post("/auth/register", authCtrl.register);
router.post("/auth/login", authCtrl.login);
router.post("/auth/password/change", auth_1.authenticate, authCtrl.changePassword);
router.post("/auth/password-reset/request", authCtrl.requestPasswordReset);
router.post("/auth/password-reset/confirm", authCtrl.confirmPasswordReset);
router.post("/auth/google", authCtrl.googleLogin);
router.get("/auth/me", auth_1.authenticate, authCtrl.me);
router.post("/auth/verification/send", auth_1.authenticate, authCtrl.sendVerification);
router.post("/auth/verification/verify", auth_1.authenticate, authCtrl.verifyEmail);
// Users
router.get("/users/me", auth_1.authenticate, authCtrl.me);
router.patch("/users/me", auth_1.authenticate, usersCtrl.updateMe);
router.get("/users", auth_1.authenticate, auth_1.requireStaff, usersCtrl.listUsers);
router.post("/users/agents", auth_1.authenticate, auth_1.requireAdmin, usersCtrl.createAgent);
router.get("/users/:id", auth_1.authenticate, auth_1.requireStaff, usersCtrl.getUser);
router.patch("/users/:id", auth_1.authenticate, auth_1.requireAdminOrAlpha, usersCtrl.adminUpdateUser);
router.delete("/users/:id", auth_1.authenticate, auth_1.requireAdmin, usersCtrl.deleteUser);
// Documents
router.get("/documents", auth_1.authenticate, docsCtrl.listDocuments);
router.get("/documents/:id", auth_1.authenticate, docsCtrl.getDocument);
router.post("/documents", auth_1.authenticate, auth_1.requireStaff, docsCtrl.createDocument);
router.patch("/documents/:id", auth_1.authenticate, docsCtrl.updateDocument);
router.delete("/documents/:id", auth_1.authenticate, docsCtrl.deleteDocument);
// Announcements and approval requests
router.get("/announcements", auth_1.authenticate, announcementsCtrl.listAnnouncements);
router.get("/announcements/reads", auth_1.authenticate, announcementsCtrl.listAnnouncementReads);
router.post("/announcements/:id/read", auth_1.authenticate, announcementsCtrl.markAnnouncementRead);
router.post("/announcements", auth_1.authenticate, auth_1.requireStaff, announcementsCtrl.createAnnouncement);
router.patch("/announcements/:id", auth_1.authenticate, auth_1.requireStaff, announcementsCtrl.updateAnnouncement);
router.delete("/announcements/:id", auth_1.authenticate, auth_1.requireStaff, announcementsCtrl.deleteAnnouncement);
router.get("/requests", auth_1.authenticate, requestsCtrl.listRequests);
router.post("/requests", auth_1.authenticate, requestsCtrl.createRequest);
router.patch("/requests/:id", auth_1.authenticate, auth_1.requireStaff, requestsCtrl.updateRequest);
router.get("/profile-change-requests", auth_1.authenticate, requestsCtrl.listProfileChangeRequests);
router.post("/profile-change-requests", auth_1.authenticate, requestsCtrl.createProfileChangeRequest);
router.patch("/profile-change-requests/:id", auth_1.authenticate, auth_1.requireStaff, requestsCtrl.updateProfileChangeRequest);
router.delete("/profile-change-requests/:id", auth_1.authenticate, auth_1.requireStaff, requestsCtrl.deleteProfileChangeRequest);
// Courses
router.get("/courses", auth_1.authenticate, coursesCtrl.listCourses);
router.get("/courses/:id", auth_1.authenticate, coursesCtrl.getCourse);
router.post("/courses", auth_1.authenticate, auth_1.requireStaff, coursesCtrl.createCourse);
router.get("/enrollments", auth_1.authenticate, enrollmentsCtrl.listEnrollments);
router.post("/enrollments", auth_1.authenticate, enrollmentsCtrl.createEnrollment);
router.patch("/enrollments/:id", auth_1.authenticate, enrollmentsCtrl.updateEnrollment);
router.delete("/enrollments/:id", auth_1.authenticate, enrollmentsCtrl.deleteEnrollment);
router.get("/activity", auth_1.authenticate, auth_1.requireStaff, activityCtrl.listActivity);
router.post("/activity", auth_1.authenticate, activityCtrl.createActivity);
router.get("/questions", auth_1.authenticate, featureCtrl.listQuestions);
router.post("/questions", auth_1.authenticate, auth_1.requireStaff, featureCtrl.createQuestion);
router.patch("/questions/:id", auth_1.authenticate, auth_1.requireStaff, featureCtrl.updateQuestion);
router.delete("/questions/:id", auth_1.authenticate, auth_1.requireStaff, featureCtrl.deleteQuestion);
router.get("/timetable", auth_1.authenticate, featureCtrl.listEvents);
router.post("/timetable", auth_1.authenticate, featureCtrl.createEvent);
router.patch("/timetable/:id", auth_1.authenticate, featureCtrl.updateEvent);
router.delete("/timetable/:id", auth_1.authenticate, featureCtrl.deleteEvent);
router.get("/class-events", auth_1.authenticate, featureCtrl.listClassEvents);
router.post("/class-events", auth_1.authenticate, featureCtrl.createClassEvent);
router.delete("/class-events/:id", auth_1.authenticate, featureCtrl.deleteClassEvent);
router.get("/feed/:kind", auth_1.authenticate, featureCtrl.listFeedPosts);
router.post("/feed/:kind", auth_1.authenticate, featureCtrl.createFeedPost);
router.patch("/feed/:kind/:id", auth_1.authenticate, featureCtrl.updateFeedPost);
router.delete("/feed/:kind/:id", auth_1.authenticate, auth_1.requireStaff, featureCtrl.deleteFeedPost);
router.get("/material-saves", auth_1.authenticate, featureCtrl.listMaterialSaves);
router.post("/material-saves", auth_1.authenticate, featureCtrl.createMaterialSave);
router.delete("/material-saves/:id", auth_1.authenticate, featureCtrl.deleteMaterialSave);
router.get("/payments/claims", auth_1.authenticate, featureCtrl.listClaims);
router.get("/subscriptions/count", auth_1.authenticate, auth_1.requireStaff, featureCtrl.subscriptionCount);
router.post("/payments/claims", auth_1.authenticate, featureCtrl.createClaim);
router.patch("/payments/claims/:id/approve", auth_1.authenticate, auth_1.requireStaff, featureCtrl.approveClaim);
router.get("/settings/:key", auth_1.authenticate, featureCtrl.getSetting);
router.put("/settings/:key", auth_1.authenticate, auth_1.requireAdmin, featureCtrl.updateSetting);
router.get("/chat", auth_1.authenticate, auth_1.requireStaff, featureCtrl.listChat);
router.post("/chat", auth_1.authenticate, auth_1.requireStaff, featureCtrl.createChat);
router.patch("/chat/:id", auth_1.authenticate, auth_1.requireStaff, featureCtrl.updateChat);
router.patch("/courses/:id", auth_1.authenticate, auth_1.requireStaff, coursesCtrl.updateCourse);
router.delete("/courses/:id", auth_1.authenticate, auth_1.requireAdmin, coursesCtrl.deleteCourse);
// Notifications
router.get("/notifications", auth_1.authenticate, notifCtrl.listMyNotifications);
router.get("/notifications/admin", auth_1.authenticate, auth_1.requireStaff, notifCtrl.listAdminNotifications);
router.patch("/notifications/:id/read", auth_1.authenticate, notifCtrl.markRead);
router.patch("/notifications/:id/archive", auth_1.authenticate, notifCtrl.archiveNotification);
router.post("/notifications", auth_1.authenticate, auth_1.requireStaff, notifCtrl.createNotification);
router.post("/notifications/device-token", auth_1.authenticate, notifCtrl.registerDeviceToken);
router.put("/notifications/device-token", auth_1.authenticate, notifCtrl.registerDeviceToken);
router.delete("/notifications/device-token", auth_1.authenticate, notifCtrl.removeDeviceToken);
router.post("/notifications/fcm-token", auth_1.authenticate, notifCtrl.registerFcmToken);
router.put("/notifications/fcm-token", auth_1.authenticate, notifCtrl.registerFcmToken);
router.delete("/notifications/fcm-token", auth_1.authenticate, notifCtrl.removeFcmToken);
exports.default = router;
//# sourceMappingURL=index.js.map