"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const routes_1 = __importDefault(require("./routes"));
const app = (0, express_1.default)();
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        // Always allow local Vite/dev servers (any port)
        const isLocal = !!origin &&
            /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        const configured = process.env.CORS_ORIGIN?.split(",")
            .map((item) => item.trim())
            .filter(Boolean) || [];
        // No origin (curl / mobile / same-origin) → allow
        // Localhost → allow
        // Empty CORS_ORIGIN → allow all (useful while debugging)
        // Origin is in the allow-list → allow
        if (!origin || isLocal || configured.length === 0 || configured.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error("Origin is not allowed by CORS"));
    },
    credentials: true,
}));
app.use((0, morgan_1.default)(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express_1.default.json({
    limit: "2mb",
    // Paystack (and similar webhook) signatures are computed over the raw
    // request body, so we stash it here instead of re-serializing req.body.
    verify: (req, _res, buf) => {
        req.rawBody = buf;
    },
}));
app.use("/api/v1", routes_1.default);
app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
});
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err.status || 500).json({
        error: err.message || "Internal server error",
    });
});
exports.default = app;
//# sourceMappingURL=app.js.map