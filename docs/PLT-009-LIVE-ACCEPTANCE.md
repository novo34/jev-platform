# PLT-009 — live provider acceptance (deployment-independent)

**Canonical baseline:** check the current `jev-platform/main` HEAD and the latest Foundation `main` before recording acceptance; do not treat an older SHA in this document as canonical.

**State:** OpenAI and DeepSeek **health checks** were observed as `ok: true` in the operator's local UI on 2026-10-12. They are not proof of a charged generation or persisted cost. PR #15 added the executable, explicitly authorized *development-only* paid-call harness and was merged as `88151347d7d7846efdeed74fa72be32869aba075`. On 2026-10-12 only health checks were recorded, so `LIVE_PAID_CALL_ACCEPTANCE` was `PENDING` at that date. **Current: LIVE_PAID_CALL_ACCEPTANCE=ACCEPTED** (paid-call evidence of 2026-10-13; see the update below). No production/deployment approval follows from this checklist.

**Status update (2026-11-17):** Live paid-call acceptance is **ACCEPTED** (DONE), confirmed by the operator on 2026-11-17 on the evidence below, which the operator supplied; it was not re-executed in this review. The estimated CHF amounts use configured prices and are not invoices.

| Item | Evidence |
| --- | --- |
| Execution | 2026-10-13, development harness `npm run accept:gateway -w @jev/api` on local `main` at `4da1e99`, `maxOutputTokens=16`, `maxRetries=0`, no fallback, local development organization |
| DeepSeek | model `deepseek-flash`, request `3d714fb4-3801-4dfe-be7c-305245c1a8e2`, 1 attempt, tokens 34/16/50, estimated cost CHF 0.0000245, call and cost persisted in PostgreSQL: true/true. SUCCESS |
| OpenAI | model `gpt-4.1-nano`, request `f76632ed-cbc6-4bd0-876b-19c97ef95b46`, 1 attempt, tokens 11/2/13, estimated cost CHF 0.0000019, persisted: true/true. SUCCESS |
| Evidence | [Issue #12](https://github.com/novo34/jev-platform/issues/12), [comment of 2026-10-13](https://github.com/novo34/jev-platform/issues/12#issuecomment-6152023926); issue closed as completed by the operator on 2026-10-22 |
| Gateway integration CI | [Run 38158880609](https://github.com/novo34/jev-platform/actions/runs/38158880609) (2026-10-11, merge of PR #9 at `6f4b822`, SUCCESS) |
| Later CI | [Run 39810983854](https://github.com/novo34/jev-platform/actions/runs/39810983854) (2026-10-22, PR #22 head `805c57b`; validate, staging-runtime-smoke, staging-compose and staging-image-build SUCCESS) |
| Status | DONE, confirmed by the operator on 2026-11-17 |

## Preconditions and secret-safe setup

1. Use a dedicated nonproduction organization, scoped project/task and credentials. Keep tokens, provider API keys, encryption key and database URLs out of chat, GitHub, screenshots, logs and shell history.
2. Use the isolated local PostgreSQL instance with migrations through `0020_model_gateway.sql`. Never run `seed:dev` against a live environment. The paid acceptance harness actively rejects non-loopback DB URLs and requires `NODE_ENV=development`.
3. Set the **original** `JEV_SECRET_ENCRYPTION_KEY` as a process environment variable without logging it, and prepare `DATABASE_URL` without embedding credentials in a command line or shell history. For Windows PowerShell, use interactive `Read-Host -AsSecureString` for each sensitive value, convert in memory to the environment variable, and clear the temporary variables. For bash, use `read -rs` into an environment variable without echoing it or adding credentials to any shell command; avoid tracing (`set -x`). Never paste the real URL as a literal in `export DATABASE_URL=...`.
4. Explicitly verify input/output pricing in CHF for each selected provider/model, and for OpenAI/DeepSeek also the cache read rate (`cacheReadPerMillionChf`, required since PLT-052), and set `JEV_MODEL_PRICING_JSON`; put a small **external** account-level spending cap in place. The application-level hard budget (PLT-017) is not a substitute yet and is not claimed as present.
5. Use existing UUIDs for an organization, project and task that belong together. The operator must be authorized to use that local environment. The harness is an operator CLI, **not** an authenticated production API route.

## Evidence procedure (no secrets or provider content)

- [x] Operator-observed UI health check: DeepSeek `ok: true` (369ms), OpenAI `ok: true` (2176ms). Record these only as connectivity evidence; dates may be taken from the operator session.
- [ ] Record current `main` commit and successful CI/review for the executable harness and this document.
- [ ] Confirm configured provider credentials through the local UI's **Settings → Providers**. `GET /providers` must expose metadata only.
- [ ] Prepare local environment variables for **one explicit provider at a time**: `JEV_ACCEPT_ORGANIZATION_ID`, `JEV_ACCEPT_PROJECT_ID`, `JEV_ACCEPT_TASK_ID`, `JEV_ACCEPT_PROVIDER` (`openai` or `deepseek`), `JEV_ACCEPT_MODEL`, `JEV_MODEL_PRICING_JSON` (input, output and cache read rates), `DATABASE_URL`, and `JEV_SECRET_ENCRYPTION_KEY`. Prices must be sourced from current provider rates converted to CHF; don't guess rates.
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
