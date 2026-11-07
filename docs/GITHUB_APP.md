# PLT-010 — GitHub App integration

Status: functional acceptance and canonical closure completed on 2026-10-23.
[Platform PR #23](https://github.com/novo34/jev-platform/pull/23) merged as
`f86aa98107527edb27dc837882f0a9fed82ed654`; Foundation closure merged as
`209cf728d4aea9a71af52d948a33a4db309112ac`. The canonical backlog records
**PLT-010 DONE**; **PLT-011 remains TODO** and requires separate authorization.
Post-closure security remediation is described below and was not present in
the original acceptance. Automated suites use real PostgreSQL and a real
browser with simulated GitHub HTTP; the live evidence separately covers the
actual App and explicitly authorized repository operations.

## Architecture and scope

The existing flow is preserved: authenticated API → ControlService → project/tenant
authorization → installation/operation policy → GitHubAppClient → GitHub.
There is no additional workspace package, alternative authorizer or separate project
model. Organization, repository, task, approval and audit records remain canonical.

GitHub App calls use RS256 JWTs (RSA ≥2048 bits; backdated issuance, ≤10 minutes)
and fresh temporary installation tokens scoped to exactly one repository and the
permissions needed by each operation. Tokens and OAuth credentials are never
returned by application operations, cached persistently, audited or logged.
Requests use a fixed HTTPS GitHub origin, refuse redirects and time out after
15 seconds. There are no automatic mutation retries.

All product actions go through POST /api/control/commands behind the existing
proxy. Direct API hosting omits the /api prefix. This increment supports human
sessions; it does not implement future agent runtime, workspace, staging engine,
promotion or dashboard backlog tasks.

## Installation and identity

1. An authenticated ADMIN selects a registered project/repository and starts
   START_GITHUB_INSTALLATION in the existing Settings → GitHub App panel.
2. The backend creates a 32-byte random state, stores only its hash, binds it to
   the exact organization/project/repository/user/session, and sets a host-only
   Secure, HttpOnly, SameSite=Lax cookie with a ten-minute lifetime.
3. GitHub's Setup callback supplies installation_id. The server validates state
   and cookie, then starts the separate OAuth user authorization step.
4. The code callback consumes state once before exchange. The server verifies the
   GitHub user ID, repository ADMIN permission, user access to that installation,
   App installation identity/suspension, and actual repository-scoped App access.
5. Session, role, tenant, repository identity and the authorization deadline are
   revalidated before binding. An installation cannot move between JEV organizations.
   The final transaction records the linkage and append-only audit.
6. CONNECT_GITHUB_IDENTITY reuses OAuth/state handling for scoped developers and
   project managers without granting permission to install or bind repositories.
   Account identity is immutable by GitHub numeric ID; reconnecting can update
   its login label, but cannot substitute another account.

Both authorization steps are audited. Expiration uses current wall-clock time,
including after lock waits and before final persistence. Expired, manipulated,
replayed, revoked-session and cross-organization attempts fail closed.
Browser callbacks return a static return-to-JEV page; API clients receive JSON.
The browser can sign in again after returning; its login token is not persisted
in browser storage by this integration.

The API omits query strings from logs and redacts authorization/cookie headers.
The staging proxy logs method, URI without query, status, bytes and duration.
Only callback-specific Nginx diagnostic errors are suppressed because they include
the original OAuth query; sanitized API audit and proxy status/timing remain.

## Operations and guards

Every command supplies projectId and targetId (the canonical repository UUID).
Mutation payloads identify a canonical task; callers cannot provide a branch.
The branch is task.branch_name or the deterministic feat/jev-TASK_UUID.
Shared legacy branch assignments, main/master, ref aliases, and canonical
production/staging branch targets are rejected.

| Action | Payload | Required permission |
| --- | --- | --- |
| GITHUB_READ_REPOSITORY | {} | project:read |
| GITHUB_CREATE_BRANCH | {taskId} | project:write |
| GITHUB_WRITE_FILE | {taskId,path,content,message,previousBlobSha?} | project:write |
| GITHUB_CREATE_PR | {taskId,title,body} | project:write |
| GITHUB_READ_PR | {number} | project:read |
| GITHUB_READ_CHECKS | {sha} | project:read |
| GITHUB_READ_REVIEWS | {number} | project:read |
| GITHUB_MERGE_PR | {taskId,number,approvedSha} | project:admin plus current ADMIN role |

Code writes require RUNNING; merge requires APPROVED. Verified GitHub identities
are required for writers. The existing controlled project lock serializes operations
with lifecycle/approval/staging writers. The narrow audited
jev_lock_actor_authorization helper then locks user and membership rows before
session locks; concurrent role/status changes or membership/user deletion wait
until the mutation transaction finishes. It grants no UPDATE on authorization tables. Active session, role and membership are
rechecked after the lock and after token issuance, immediately before mutation.
A missing GitHub configuration fails with 503; denied actions return 403, malformed
input 400, command conflicts 409, and GitHub rate limits 429 with bounded retry hints.

File writes create real commits using GitHub's contents API; previousBlobSha provides
optimistic concurrency for replacement. PR targets come from the registered
production branch. The App is not granted permission to create repositories,
administer settings or modify workflow files requiring the Workflows permission.

### Idempotency and uncertain outcomes

The operation ledger binds organization + commandId to actor, repository, task,
action and a canonical input hash. Reservation and authorization audit are atomic.
SUCCESS returns the persisted result without repeating a write. Definitive denials
or pre-send failures are FAILED and may be explicitly retried with the same input.
PENDING or UNKNOWN never trigger an automatic retry. A timeout, connection loss,
or malformed response after a possible mutation requires reconciliation first.

For UNKNOWN/PENDING, inspect the exact repository branch/file blob/PR/merge and
match its identifiers to the ledger and audit. An authorized operator must record
reconciliation evidence before retrying or administratively correcting a ledger
entry. Never invent SUCCESS, remove audit history, or rerun an entire workflow
with fresh command IDs merely to bypass a conflict. There is no automatic recovery
endpoint that guesses the outcome.

### Merge policy

Merge stays disabled unless JEV_GITHUB_MERGE_POLICY is explicitly configured:

    {"approvalMode":"single_operator","requiredChecks":[{"name":"<required check name>","appId":<verified check App ID>}]}

Check names and App IDs must come from the actual repository's check runs;
example IDs in .env.example are placeholders.
Checks must cover the exact head SHA, be complete, and succeed for their configured
App IDs. Review history is paginated with a bounded fail-closed limit.

The operator explicitly chose single-operator operation on 2026-10-23: there is
no second human reviewer and no second GitHub account is required. This mode is
selected only in server configuration, never by command payload. It does not
require a GitHub APPROVED review or CODEOWNERS approval. Technical verification
remains independent of implementation through the existing verification lifecycle;
Codex review is technical evidence, not a fabricated second human approval.
Effective CHANGES_REQUESTED reviews still block merge.
A persisted non-stale human JEV approval must match the same task, commit and PR URL.
The final current role must still be ADMIN. GitHub receives the approved SHA and
squash method without any bypass flags; external branch protections still apply.

Every PR commit must match a SUCCESS GITHUB_WRITE_FILE commit recorded for the
same tenant/project/repository/task. Unrecorded direct pushes and PRs reaching
GitHub's 250-commit listing limit fail closed. Human writers are taken from the
ledger, not inferred from the App bot's PR authorship.

GitHub must also enforce the policy atomically at merge. The App reads classic
branch protection with Administration **read-only**; it never changes settings.
Require a PR with approval count zero, CODEOWNER review disabled and last-push
approval disabled for single-operator operation. Require strict checks with the
configured check App IDs; enforce administrators; disallow force pushes/deletions;
and permit no PR bypass actors. A missing PR requirement blocks merge.
REST bypass allowances may be omitted; in that case a read-only GraphQL query
must return an explicit zero bypass allowances on the matching branch protection
rule, with no errors. Null, hidden or unknown protection state denies merge. Ruleset-only repositories
are not accepted by this deliberately narrow protection profile.

The existing independent-review mode remains supported for other installations:
configure `trustedReviewerIds` instead of `approvalMode: "single_operator"`.
It still requires an independent GitHub approval on the exact head, excluding all
recorded writers and the PR author, approval count >=1, stale-review dismissal,
CODEOWNER review and last-push approval. Its base .github/CODEOWNERS must contain one global rule, for example
`* @actual-independent-reviewer` (actual account chosen by the operator), plus
optional blank/comment lines. Each owner must resolve to a configured trusted
numeric GitHub ID, have repository write access, and be neither a task writer nor
the PR author. GitHub's CODEOWNERS errors endpoint must return no errors. This
makes GitHub enforce independent approval even if a previously observed approval
is dismissed before the merge call. Teams and overriding path rules are denied.

A COMMENTED Codex review is not a GitHub APPROVED review. Single-operator mode
does not need such a review; independent-review mode still does. Neither mode
accepts caller booleans as approval, fabricated evidence or protection bypasses.
A successful GitHub merge does not mark a task DONE or deploy production.
Promotion remains PLT-013; no PLT-011 work is included.

## Exact GitHub App configuration

Repository source for the staging domain: deploy/staging/README.md.
Read-only HTTPS observation on 2026-10-22: https://jev.nuvurent.com/api/health
returned HTTP 200. This is liveness only, not acceptance, deployment authorization,
or evidence that the unpublished callback exists on the running server.

Create the App in GitHub, **not on Hostinger**:
https://github.com/settings/apps/new under the authorized owning account.

| Setting | Value |
| --- | --- |
| App name | Proposed: JEV novo34 staging; use the actual unique name/slug GitHub accepts |
| Homepage URL | https://jev.nuvurent.com |
| User authorization callback URL | https://jev.nuvurent.com/api/integrations/github/callback |
| Setup URL | https://jev.nuvurent.com/api/integrations/github/callback |
| Request user authorization during installation | OFF — this implementation performs OAuth after Setup |
| Expire user authorization tokens | ON |
| Webhook active / events | OFF / none; this integration does not depend on webhook delivery |
| Repository Contents | Read and write |
| Repository Pull requests | Read and write |
| Repository Actions | Read-only |
| Repository Commit statuses | Read-only |
| Repository Checks | Read-only |
| Repository Metadata | Read-only, automatically required |
| Organization/account permissions | None |
| Repository Administration | Read-only, solely to inspect complete classic branch protection |
| Workflows and other repository permissions | None |

Commit statuses is a separate permission from Checks. Reading the combined
`/commits/{sha}/status` endpoint requires `statuses: read`; Contents read does not
grant it. Existing installations must accept this additional read-only permission
before the checks operation can issue a token with the complete required scope.

For the current novo34 staging scope, restrict installation to the owning account
and **Only select repositories**. Install only on the explicitly authorized
acceptance repository. Registering, installing or changing an existing App and
deploying the staging SHA require the operator's specific authorization.
Do not use an official production repository as a disposable target without
explicit approval.

## Acceptance repository protection prerequisites

Before authorizing the real test merge, inspect the acceptance repository's
Settings → Branches → classic branch protection for its canonical default branch.
Preserve all stronger existing protections. The profile must enforce:

- For the explicitly selected single-operator mode, require a pull request but
  disable required approving reviews, CODEOWNER review and last-push approval.
  Existing independent-review installations retain their stricter review profile.
- Require the configured checks from their actual GitHub App sources, and require
  branches to be up to date. Record check names and numeric App IDs in merge policy.
- Do not allow bypassing protections (including administrators); no PR bypass
  users, teams or Apps; no force pushes or branch deletion.
- Only for independent-review mode: a valid base .github/CODEOWNERS global rule naming only trusted independent
  reviewer accounts with repository write permission. Use actual verified numeric
  IDs in JEV_GITHUB_MERGE_POLICY. GitHub must report no CODEOWNERS errors.

Configuration changes to the real repository require specific operator approval;
this implementation does not perform them. An unsupported ruleset-only profile,
missing inspection permission or an unknown bypass result blocks merge. GitHub
Administration **read** is needed only for inspection; never grant write or add
this App to a bypass list to make a test pass.

## Secrets and staging configuration

Standalone API configuration uses all six values together:

- JEV_GITHUB_APP_ID: actual numeric App ID.
- JEV_GITHUB_APP_SLUG: actual GitHub slug.
- JEV_GITHUB_CLIENT_ID: actual App client ID.
- JEV_GITHUB_CLIENT_SECRET: protected secret injection.
- JEV_GITHUB_APP_PRIVATE_KEY_FILE: securely mounted PEM file, readable by API only.
- JEV_GITHUB_CALLBACK_URL: exact public callback above.
- JEV_GITHUB_MERGE_POLICY: optional trusted policy JSON; absent means merge denied.

No App ID, key or client secret is currently configured in the task executor.
Never send private keys, passwords or tokens in chat, Git, issue bodies or logs.

For the existing staging Compose stack, use the opt-in overlay
deploy/staging/github-app.compose.yml with docker-compose.staging.yml.
It injects GitHub configuration and mounts the key **only into api**.
Worker, migrator, web image and PostgreSQL receive no GitHub credentials.

Configure the protected Compose-specific environment in Dokploy with
JEV_STAGING_GITHUB_APP_ID, JEV_STAGING_GITHUB_APP_SLUG,
JEV_STAGING_GITHUB_CLIENT_ID, JEV_STAGING_GITHUB_CLIENT_SECRET,
JEV_STAGING_GITHUB_CALLBACK_URL, JEV_STAGING_GITHUB_PRIVATE_KEY_FILE and,
only when ready, JEV_STAGING_GITHUB_MERGE_POLICY. The last file variable is the
actual protected host PEM path. For local file-backed Compose secrets, provision
the source readable only by the API container's UID 1000 (e.g. owner UID 1000,
mode 0400); Compose file secrets do not reliably remap uid/mode attributes.

