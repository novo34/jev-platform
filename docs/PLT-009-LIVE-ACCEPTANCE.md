# PLT-009 — live provider acceptance (deployment-independent)

**Canonical baseline:** check the current `jev-platform/main` HEAD and the latest Foundation `main` before recording acceptance; do not treat an older SHA in this document as canonical.

**State:** OpenAI and DeepSeek **health checks** were observed as `ok: true` in the operator's local UI on 2026-10-12. They are not proof of a charged generation or persisted cost. PR #15 added the executable, explicitly authorized *development-only* paid-call harness and was merged as `88151347d7d7846efdeed74fa72be32869aba075`. **LIVE_PAID_CALL_ACCEPTANCE=PENDING.** No production/deployment approval follows from this checklist.

## Preconditions and secret-safe setup

1. Use a dedicated nonproduction organization, scoped project/task and credentials. Keep tokens, provider API keys, encryption key and database URLs out of chat, GitHub, screenshots, logs and shell history.
2. Use the isolated local PostgreSQL instance with migrations through `0020_model_gateway.sql`. Never run `seed:dev` against a live environment. The paid acceptance harness actively rejects non-loopback DB URLs and requires `NODE_ENV=development`.
3. Set the **original** `JEV_SECRET_ENCRYPTION_KEY` as a process environment variable without logging it, and prepare `DATABASE_URL` without embedding credentials in a command line or shell history. For Windows PowerShell, use interactive `Read-Host -AsSecureString` for each sensitive value, convert in memory to the environment variable, and clear the temporary variables. For bash, use `read -rs` into an environment variable without echoing it or adding credentials to any shell command; avoid tracing (`set -x`). Never paste the real URL as a literal in `export DATABASE_URL=...`.
4. Explicitly verify input/output pricing in CHF for each selected provider/model and set `JEV_MODEL_PRICING_JSON`; put a small **external** account-level spending cap in place. The application-level hard budget (PLT-017) is not a substitute yet and is not claimed as present.
5. Use existing UUIDs for an organization, project and task that belong together. The operator must be authorized to use that local environment. The harness is an operator CLI, **not** an authenticated production API route.

## Evidence procedure (no secrets or provider content)

- [x] Operator-observed UI health check: DeepSeek `ok: true` (369ms), OpenAI `ok: true` (2176ms). Record these only as connectivity evidence; dates may be taken from the operator session.
- [ ] Record current `main` commit and successful CI/review for the executable harness and this document.
- [ ] Confirm configured provider credentials through the local UI's **Settings → Providers**. `GET /providers` must expose metadata only.
- [ ] Prepare local environment variables for **one explicit provider at a time**: `JEV_ACCEPT_ORGANIZATION_ID`, `JEV_ACCEPT_PROJECT_ID`, `JEV_ACCEPT_TASK_ID`, `JEV_ACCEPT_PROVIDER` (`openai` or `deepseek`), `JEV_ACCEPT_MODEL`, `JEV_MODEL_PRICING_JSON`, `DATABASE_URL`, and `JEV_SECRET_ENCRYPTION_KEY`. Prices must be sourced from current provider rates converted to CHF; don't guess rates.
- [ ] **Only with the operator's explicit approval for a paid request** set `JEV_LIVE_PROVIDER_ACCEPTANCE=I_AUTHORIZE_ONE_PAID_CALL` and run `npm run accept:gateway -w @jev/api` exactly once per provider. The script invokes `ModelGateway.execute` for a fixed harmless prompt with no fallback, `maxRetries=0`, 16 maximum output tokens and a 15-second timeout. Do not run without a verified external spending cap.
- [ ] Confirm the output reports `persistedCall: true` and `persistedCostEvent: true` with `requestId`, provider/model, normalized usage and estimated CHF cost. The harness queries scoped `model_provider_calls` and `cost_events`, matching the embedded `usage.requestId`, three token counts, CHF currency and exact amount. It does **not** rely on a creation-time window.
- [ ] Confirm a negative cross-organization test with distinct authorized identities, checking that no credential, model call or cost leakage is possible. Use deterministic local/integration tests; do not deliberately trigger extra real paid calls for negative scenarios.
- [ ] Verify bounded retries and fallback via deterministic tests only. Run `npm run check` and preserve sanitized CI/security-review evidence.
- [ ] **Mandatory teardown before approval:** remove *dedicated acceptance credentials* using the authenticated ADMIN `DELETE /providers/openai/credential` and `DELETE /providers/deepseek/credential` routes; revoke/rotate the provider-side test keys; stop local processes, clear sensitive process environment variables and securely destroy the isolated disposable test database if applicable. Do not delete the user's long-lived personal/provider credentials unless they were specifically created for this disposable acceptance environment and authorized for removal. Record sanitized teardown confirmation.
- [ ] Only after every check and teardown succeeds, submit the evidence to issue #12 and propose changing Foundation PLT-009 to `DONE` through a reviewed PR. Otherwise retain `IN_PROGRESS`.

## Deployment boundary

Server rollout, restricted production PostgreSQL credentials, rollback and production smoke tests remain separately tracked under deployment gate #11. This checklist does not waive them or require the user's Windows computer to remain powered on while GitHub engineering proceeds.

## Failure rule

Any failed paid call, persistence/correlation check, tenancy test or teardown remains **BLOCKED** with sanitized evidence. Never infer paid acceptance from provider health or automated mock-backed tests.

**References:** `docs/PLT-009-PAID-CALL-HARNESS.md`, `docs/MODEL_GATEWAY.md`, issue #12, deployment issue #11 and Foundation `backlog/jev-master-tasks.yaml`.
