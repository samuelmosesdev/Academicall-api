import "dotenv/config";
import { seedInstitutions } from "../lib/institutionSeed";
import { prisma } from "../lib/prisma";

seedInstitutions()
  .then((r) => console.log(r))
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
