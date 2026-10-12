"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const department_controller_1 = require("../controllers/department.controller");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.post("/join", auth_1.authenticate, department_controller_1.requestJoin);
router.get("/me", auth_1.authenticate, department_controller_1.myMembership);
router.get("/members", auth_1.authenticate, department_controller_1.listMembers);
router.post("/members/:id/admit", auth_1.authenticate, department_controller_1.admitMember);
router.post("/members/:id/reject", auth_1.authenticate, department_controller_1.rejectMember);
router.post("/members/:id/withdraw-request", auth_1.authenticate, department_controller_1.requestWithdraw);
router.post("/members/:id/withdraw-review", auth_1.authenticate, auth_1.requireStaff, department_controller_1.reviewWithdraw);
exports.default = router;
//# sourceMappingURL=department.routes.js.map