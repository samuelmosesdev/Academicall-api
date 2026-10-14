# Academicall Vault + Academicall News

## Academicall Vault (`/dashboard/vault`)
- First visit: create a 6-digit PIN (entered twice; patterns like 123456 are refused). Stored as a bcrypt hash.
- Every visit: enter the PIN → API issues a 15-minute vault token (`X-Vault-Token`), held in memory only.
  The vault re-locks on refresh, after 5 idle minutes, or when the app has been in the background for over a minute.
- 5 wrong PINs → locked for 15 min (doubles each time, max 24 h).
- Forgot PIN → 6-digit code emailed through Brevo (10-min expiry, 60-s cooldown, 5 tries) → set a new PIN.
  Resetting or changing the PIN revokes every open vault token. Files are kept.
- Folders (name + colour), each holding photos (JPG/PNG/WEBP) and PDFs only. File type is checked from the bytes, not the name.
- Limits: 5 MB per file, 100 MB and 500 files per student, 30 folders (`VAULT_MAX_FILE_MB`, `VAULT_QUOTA_MB`).
- Files are AES-256-GCM encrypted before they're written to Postgres and only served back to their owner with a vault token
  (`Cache-Control: no-store`). They never touch Cloudinary.
- **Required in production:** `VAULT_ENCRYPTION_KEY` = 64 hex chars (`openssl rand -hex 32`). Back it up: losing it makes vault files unreadable.

## Academicall News (`/news`, `/news/:slug`, `/news/desk`)
- Public pages outside the dashboard. Anyone can browse headlines and read the opening paragraphs; the rest of the story,
  reactions and comments sit behind "Sign in to keep reading". After sign-in, readers return straight to the story.
- New role **News Agent** (`newsAgent`). Admins assign it from Users → user → "Assign as News Agent" (or the role dropdown);
  any number of people can hold it. News Agents keep their student dashboard plus a "News desk" item.
- News desk: write (headline, standfirst, category, cover photo via Cloudinary, body), save drafts, publish, edit, delete.
  Agents edit their own stories; admins can edit any. Body format: blank line = paragraph, `## ` subheading, `> ` pull quote, `**bold**`.
- Reactions: 👍 ❤️ 🔥 👏 😮, one per reader per story. Comments up to 1,000 chars, 6 per minute; readers delete their own,
  the news team moderates any.

## API
Migration `20261013200000_vault_and_news` adds `newsAgent` to `Role` and six tables. `npm start` and the API
container run `prisma migrate deploy` before serving requests; do not use `db push` to apply this production migration.

Set `VAULT_ENCRYPTION_KEY` on every API instance before enabling Vault. Generate one with
`openssl rand -hex 32` and store it in the deployment secret manager. Use the same key on all instances and back it
up securely; changing or losing it makes existing file contents permanently unreadable. Optional
`VAULT_MAX_FILE_MB` and `VAULT_QUOTA_MB` override the defaults. PIN recovery also requires the existing Brevo
configuration (`BREVO_API_KEY` and a verified `BREVO_SENDER_EMAIL`).

The API integration suite is `npm run test:integration`. It requires `ACADEMICALL_TEST_DATABASE=I_CONFIRM_DISPOSABLE`
and a `DATABASE_URL` for a dedicated database whose name includes `test`; it creates and deletes test rows.
