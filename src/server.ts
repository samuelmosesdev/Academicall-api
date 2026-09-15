import "dotenv/config";
import app from "./app";

const port = Number(process.env.PORT) || 4000;

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Academicall API listening on 0.0.0.0:${port}`);
  console.log(`Health: http://0.0.0.0:${port}/api/v1/health`);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
})
