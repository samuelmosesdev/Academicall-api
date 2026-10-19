import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import routes from "./routes";

const app = express();
const configuredOrigins = process.env.CORS_ORIGIN?.split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const allowedOrigins = [
  ...new Set([
    "https://academicall.site",
    "https://academicall.pages.dev",
    "https://localhost",
    ...(configuredOrigins || []),
  ]),
];
const isLocalOrigin = (origin: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const isLocalDevelopmentOrigin = (origin: string) =>
  isLocalOrigin(origin) && origin !== "https://localhost";
const isAllowedOrigin = (origin: string | undefined) => {
  if (!origin) return true;
  if (process.env.NODE_ENV !== "production") {
    return isLocalOrigin(origin) || allowedOrigins.includes(origin);
  }
  return (
    origin === "https://localhost" ||
    (!isLocalDevelopmentOrigin(origin) && allowedOrigins.includes(origin))
  );
};

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  return next();
});
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
// UTME bulk question uploads can be bigger than ordinary requests
const bulkJson = express.json({ limit: "8mb" });
app.use((req, res, next) => (/^\/api\/v1\/admin\/(utme\/questions\/[a-z0-9-]+\/bulk|tests(\/[0-9a-f-]+)?)$/.test(req.path) ? bulkJson(req, res, next) : next()));
app.use(
  express.json({
    limit: "2mb",
    // Paystack (and similar webhook) signatures are computed over the raw
    // request body, so we stash it here instead of re-serializing req.body.
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use("/api/v1", routes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    res.status(err.status || 500).json({
      error: err.message || "Internal server error",
    });
  }
);

export default app;
