# PLT-009 — live provider acceptance (deployment-independent)

**Canonical code baseline:** `jev-platform/main` at merge `6f4b822fb651dffae983e00b4d088b4e9160ad03`. Check the current `main` HEAD again before executing this checklist.

**Status:** implementation merged and CI passed; **LIVE_PROVIDER_ACCEPTANCE=PENDING**. This is not evidence of a deployed or production-ready instance.

## Preconditions

1. Use an authorized non-production JEV organization and dedicated test credentials for OpenAI and DeepSeek. Never paste keys, authentication cookies, database URLs or encryption keys into issues, PRs, logs or chat.
2. Use a local or isolated PostgreSQL database and the development instructions in `docs/DEVELOPMENT.md`. Do **not** point a development seed at an existing environment.
3. Supply `JEV_SECRET_ENCRYPTION_KEY` privately as specified in `docs/MODEL_GATEWAY.md`. Confirm migrations through `0020_model_gateway.sql` have been applied.
4. Configure explicit verified CHF pricing using `JEV_MODEL_PRICING_JSON` before any paid gateway request; enforce a small external spend cap and use harmless, non-sensitive test inputs. A successful `/providers/:provider/test` call alone does not test gateway cost persistence.
5. Confirm the test organization, project, work order and task IDs exist and are related correctly. Use only an authorized ADMIN session.

## Evidence procedure (never include secrets)

- [ ] Record exact `main` commit and passing `platform-ci` run.
- [ ] Log in to the local Web UI (`http://localhost:3000` by default), open **Settings → Providers** and configure each key. Confirm `GET /providers` reports only metadata and does not return plaintext or ciphertext.
- [ ] For each provider, invoke **Test** in the UI (backed by `POST /providers/:provider/test`). Record provider name, UTC time and sanitized success/failure code, not the response body if it contains sensitive data.
- [ ] Using the actual ModelGateway API/worker call path with a pre-existing scoped task/order/project, issue one minimal, harmless paid request per provider under verified pricing. No credentials in command-line history.
- [ ] Verify persisted `model_provider_calls`, provider/model identity, linked tenant/task/order, normalized token usage and estimated CHF cost. Check that the recorded amount is nonnegative and follows the configured input/output pricing.
- [ ] Execute a negative cross-organization access test using separate authorized test identities. Validate no credential metadata, secret, call or cost leakage.
- [ ] Verify bounded retry/fallback behavior through deterministic tests/CI, not by deliberately exhausting live provider quotas.
- [ ] Run `npm run check`; collect sanitized PASS evidence and issue links. Request independent security review for the exact candidate commit if any code changed.
- [ ] Only then propose updating Foundation `PLT-009` from `IN_PROGRESS` to `DONE` through its development-control PR and ensure both repositories remain traceable.

## Separate deployment acceptance

The actual server, restricted production PostgreSQL role, production secrets, rollback and deployment smoke belong to the existing **deployment gate issue #11**. This runbook does not waive those conditions or turn their absence into a reason to repeat already merged code.

## Failure / exit rule

Any failed provider or cross-tenant test means **BLOCKED** with the sanitized error code and evidence reference. Never claim PLT-009 fully verified or activate paid production traffic until the missing check is demonstrably satisfied.

**Tracking:** existing PLT-009 live acceptance issue; `docs/MODEL_GATEWAY.md`; `docs/DEVELOPMENT.md`; Foundation `backlog/jev-master-tasks.yaml`.