Review configuration without printing secret values:

    docker compose -f docker-compose.staging.yml -f deploy/staging/github-app.compose.yml config --quiet

After explicit deployment approval, select the audited PR SHA and the two Compose
files in the existing Dokploy staging service. Do not deploy from an unreviewed
moving branch, use the development Compose, publish DB ports, weaken branch
protections, or expose keys to workspaces. Issue #11 remains the production gate.
This task has not deployed or changed Hostinger/Dokploy.

Rotate keys by generating a replacement in GitHub, replacing protected configuration,
then authorizing an API restart and verifying scoped access before revoking the old
key. Keys are read on API startup; editing the file alone does not reload the key.

## Real acceptance procedure and coverage

1. Authorize the exact staging SHA, a controlled test repository, and App installation.
   Confirm TLS, private PostgreSQL 16, restricted jev_runtime and rollback prerequisites.
2. Run numbered migrations and the existing runtime ACL provisioning through the
   authorized staging procedure. Never use a schema-owner credential in API/worker.
3. Register the test project/repository and prepare a RUNNING task through the
   existing ProjectRegistryService / WorkOrderService contracts. Record their UUIDs.
   These services, not ad-hoc parallel tables, remain authoritative.
4. Sign in at https://jev.nuvurent.com. In Settings → GitHub App enter those canonical
   project/repository IDs and choose Install/link. Complete GitHub selection and
   user OAuth. Verify final success, persisted linkage, numeric identity and audit.
