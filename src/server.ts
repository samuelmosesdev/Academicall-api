import "dotenv/config";
import app from "./app";
import { seedInstitutions } from "./lib/institutionSeed";
import { seedCurricula } from "./lib/curriculumSeed";
import { applyInstitutionOverrides } from "./lib/institutionOverrides";
import { startPushDispatcher } from "./lib/push";

const port = Number(process.env.PORT) || 4000;

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Academicall API listening on 0.0.0.0:${port}`);
  console.log(`Health: http://0.0.0.0:${port}/api/v1/health`);
});

server.keepAliveTimeout = 65_000;

// Push notifications for new in-app notifications (off until FIREBASE_SERVICE_ACCOUNT is set)
startPushDispatcher();

// Load the bundled institution catalogue in the background (idempotent; skips existing rows).
if (process.env.AUTO_SEED_INSTITUTIONS !== "false") {
  setTimeout(() => {
    seedInstitutions()
      // catalogue corrections (curated institutions + global clean-up); versioned, a no-op once applied
      .then(() => applyInstitutionOverrides().catch((err) => console.error("[institution-overrides] failed", err)))
      .then(() => seedCurricula())
      .catch((err) => console.error("[institutions] seed failed", err));
  }, 2_000);
}
server.headersTimeout = 66_000;

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
})
