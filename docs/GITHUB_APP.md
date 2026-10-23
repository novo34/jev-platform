# PLT-010 — GitHub App integration

Status: implementation under technical validation on PR #23. **Not accepted / not DONE.**
Automated tests use real PostgreSQL and a real browser, but simulate GitHub HTTP.
Only real installation and guarded operations in an explicitly authorized test
repository can satisfy functional acceptance.

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

    {"trustedReviewerIds":[<verified GitHub numeric reviewer ID>],"requiredChecks":[{"name":"<required check name>","appId":<verified check App ID>}]}

Values must come from the actual repository's reviewers/check runs; example IDs
in .env.example are placeholders. Login names are labels, never authorization IDs.
Checks must cover the exact head SHA, be complete, and succeed for their configured
App IDs. Review history is paginated with a bounded fail-closed limit.

The latest effective approval must be from a configured independent GitHub user,
on the exact head, and not from any real writer recorded for the task. App-authored
PRs do not hide the underlying human implementer. Changes requested block merge.
A persisted non-stale human JEV approval must match the same task, commit and PR URL.
The final current role must still be ADMIN. GitHub receives the approved SHA and
squash method without any bypass flags; external branch protections still apply.

Every PR commit must match a SUCCESS GITHUB_WRITE_FILE commit recorded for the
same tenant/project/repository/task. Unrecorded direct pushes and PRs reaching
GitHub's 250-commit listing limit fail closed. Human writers are taken from the
ledger, not inferred from the App bot's PR authorship.

GitHub must also enforce the policy atomically at merge. The App reads classic
branch protection with Administration **read-only**; it never changes settings.
Require strict checks with the configured check App IDs; PR approval count >=1;
dismiss stale approvals; CODEOWNER approval; approval of the most recent push;
enforce administrators; disallow force pushes/deletions; and no PR bypass actors.
REST bypass allowances may be omitted; in that case a read-only GraphQL query
must return an explicit zero bypass allowances on the matching branch protection
rule, with no errors. Null, hidden or unknown protection state denies merge. Ruleset-only repositories
are not accepted by this deliberately narrow protection profile.

The base branch's .github/CODEOWNERS must contain one global rule, for example
`* @actual-independent-reviewer` (actual account chosen by the operator), plus
optional blank/comment lines. Each owner must resolve to a configured trusted
numeric GitHub ID, have repository write access, and be neither a task writer nor
the PR author. GitHub's CODEOWNERS errors endpoint must return no errors. This
makes GitHub enforce independent approval even if a previously observed approval
is dismissed before the merge call. Teams and overriding path rules are denied.

A COMMENTED Codex review or an arbitrary caller boolean is **not** an APPROVED
review. Configure a genuine independent approving reviewer for the live merge
test; never whitelist the implementer or fabricate approval evidence.
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

- Require a pull request, at least one approval, dismiss stale approvals, require
  CODEOWNER review, and require approval of the most recent reviewable push.
- Require the configured checks from their actual GitHub App sources, and require
  branches to be up to date. Record check names and numeric App IDs in merge policy.
- Do not allow bypassing protections (including administrators); no PR bypass
  users, teams or Apps; no force pushes or branch deletion.
- A valid base .github/CODEOWNERS global rule naming only trusted independent
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

## Real acceptance procedure — not yet executed

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
8. Obtain successful actual configured CI checks and an independent APPROVED review
   on the final head. Advance the task through the existing verified/review lifecycle
   and persist the exact human approval via createApproval. Do not forge verified=true
   as a substitute for the independent review or required staging evidence.
9. Only with specific authorization for that test merge, invoke GITHUB_MERGE_PR.
   First prove stale head/approval, missing checks and self-review are denied.
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

GitHub HTTP/API responses in automated suites are simulated. No real App
installation, staged App deployment or authorized merge acceptance has run.
Exact published commit, Actions results and final SHA-bound independent review
are recorded in PR #23. These technical checks do not mark PLT-010 DONE.
