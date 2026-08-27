import "dotenv/config";
import app from "./app";
import { initFirebaseAdmin } from "./lib/firebase";

const PORT = process.env.PORT || 4000;

initFirebaseAdmin();

app.listen(PORT, () => {
  console.log(`Academicall API listening on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
});