5. Connect each writer's identity using the second button. Confirm another tenant,
   missing state/cookie, replay, expired state and revoked session are rejected.
6. From an authenticated API client, POST /api/control/commands using the table above:
   create the task branch, write a harmless acceptance file, create a PR, and read
   its checks and reviews. Record actual installation ID, branch, commit and PR URL.
   Authentication secrets belong in the client's secure store, never logs or chat.
7. Record main/master SHA before and after denied direct-branch/extra-payload attempts.
   Confirm no primary-branch change and real denied audit. Repeat a successful commandId
   and prove the same result with no duplicate write; verify scope/permission denials.
8. Obtain successful actual configured CI checks and independent technical verification
   on the final head. Single-operator mode does not require a second human GitHub review.
   Advance the task through the existing verified/review lifecycle
   and persist the exact human approval via createApproval. Do not forge verified=true
   as a substitute for independent technical verification or required staging evidence.
9. Only with specific authorization for that test merge, invoke GITHUB_MERGE_PR.
   First prove stale head/approval and missing checks are denied. Single-operator
   acceptance must also prove that absent GitHub reviews are allowed only after
   valid canonical approval; default independent-review mode still rejects self-review.
   Then verify the approved SHA merged through GitHub and the canonical audit.
   Do not mark the task DONE or deploy by setting a boolean.
