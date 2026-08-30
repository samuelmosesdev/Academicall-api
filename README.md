# Academicall API

API-first backend for **Academicall / UofA Readers**.

Stack: **Node.js + Express + TypeScript + Prisma + PostgreSQL**

Authentication: **JWT** (email/password) with Google credential sign-in through the API.

---

## Quick start (local with Docker)

### Prerequisites
- Node.js 18+
- Docker + Docker Compose
- npm

### 1. Start PostgreSQL

```bash
docker compose up -d
```

Wait a few seconds until the container is healthy.

### 2. Configure environment

```bash
cp .env.example .env
```

The default `.env` already points at the Docker Postgres.  
You only need to change `JWT_SECRET` to something random.

### 3. Install & prepare database

```bash
npm install
npx prisma generate
npx prisma db push
```

(`db push` is fine for the first prototype. Later switch to `npx prisma migrate dev`.)

### 4. Run the API

```bash
npm run dev
```

You should see:

```

## Deploy to Railway

1. Create a Railway project with a PostgreSQL service and a service from this repository.
2. Set the API service to use the included `Dockerfile`.
3. Add `DATABASE_URL` from the Railway PostgreSQL service, plus a long random
  `JWT_SECRET`, `NODE_ENV=production`, and the deployed frontend origin as
  `CORS_ORIGIN`. For the live site, use `CORS_ORIGIN=https://academicall.site`
  (add `https://www.academicall.site` too if that hostname is enabled).
4. Configure Brevo transactional email variables on the API service:
  `BREVO_API_KEY`, `BREVO_SENDER_EMAIL=noreply@academicall.site`, and
  `BREVO_REPLY_TO_EMAIL=noreply@academicall.site`, plus optionally
  `BREVO_SENDER_NAME=Academicall`. The sender/domain must be verified in Brevo;
  do not use Brevo's `bounces-...` address as the sender.
5. Deploy and verify `/api/v1/health` returns `200`.

The container runs `prisma db push` before starting the API. Review the schema
before the first production deploy and take a database backup before future
schema changes.
Academicall API listening on http://localhost:4000
Health check: http://localhost:4000/api/v1/health
```

---

## Useful endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/health` | — | Health check |
| POST | `/api/v1/auth/register` | — | Register with email + password |
| POST | `/api/v1/auth/login` | — | Login → returns JWT |
| GET | `/api/v1/auth/me` | Bearer | Current user |
| POST | `/api/v1/auth/verification/send` | Bearer | Send a 6-digit email code |
| POST | `/api/v1/auth/verification/verify` | Bearer | Verify the email code |
| GET | `/api/v1/users` | Staff | List users |
| PATCH | `/api/v1/users/me` | Bearer | Update own profile |
| GET | `/api/v1/documents` | Bearer | List documents |
| POST | `/api/v1/documents` | Staff | Create document |
| GET | `/api/v1/courses` | Bearer | List courses |
| POST | `/api/v1/courses` | Staff | Create course |
| GET | `/api/v1/notifications` | Bearer | My notifications |
| PATCH | `/api/v1/notifications/:id/read` | Bearer | Mark as read |

All protected routes accept either:
- `Authorization: Bearer <JWT>` (from `/auth/login` or `/auth/register`)
- or a valid **Firebase ID token** (hybrid mode)

---

## Project structure

```
src/
  controllers/     # request handlers
  middleware/      # auth + role checks
  routes/          # route definitions
  lib/             # prisma client, firebase admin
  types/
prisma/
  schema.prisma    # database models
docker-compose.yml
```

---

## Next steps (recommended order)

1. Test register / login / me with curl or Postman / Thunder Client.
2. Point a small part of your React app at this API (start with `/auth/me` or documents list).
3. Add more endpoints (CBT questions, payments, staff chat, etc.) following the same pattern.
4. The one-off Firestore import is available through `npm run migrate:firestore`; runtime API traffic uses PostgreSQL only.
5. Deploy the API (Railway, Render, Fly.io, etc.) and switch the frontend permanently.

---

## Notes

- Roles match your current system: `admin`, `alphaAgent`, `agent`, `courseRep`, `user`.
- `uniqueId` can be set only once by the user.
- Soft-delete style fields exist on notifications.
- This is a solid foundation, not a full 1:1 port of every Firebase collection yet.
