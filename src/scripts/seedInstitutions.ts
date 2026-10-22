import "dotenv/config";
import { seedInstitutions } from "../lib/institutionSeed";
import { applyInstitutionOverrides } from "../lib/institutionOverrides";
import { prisma } from "../lib/prisma";

seedInstitutions()
  .then((r) => console.log(r))
  .then(() => applyInstitutionOverrides({ force: process.argv.includes("--force-overrides") }))
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
