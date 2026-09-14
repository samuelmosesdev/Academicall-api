import { Router } from "express";
import {
  requestJoin,
  myMembership,
  listMembers,
  admitMember,
  rejectMember,
  requestWithdraw,
  reviewWithdraw,
} from "../controllers/department.controller";
import { authenticate, requireStaff } from "../middleware/auth";

const router = Router();

router.post("/join", authenticate, requestJoin);
router.get("/me", authenticate, myMembership);
router.get("/members", authenticate, listMembers);
router.post("/members/:id/admit", authenticate, admitMember);
router.post("/members/:id/reject", authenticate, rejectMember);
router.post("/members/:id/withdraw-request", authenticate, requestWithdraw);
router.post("/members/:id/withdraw-review", authenticate, requireStaff, reviewWithdraw);

export default router;