10. Persist sanitized evidence for all four canonical acceptance criteria, final
    commit/CI/review references and human sign-off. Reconcile Foundation only after
    acceptance; until then PLT-010 remains open and PLT-011 must not start.

The optional npm run accept:github-readonly diagnostic observes App installation
and temporary-token repository access only. It uses externally injected App
credentials and performs no writes. Its PARTIAL result is not install-flow,
ControlService, CI, review or merge acceptance.

## Technical checks and hygiene

npm run check performs workspace type checks, PostgreSQL-backed tests, native
transport tests, production builds and a real Chromium/Chrome UI regression suite.
A browser must exist (JEV_BROWSER_EXECUTABLE may select it); no browser test is skipped.
GitHub and API responses are simulated in the UI suite and GitHub HTTP is simulated
in backend tests. No standalone lint command exists in the canonical Platform
baseline; git diff --check supplements compiler/tests, not a fictional lint PASS.

Source grounding and trace: SPEC REQ-GIT-001..014, Foundation github/engine-contract,
Development Control Gate and skills 25/26/28/30/36/37/41/44/90/91/92.
Reuse decisions: extend existing control/API/settings; reuse authorizeProject,
canonical registry/lifecycle/approval records and controlled project locking.
Central recordAudit was moved once into audit.ts and removed from service.ts;
repository-name validation is shared by installation and transport.
Added production dependency: pinned Zod for untrusted input validation.
Added test-only dependency: pinned playwright-core using installed Chrome/Chromium.
The existing Vitest chain was updated only to remedy audited test dependency
vulnerabilities, with the complete regression required afterward.
No old implementation, compatibility shim or temporary prototype is retained.


