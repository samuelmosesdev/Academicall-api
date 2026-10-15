import "dotenv/config";
import { seedCurricula } from "../lib/curriculumSeed";
import { prisma } from "../lib/prisma";

seedCurricula({ force: process.argv.includes("--force") })
  .then((r) => console.log(r))
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
