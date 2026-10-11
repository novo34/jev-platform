# Local development

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- PostgreSQL available through `DATABASE_URL`

## Install

```bash
npm install
```

## Prepare local admin access

The seed is destructive to an existing local admin credential. It runs only
with `NODE_ENV=development`, an explicit `JEV_ALLOW_DEV_SEED=1` acknowledgement,
and a locally addressed PostgreSQL `DATABASE_URL` (localhost/loopback).
Do not forward a production database through a local tunnel when seeding.

```bash
export NODE_ENV=development
export JEV_ALLOW_DEV_SEED=1
export DATABASE_URL="postgresql://<local-user>:<local-password>@127.0.0.1:5432/<local-dev-db>"
```

Local test identity:

- Organization ID: `00000000-0000-4000-8000-000000000001`
- Email: `admin@jev.local`

No test password is committed to the repository. Choose one locally before seeding:

```bash
export JEV_DEV_ADMIN_PASSWORD="$(openssl rand -base64 24)"
echo "$JEV_DEV_ADMIN_PASSWORD"
npm run seed:dev
```

Use the printed value on the login screen.

## Configure the local encryption key

Provider API keys are encrypted with AES-256-GCM. Generate a 32-byte base64 master key outside the repository and export it before starting JEV:

```bash
export JEV_SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

Do not commit this value. The repository ignores `.env` files.

## Start all services

```bash
npm run dev
```

Services:

- Web UI: http://localhost:3000
- API health: http://localhost:3001/health
- Worker health: http://localhost:3002/health

Open the Web UI, sign in with the local admin above, then go to **Settings → Providers**. OpenAI and DeepSeek keys can be added, replaced, tested, or deleted there. The browser never receives the stored secret after submission.

## Validate

```bash
npm run check
```

This runs workspace type checks, PostgreSQL-backed tests and production builds for the current JEV Platform baseline.
