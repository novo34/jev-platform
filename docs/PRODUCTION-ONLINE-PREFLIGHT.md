# JEV online server — preflight and controlled rollout

**Scope:** preparation only. The server, hosting provider, OS, DNS, network access and backups are not yet verified. **Do not deploy or claim production-ready** until issue #11 gates are tested. Canonical state is current `main`; this document does not modify migration or app behavior.

## High-risk findings in current development setup

- `docker-compose.yml` is **development-only**: hardcoded `POSTGRES_USER=jev` / `POSTGRES_PASSWORD=jev`, and publishes PostgreSQL to all host interfaces on port 5432. **Never deploy this file as-is** to a public server. Never publish PostgreSQL to the internet.
- `.env.example` also includes development DB credentials and broad bind hosts; not safe as a production template.
- `apps/api/src/server.ts` and `apps/worker/src/server.ts` expose configurable listeners; restrict API/worker exposure to private networking and put browser-facing traffic behind authenticated HTTPS reverse proxy.
- The repo already contains `.github/workflows/verify-production-db.yml`, which only runs on `main` with protected `production` environment secrets; preserve those gates and never fake results.
- Local acceptance harness `npm run accept:gateway -w @jev/api` is development-only and requires loopback DB; it is **not** a production health check or deployment script.

## Before server access (GitHub work)

1. Audit dependency vulnerabilities and existing CI; do not apply major-version autofixes without tests.
2. Define distinct `migration` and restricted `runtime` PostgreSQL roles and follow the existing topology verifier. No application process may use the schema-owner account in production. Provision the migration credential **only** to a short-lived migration/verifier job, never as part of a shared environment bundle. Explicitly inspect the API and worker runtime process/container environments to confirm `MIGRATION_DATABASE_URL` and any schema-owner credential are absent; `checkDatabase()` alone does not prove secret separation.
3. Produce a production-specific, non-credentialled orchestration configuration *after* resolving the actual server constraints. Keep PostgreSQL isolated on an internal container network, persistent volume with verified restore, and deny public ingress to DB/worker.
4. Define readiness/liveness, graceful shutdown, HTTPS TLS termination, authentication/session/cookie settings, secret rotation and audit-log retention. Do not place `JEV_SECRET_ENCRYPTION_KEY` or provider keys in Git or Docker image layers. Keep a separately protected off-host recoverable copy of the **original** encryption key, isolated from database backup access. In the restore drill, confirm that a dedicated encrypted test provider credential can actually be decrypted and used in a non-paid health check; merely restoring PostgreSQL is insufficient. Never regenerate the key as a recovery shortcut.
5. Decide domain/subdomains and DNS only after the operator confirms server details; don't invent URLs or open ports preemptively.
6. Prepare a repeatable versioned deploy procedure with one-click rollback to a known-good image **and a separately tested database restore**. SQL migrations may not be reversible by switching containers.
7. Document bootstrap and restricted-role verification via protected GitHub Environment; don't expose production DB URL in logs or feature-branch CI.

## On the actual server

- Confirm OS, access path, CPU/RAM/disk, public/private IPs, firewall, Docker support and whether existing services occupy 80/443/3000–3002/5432. Confirm DNS ownership and TLS method.
- Create dedicated service identity, firewall allowlist, secret injection mechanism, encrypted **off-host/account-isolated** backup target and restore drill performed using the remote copy **and recovered original encryption key**, confirming decryption of a dedicated test credential; record retention and recovery objectives. Confirm API/worker cannot access any migration/schema-owner credentials at process or container scope.
- Test migrations with **separate** migration credential, then run the existing production DB verification workflow (issue #11) using restricted role; check audit and least privilege.
- Deploy immutable SHA/image to a protected environment; check HTTP health, auth, per-tenant authorization, provider credential lifecycle, worker queue, signed webhooks when implemented, and backward-compatible rollback.
- Run negative and smoke tests using non-production credentials before allowing paid provider traffic. Enforce spend caps and rate limits.
- Record sanitized evidence and independent review; gate production traffic until signoff.

## Environment decisions required from operator

**One detail to establish next:** exact server provider/type (VPS, dedicated, homelab), OS and access. Then confirm domain and exposed services. Do not ask the operator to paste passwords, tokens, private keys, or API secrets into the conversation.

## Acceptance boundary

Issue #11 remains **OPEN** until real restricted PostgreSQL runtime, secret isolation, actual backup/restore, rollback and production smoke have been demonstrated. PLT-009 issue #12 separately tracks live paid-call acceptance. Neither is closed by this preflight document.
