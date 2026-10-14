# PLT-009 local operator gateway acceptance

This is a **development-only**, explicitly authorized **one paid call** operator harness. It does not create tasks, seed users or perform migrations. Production deployment remains blocked by issue #11. Provider health tests alone are not gateway execution proof.

## Before invoking

1. Use an isolated, local PostgreSQL database containing an existing authorized organization/project/task and saved provider credential. Do not expose the local database port publicly.
2. Set `NODE_ENV=development`, `DATABASE_URL` (loopback URL, no query or fragment), and the **original** `JEV_SECRET_ENCRYPTION_KEY` privately, without copying secrets to tickets or logs.
3. Set `JEV_ACCEPT_ORGANIZATION_ID`, `JEV_ACCEPT_PROJECT_ID`, `JEV_ACCEPT_TASK_ID` to an existing matching scoped hierarchy. Specify `JEV_ACCEPT_PROVIDER` (`openai` or `deepseek`) and a valid model in `JEV_ACCEPT_MODEL`.
4. Set `JEV_MODEL_PRICING_JSON` to verified current CHF input/output rates keyed by `provider:model`. Incorrect pricing must not be accepted as trustworthy cost data.
5. Establish a **real external provider spend cap and account budget** before authorizing even one paid call. PLT-017 application-level hard budget enforcement is not yet implemented; this harness is not a substitute. Set `JEV_LIVE_PROVIDER_ACCEPTANCE=I_AUTHORIZE_ONE_PAID_CALL` only when the operator explicitly approves paying for a minimal request.
6. Run `npm run accept:gateway -w @jev/api` once per provider, in the same local session as the above environment variables. No arbitrary prompt input or fallback; request is the static harmless string `Reply with OK.`, limited to 16 output tokens and no retries. Do not run against production.
7. Save only sanitized outcome, provider/model, request ID, usage tokens and CHF cost and the relevant CI/review references. Verify credentials are revoked or rotated in the local test environment once acceptance is complete.

The runner makes a real call through `ModelGateway.execute`, verifies scoped `model_provider_calls` and corresponding `cost_events` persistence, and prints no provider content. The evidence query correlates the cost event using the request ID embedded in `cost_events.usage.requestId` plus the three normalized token counts, scoped organization/task/provider/model, CHF currency and identical cost amount. No timestamp heuristic is used. A future production migration should enforce request-level linkage with an explicit relational key and constraints.

Acceptance is fail-closed: the returned provider/model, one-attempt bound, token usage and estimated CHF cost must agree with the persisted provider call, and exactly one matching scoped cost event must exist. Duplicate cost evidence or mismatched metadata is a failure, not a pass.

A failed run remains **FAILED**. Do not mark PLT-009 DONE from CI-only adapters, provider health checks or a dry run.

## Never commit secrets

Do not add API keys, encryption material, database passwords or filled environment files to GitHub. The operator executes this harness locally with credentials; the GitHub CI only verifies code without making paid provider calls.