### Consolidated validation evidence — 2026-10-22 UTC

- Complete local `npm run check`: PASS — workspace type checks/builds,
  186 source cases, 21 native transport cases and 4 real Chromium UI cases.
  Final focused control regression: 57/57 PASS, including the additional
  pre-lock membership-revocation denial (187 distinct workspace source cases).
- Complete restricted production API/Worker smoke on real PostgreSQL 16 and
  Node 22.23.3 (matching CI): PASS — 24 migrations, 8 source-pinned helpers,
  4/4 privilege checks. Includes 24 CHECK-drift negative cases and concurrent
  role/status/membership/user-delete authorization regressions.
- `npm audit --json`: zero vulnerabilities in every severity.
- Canonical Foundation repository-hygiene scan, scoped to Platform
  apps/packages/scripts/deploy plus .mjs and excluding generated dist/coverage:
  PASS, no findings, zero allowlist entries. `git diff --check`: PASS.
- Changed-file credential-pattern scan: no private-key bodies or GitHub/provider
  tokens. Consumer/independent review covers reuse, authorization and removal of
  provisional code; no parallel integration implementation is retained.

Fresh disposable fixtures apply migrations from zero; no published migration or
production ledger is rewritten. The release verifier includes all eight GitHub
CHECK constraints with exact PostgreSQL 16 expressions and the narrow eighth
actor-lock helper with explicit ACL/source parity. Existing writer, trigger,
column privilege and executable-code controls remain enforced. Process smoke
failures expose only static error codes, never raw child logs or credential URLs.

GitHub HTTP/API responses in automated suites are simulated. The separate real
acceptance below was executed after these historical technical checks. Exact
published commits, Actions results and independent technical review references
are recorded in PR #23. Technical checks alone do not mark PLT-010 DONE.

## Real functional acceptance evidence — 2026-10-23 UTC

