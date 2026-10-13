import "dotenv/config";
import app from "./app";
import { seedInstitutions } from "./lib/institutionSeed";

const port = Number(process.env.PORT) || 4000;

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Academicall API listening on 0.0.0.0:${port}`);
  console.log(`Health: http://0.0.0.0:${port}/api/v1/health`);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

if (process.env.AUTO_SEED_INSTITUTIONS !== "false") {
  setTimeout(() => {
    seedInstitutions().catch((err) => console.error("[institutions] Catalogue bootstrap failed", err));
  }, 2_000);
}

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
})
