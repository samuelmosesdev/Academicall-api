import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: env('postgresql://academicall:academicall_secret@localhost:5432/academicall?schema=public'),
  },
});