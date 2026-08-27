import { Router } from "express";
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

const router = Router();

// Health
router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "academicall-api", time: new Date().toISOString() });
});

// Auth (public)
router.post("/auth/register", authCtrl.register);
router.post("/auth/login", authCtrl.login);
router.get("/auth/me", authenticate, authCtrl.me);
router.post("/auth/verification/send", authenticate, authCtrl.sendVerification);
router.post("/auth/verification/verify", authenticate, authCtrl.verifyEmail);

// Users
router.get("/users/me", authenticate, authCtrl.me);
router.patch("/users/me", authenticate, usersCtrl.updateMe);
router.get("/users", authenticate, requireStaff, usersCtrl.listUsers);
router.get("/users/:id", authenticate, requireStaff, usersCtrl.getUser);
router.patch("/users/:id", authenticate, requireAdminOrAlpha, usersCtrl.adminUpdateUser);

// Documents
router.get("/documents", authenticate, docsCtrl.listDocuments);
router.get("/documents/:id", authenticate, docsCtrl.getDocument);
router.post("/documents", authenticate, requireStaff, docsCtrl.createDocument);
router.patch("/documents/:id", authenticate, docsCtrl.updateDocument);
router.delete("/documents/:id", authenticate, docsCtrl.deleteDocument);

// Announcements and approval requests
router.get("/announcements", authenticate, announcementsCtrl.listAnnouncements);
router.post("/announcements", authenticate, requireStaff, announcementsCtrl.createAnnouncement);
router.patch("/announcements/:id", authenticate, requireStaff, announcementsCtrl.updateAnnouncement);
router.delete("/announcements/:id", authenticate, requireStaff, announcementsCtrl.deleteAnnouncement);
router.get("/requests", authenticate, requestsCtrl.listRequests);
router.post("/requests", authenticate, requestsCtrl.createRequest);
router.patch("/requests/:id", authenticate, requireStaff, requestsCtrl.updateRequest);

// Courses
router.get("/courses", authenticate, coursesCtrl.listCourses);
router.get("/courses/:id", authenticate, coursesCtrl.getCourse);
router.post("/courses", authenticate, requireStaff, coursesCtrl.createCourse);
router.get("/enrollments", authenticate, enrollmentsCtrl.listEnrollments);
router.post("/enrollments", authenticate, enrollmentsCtrl.createEnrollment);
router.delete("/enrollments/:id", authenticate, enrollmentsCtrl.deleteEnrollment);
router.get("/activity", authenticate, requireStaff, activityCtrl.listActivity);
router.post("/activity", authenticate, activityCtrl.createActivity);
router.get("/questions", authenticate, featureCtrl.listQuestions);
router.post("/questions", authenticate, requireStaff, featureCtrl.createQuestion);
router.patch("/questions/:id", authenticate, requireStaff, featureCtrl.updateQuestion);
router.delete("/questions/:id", authenticate, requireStaff, featureCtrl.deleteQuestion);
router.get("/timetable", authenticate, featureCtrl.listEvents);
router.post("/timetable", authenticate, featureCtrl.createEvent);
router.patch("/timetable/:id", authenticate, featureCtrl.updateEvent);
router.delete("/timetable/:id", authenticate, featureCtrl.deleteEvent);
router.get("/payments/claims", authenticate, featureCtrl.listClaims);
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
router.patch("/notifications/:id/archive", authenticate, notifCtrl.archiveNotification);
router.post("/notifications", authenticate, requireStaff, notifCtrl.createNotification);

export default router;
