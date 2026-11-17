# Dokploy JEV staging

- Dokploy project: JEV Platform / staging / JEV Staging (Compose from GitHub `novo34/jev-platform`, branch `main`).
- Set Compose Path to `./docker-compose.staging.yml` only after this deployment PR is merged and reviewed.
- Deploy is **not safe** using the root `./docker-compose.yml` (development-only).
- Configure secrets in Dokploy's Compose-specific protected environment, **not** shared project-wide:
  - `JEV_STAGING_DB_BOOTSTRAP_PASSWORD`: distinct private bootstrap superuser secret, stored exclusively in postgres (not API, worker or migrator).
  - `JEV_STAGING_DB_OWNER_PASSWORD`: high-entropy, unique private PostgreSQL owner password.
  - `JEV_STAGING_RUNTIME_DB_PASSWORD`: distinct high-entropy runtime role password; script percent-encodes URL special characters.
  - `JEV_STAGING_ENCRYPTION_KEY`: exactly 32 random bytes encoded as base64. Preserve this permanently with encrypted database backups.
  - `JEV_STAGING_ADMIN_PASSWORD`: unique >=16-character administrator initial password. First setup inserts admin if absent, does not overwrite an existing admin.
- Do not submit keys over plaintext HTTP. Access Dokploy admin over trusted TLS (or a protected private tunnel), and enable HTTPS for `jev.nuvurent.com` before submitting provider keys.
- Route domain `jev.nuvurent.com` to Compose service `web`, internal container port **8080**; do not publish host ports. Dokploy's existing Traefik must use `dokploy-network`.
- Postgres is private on isolated network, persistent volume `jev_staging_pgdata`. Migrator runs controlled schema migrations, provisions restricted role and initial admin before API/worker; website waits for API and Worker readiness.
- Admin login: organization `00000000-0000-4000-8000-000000000001`, email `admin@jev.local`, initial password supplied above.
- Do not change database role passwords on a running persistent volume without an explicit rotation procedure; Postgres bootstrap env variables do not reset existing database passwords.
- Never regenerate `JEV_STAGING_ENCRYPTION_KEY` when preserving database data.
- Before production promotion: independent review, image/build CI, restricted role and schema topology gate, real backup/restore evidence, TLS checks, runtime browser acceptance, separate production gates.

## Password recovery in staging

Set all three variables on the staging API to enable email delivery:

- `JEV_STAGING_RESET_ORIGIN`: the public HTTPS origin, `https://jev.nuvurent.com` for JEV Staging.
- `JEV_STAGING_RESET_FROM`: a sender on a verified Resend domain.
- `JEV_STAGING_RESET_RESEND_API_KEY`: a sending key scoped to that domain, stored in the staging secret configuration.

Keep link tracking disabled for the sending domain. The reset token is carried in the URL fragment and submitted in a POST body. All three values must be configured together. With no settings, existing sign-in remains available and recovery requests report temporary unavailability.

After the authorized deployment, request a recovery link for a staging account and check actual email delivery. Confirm the link can change the password once, rejects reuse, and revokes a previously active session. Cover expired links using a dedicated acceptance account and report the result without copying the link or credentials into logs or issue trackers.