The operator authorized a separate staging App, the existing test repository,
staging deployment, and each actual merge. The final application code deployed
was `0882b4c661a2bd6a92bcf895cb1417981fcd565e`; its complete
[Platform CI run 40007656907](https://github.com/novo34/jev-platform/actions/runs/40007656907)
passed all four jobs, including PostgreSQL-backed authorization/protection
regressions, Compose, production image builds and staging runtime smoke.
Workspace type checks and all 25 native transport cases passed. A separate
read-only technical reviewer verified the five published changed-file hashes
and found no P0/P1/P2 findings for the single-operator increment.

### Canonical functional criteria

| Criterion | Observed real evidence |
| --- | --- |
| App installation flow works | `JEV-novo34-staging`, App ID `5440682`, installation `174485693`, registered repository `novo34/SaSS_Workee` (GitHub ID `1095303181`); Setup/OAuth completed in the browser. Canonical repository installation and immutable user identity `novo34` / `17856013` were persisted and queried. |
| Temporary installation tokens are used | Actual token-issuance responses were HTTP 201 and subsequent repository-scoped reads/writes succeeded. The client requests fresh single-repository, operation-specific tokens; exact permission/expiry/scope behavior is additionally covered by native tests. No token values are recorded here. |
| Branch, commit, PR, checks and merge obey guards | Real authenticated JEV control commands created task branches, wrote the three-line acceptance artifact, opened PRs, read real checks/reviews, replayed identical command IDs, and merged only after canonical human approval. Final accepted task/PR/SHAs and audit results are below. |
| Direct main/master writes are prevented | Real caller-supplied `branch: main` was rejected with HTTP 400. Protected `main` requires PRs and strict App-bound checks, includes administrators and disallows bypass, force pushes and deletion. The App's runtime diagnostic verified all seven protection/policy conditions. Native/PostgreSQL tests additionally exercise main/master and protected-task-branch denials. Main changed only through the explicitly authorized setup and guarded acceptance merges. |

### Setup and observed corrections

- Real acceptance found GitHub's `temp_clone_token` in a raw repository response.
  Fixes `ed69efaf1feefd5f98d3b2c06d230e0ab4e9012f` and
  `49e37734cfa275502f885dae30a2c3774ceca5fb` added deep public response
  allowlists. Post-deploy JEV repository reads returned only `id`, `full_name`
  and `default_branch`. PR/check/workflow/review regressions cover nested fields.
- The real combined-status endpoint returned HTTP 403 with the requirement
  `statuses=read`. Fix `1a81ddc019e537a63a79063385790630c3523a4e` requests
  that distinct read-only permission. After the operator accepted the existing
  installation's permission update, token issuance and all three observation
  endpoints returned success, including through the authenticated JEV API.
- The operator explicitly changed the second-human-review requirement to
  `single_operator`. Independent technical verification and canonical human
  authorization remain mandatory; no alternate account was presented as an
  independent person. Legacy independent-review mode retains its old guards.
- The operator made the acceptance repository public and configured classic
  protection for `main`: PR required, review count zero, CODEOWNER/last-push
  approval off, strict `jev-acceptance` from GitHub Actions App `15368`, enforce
  administrators, no bypass/force/deletion. The actual App read confirmed all
  conditions, including explicit zero bypass allowances.
- Separately authorized [setup PR #2](https://github.com/novo34/SaSS_Workee/pull/2)
  added only the read-only CI workflow and merged as
  `67338a6b031473929492eb676ba3bcf11b8e6a38`. Setup CI
  [40010118063](https://github.com/novo34/SaSS_Workee/actions/runs/40010118063)
  checked syntax of 122 tracked PHP files. This setup merge is not itself
  evidence of the JEV guarded merge.

### Final guarded acceptance

- Canonical task: `2575365c-4b8c-4e4f-b427-812c21d18b39`.
- Task branch: `feat/jev-2575365c-4b8c-4e4f-b427-812c21d18b39`, created from
  the configured base `67338a6b031473929492eb676ba3bcf11b8e6a38`.
- [PR #3](https://github.com/novo34/SaSS_Workee/pull/3), exact approved head:
  `b84a87da13f4a1e10b6e9e5702645443b2416d5b`. It adds only
  `.jev/acceptance/plt010-973c0e56.md`, a three-line Markdown test artifact.
- [Required CI run 40021804043](https://github.com/novo34/SaSS_Workee/actions/runs/40021804043)
  passed on that exact head, from App `15368`. Logs confirm all 122 PHP syntax
  checks and byte-exact acceptance artifact validation passed.
- [Independent technical verification](https://github.com/novo34/SaSS_Workee/pull/3#issuecomment-6374438909)
  found no P0/P1/P2 findings in the exact diff. GitHub review count was zero,
  as intended for the explicitly configured single-operator mode.
- The task advanced through the existing WorkOrderService lifecycle to
  `AWAITING_HUMAN`, recording the actual CI/review references. No staging
  environment was registered for this artifact-only acceptance repository;
  no staging deployment was invented or required evidence bypassed.
- After explicit operator authorization, canonical approval
  `4340fc33-e1c0-4b03-a353-d55799592472` was recorded using `createApproval`:
  `APPROVED`, non-stale, matching the task, exact head and PR URL.
- Before that approval, JEV merge returned HTTP 403 and persisted a
  `FAILED` / `GITHUB_FORBIDDEN` audit event. After approval, a different SHA
  was also rejected and its operation ledger remained `FAILED`.
- Authorized command `plt010-2575365c-merge-approved-01` returned
  `merged: true`, SHA `c46e305c98dd5502ccaeb88a1bcf4b6e01dee862`.
  The canonical operation ledger and merge audit both persisted `SUCCESS`.
- Independent GitHub inspection confirms PR #3 was merged by
  `jev-novo34-staging[bot]` at `2026-10-23T20:57:07Z`; protected `main`
  points to that SHA. [Post-merge CI run 40023142644](https://github.com/novo34/SaSS_Workee/actions/runs/40023142644)
  also passed. The canonical task remains `APPROVED`: merge did not mark it
  DONE or deploy production.

### Additional real denials, idempotency and limits

The earlier [PR #1](https://github.com/novo34/SaSS_Workee/pull/1) remains open
as pre-CI acceptance evidence. Identical command ID/payload replays returned the
same original branch result, commit and PR without duplicate writes. Real calls
also confirmed unauthenticated HTTP 401, unlinked repository HTTP 403, extra
branch payload HTTP 400, same write ID with changed content HTTP 409, and
revoked-session HTTP 401. These do not substitute for a separate live
cross-tenant-user test.

OAuth missing-cookie/state/expiry/replay cases, cross-tenant isolation,
concurrent revocation, stale canonical approvals and failing/misattributed
checks have automated real-PostgreSQL/simulated-GitHub regression coverage;
not every adversarial case was repeated against live GitHub. The acceptance
repository CI is syntax/artifact smoke, not full PHP application functional
testing. This work does not implement PLT-011/012/013, claim a database restore
test, deploy production or authorize other merges.

The original functional acceptance and subsequent canonical closure are complete.
The acceptance fixture Task remains APPROVED, separately from backlog PLT-010 DONE.
The deployment evidence above concerns staging; it does not establish production
deployment or authorize another merge. No next backlog task is started here.

## Post-closure audit remediation (not part of historical acceptance)

The audit confirmed that the original merge guard did not authenticate persisted
technical verification. The linked technical review comment and arbitrary
`verificationSource` JSON were historical review evidence, not a machine-enforced
independent verification credential. Migration 0025 and the signature guard below
are new controls; no old approval/report is grandfathered into merge authorization.

### Independent verifier trust and canonical evidence

No Verification Engine or verification table is introduced. The existing
WorkOrderService `transitionTask` flow records `evidence.technicalVerification`
on the **VERIFYING → VERIFIED** transition in `task_state_history`. That history
is append-only (0025); runtime has SELECT only. The later canonical human approval
remains independently mandatory. Both merge modes require the technical report;
`single_operator` still requires no second human/account/GitHub approval review.
Legacy `independent` keeps its additional eligible GitHub reviewer requirements.

The operator provisions `JEV_GITHUB_VERIFICATION_KEYS` as a JSON array of public
trust roots, e.g. `[{"keyId":"qa-v1","issuer":"independent-qa-process",
"purpose":"independent_verifier","publicKey":"<Ed25519 SPKI public PEM>"}]`.
The staging overlay passes `JEV_STAGING_GITHUB_VERIFICATION_KEYS` to the API.
This is trusted server configuration, never a command argument. Invalid keys
reject startup; absent/unrecognized/revoked keys deny merge. Key changes require
API restart. **Neither API/worker nor the implementing process may hold the
verifier private key or permission to change this configuration.** Trust-root
provisioning and genuine independent review remain operator responsibilities.
An issuer name or `purpose` string supplied by a client alone confers no trust.

The independent verifier reads the canonical task's latest VERIFYING history row
and reviews the exact PR revision. After completing its review it builds a JSON
report with these exact fields:

```json
{
  "version": 1,
  "keyId": "qa-v1",
  "issuer": "independent-qa-process",
  "organizationId": "<canonical UUID>",
  "projectId": "<canonical UUID>",
  "repositoryId": "<canonical repository UUID>",
  "taskId": "<canonical UUID>",
  "verificationCycleId": "<latest VERIFYING history UUID>",
  "repositoryFullName": "owner/repository",
  "pullRequestNumber": 3,
  "commitSha": "<40 lowercase hex characters>",
  "result": "PASS",
  "reportSha256": "<64 lowercase hex digest of the independent review artifact>",
  "issuedAt": "2026-10-23T22:00:00.000Z",
  "expiresAt": "2026-10-23T23:00:00.000Z"
}
```

Retain the review artifact in the verifier's audit store. The signature binds its
digest; JEV does not retrieve that external artifact or judge the review's quality.
On the verifier process only, serialize the report once as UTF-8 `payloadBytes`
and sign `Buffer.concat([Buffer.from("JEV/PLT-010/technical-verification/v1\n"),
payloadBytes])` using Node `crypto.sign(null, bytes, verifierPrivateKey)` (Ed25519).
Pass `{payload: payloadBytes.toString("base64url"), signature:
signatureBytes.toString("base64url")}` as `evidence.technicalVerification` through
the existing VERIFIED transition. Anyone may relay the signed envelope; they
cannot alter it or authorize another scope/revision/cycle. No private key is
sent to JEV, placed in an environment variable, committed, or mounted in the API.

The guard loads the latest VERIFIED evidence and VERIFYING cycle while holding
the existing project lock. It validates signature, trusted issuer/key, PASS,
tenant/project/repository identity/name/task/PR/SHA/cycle, issuance after that
cycle, nonfuture issuance and expiry (maximum lifetime 24h). Ambiguous same-time
cycles/reports fail closed. It repeats validation immediately before the GitHub
mutation, including expiry. Missing/forged/expired evidence denies merge even
when the human approval, GitHub reviews and checks pass. A new SHA or new cycle
requires a new signed verification and the existing current human approval.
The pre-existing project → actor/membership → session lock order is unchanged.

### SQL integrity and deployment boundary

Migration 0026 makes verified numeric GitHub IDs immutable (including tenant/user
binding), validates initial tenant scope and ledger scope, and freezes operation
scope/hash/actor/action/timestamp. New reservations start PENDING with no result.
Only PENDING → SUCCESS/FAILED/UNKNOWN and FAILED → PENDING are allowed; SUCCESS
results are immutable, UNKNOWN cannot be replayed automatically. Results exist
only on SUCCESS. Existing rows are preserved, without inventing reconciliation.
Unknown outcomes require investigation and an explicitly reviewed owner migration
to reconcile; runtime has no reconciliation bypass. API/worker retain no owner,
migrator, role membership or new SECURITY DEFINER writer privileges.

Provisioning revokes historical table and column grants before restoring INSERT
on identities/ledger, UPDATE(login,verified_at) on identities and UPDATE(status,
result) on ledger. Task history has SELECT only. Startup and the topology gate
reject broader effective ACLs; the gate verifies all 18 trigger bindings/bodies,
26 migration checksums, and the existing eight pinned definer writers.
The runtime remains trusted to report an actual HTTP response when finalizing a
PENDING operation; these SQL controls do not make a fully compromised API process
an authentic GitHub response signer. The signed independent verification is a
separate trust boundary and cannot be manufactured by runtime SQL writes.

These source changes do not apply migrations, grants, trust roots or configuration
to existing staging/production. Rollout requires separate authorization and an
independent verifier process/key under the isolation described above. Until then,
this code deliberately denies merges lacking authentic evidence; it does not claim
that a future verification module or live verifier deployment already exists.
