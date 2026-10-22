# PLT-010 GitHub App integration — in development

Capability status: **PARTIAL**. PLT-010 is not accepted or DONE.

## Existing architecture and reuse

The canonical flow remains Task → JEV policy → ControlService → transport → GitHub.
The new `GitHubAppClient` lives in the existing `@jev/control` package. It is a
bounded REST transport, not an alternate authorization service. Its caller must
resolve the persisted organization/project/repository/task scope, validate actor
permissions and record append-only audit before enabling application operations.
It is not exposed through an HTTP endpoint in this increment.

Source grounding: Foundation `github/engine-contract.yaml`, `github/README.md`,
skills 25/26/28/36/37/44/90/91/92 and canonical backlog PLT-010; Platform SPEC
REQ-GIT-001..014 and ROADMAP phase 18. Existing candidates inspected:
`packages/control`, `packages/auth`, `packages/projects`, API routes, canonical
repository/task/approval schema. Decision: EXTEND Control; REUSE existing auth,
repository and lifecycle boundaries; CREATE_NEW only the missing App transport.
Foundation Python adapters describe contracts; they do not implement the real
TypeScript Platform transport. No new workspace package or dependency is added.

## Implemented increment

- RS256 App JWT using externally supplied RSA private key, at least 2048 bits.
- Short-lived App JWT and fresh temporary installation token for each operation.
- Token issuance limited to one repository ID and operation-specific permissions;
  unexpected grants, expired/overlong tokens and repository identity mismatch fail.
- Installation lookup, repository read, task branch creation, file commits using
  optional previous blob SHA, PR creation/read, checks/status/Actions observations
  and bounded paginated review reads.
- Main/master and ref aliases cannot be used as write targets. All writable
  branches must use feat/, fix/ or chore/ and valid Git ref components.
- Fixed HTTPS GitHub origin, redirect refusal, 15-second request deadline,
  sanitized typed failures, bounded rate-limit hints and no automatic retries.
  An ambiguous write timeout must be reconciled before retrying at the control layer.
- No token persistence/cache and no returned credentials in public method results.
- No merge transport is exposed before the independent verifier/integrator and
  persisted exact-revision human approval gates are implemented.

Checks are bounded first-page observations (100 items), explicitly labelled
`observationsOnly`; they cannot authorize a merge or prove that every required
check/review passed. Review pagination fails if the bounded retrieval is exhausted.

## Automated validation

`npm run check` retains the existing type/build/PostgreSQL/regression suite.
`@jev/control` additionally runs native Node security tests after its existing
Vitest suite. The native tests use a disposable in-memory RSA key and simulated
HTTP; they are not functional acceptance against GitHub.

When dependencies cannot be installed, Node 24 type erasure can exercise this
self-contained transport only. That does not replace TypeScript checking or the
complete suite. CI must validate the exact PR HEAD before any integration.

## Optional real read-only diagnostic

Registration of a GitHub App occurs in GitHub Settings → Developer settings →
GitHub Apps, not on a VPS. The VPS will eventually host JEV and securely receive
configuration. Do not register an App with invented callback URLs: the final
callback and minimum permissions must follow the completed install flow.

After an App and disposable authorized installation exist, inject these values
through the execution environment's secure configuration; never through chat,
repository files, PR bodies or logs:

- `JEV_GITHUB_APP_ID`: numeric App ID.
- `JEV_GITHUB_APP_PRIVATE_KEY_FILE`: path to a securely mounted RSA PEM file.
- `JEV_GITHUB_TEST_INSTALLATION_ID`: disposable authorized installation ID.
- `JEV_GITHUB_TEST_REPOSITORY_ID`: explicitly authorized repository numeric ID.
- `JEV_GITHUB_TEST_REPOSITORY`: matching owner/name.

After building, `npm run accept:github-readonly` checks installation and temporary
token-backed repository access. It emits sanitized PARTIAL evidence only. It
performs no writes, merges or deployments. Even a successful diagnostic is not
PLT-010 acceptance and does not prove that an install callback is secure.

## Remaining mandatory work

1. Actual install/authorization flow, expiring one-time state, callback validation
   and proof of installation administration before tenant/project binding.
2. Persisted installation/repository linkage; live permission/repository scope
   reconciliation; suspension/revocation handling.
3. ControlService integration for all operations with authenticated server-derived
   tenant/task/role scope, idempotency, audit and sanitized error handling.
4. Independent verification and persisted exact-head approval/CI/review gates
   before any merge. Never trust caller booleans or incomplete check observations.
5. Real install/token/branch/commit/PR/check/guarded-merge acceptance in a disposable
   authorized repository, CI and independent review at final commit.
6. Foundation evidence/backlog reconciliation and required human acceptance.

Cleanup accounting: added bounded transport, tests, operator diagnostic and this
document; replaced/removed surfaces: none; no compatibility shim or dependency;
no temporary/generated output tracked. No production changes or deployment.
