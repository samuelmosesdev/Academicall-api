"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdminOrAlpha = exports.requireStaff = exports.requireAdmin = void 0;
exports.authenticate = authenticate;
exports.requireRole = requireRole;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../lib/prisma");
async function authenticate(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const token = header.slice(7);
    try {
        // 1. Try JWT first
        try {
            const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET || "dev-secret");
            const user = await prisma_1.prisma.user.findUnique({ where: { id: decoded.sub } });
            if (!user || user.status !== "active") {
                return res.status(401).json({ error: "User not found or inactive" });
            }
            req.user = {
                id: user.id,
                email: user.email,
                role: user.role,
            };
            return next();
        }
        catch {
            // The API accepts JWT credentials only.
        }
        return res.status(401).json({ error: "Invalid or expired token" });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Authentication error" });
    }
}
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthenticated" });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: "Insufficient permissions" });
        }
        next();
    };
}
exports.requireAdmin = requireRole("admin");
exports.requireStaff = requireRole("admin", "alphaAgent", "agent");
exports.requireAdminOrAlpha = requireRole("admin", "alphaAgent");
//# sourceMappingURL=auth.js.map