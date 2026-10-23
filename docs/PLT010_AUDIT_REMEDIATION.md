# PLT-010 post-closure audit remediation

This report concerns source changes after canonical PLT-010 closure. It does not
authorize a merge, deployment, live migration, GitHub configuration change or
PLT-011 work. Foundation remains unchanged.

## Baseline and confirmed causes

The inspected remote main heads were Platform
`f86aa98107527edb27dc837882f0a9fed82ed654` and Foundation
`209cf728d4aea9a71af52d948a33a4db309112ac`.

| Finding | Baseline location | Cause and change |
| --- | --- | --- |
| P1-01 confirmed | `packages/control/src/github-operations.ts:190` | `authorizeMerge` authenticated human approval, checks and provenance, then returned in single-operator mode without authenticating persisted technical evidence. Both modes now require an independent Ed25519 report in canonical Task transition evidence, scoped to the exact verification cycle and revision. |
| P2-02 confirmed | `packages/db/security/provision-runtime-role.sql:142` | Broad UPDATE privileges permitted rewriting verified numeric identities and ledger scope/results. Column grants, immutable scope/identity/terminal result triggers, transition checks, and startup/topology validation close those paths. |
| P2-01 confirmed | `docs/GITHUB_APP.md:3` | The current status was left at pre-merge integration/closure pending. The document now records the actual merged heads and distinguishes prior staging acceptance from subsequent remediation. |

There was no canonical Verification Engine or authenticated verifier report
contract in Platform. Arbitrary `verificationSource`/transition evidence was
insufficient. The minimal extension uses existing WorkOrderService transitions
and `task_state_history`, a signed envelope and server public trust roots;
there is no new engine, verification table or privileged evidence writer.

## Reproduction against the original implementation

On PostgreSQL 16.13, before changing the merge implementation, the new negative
test `rejects merge without persisted independent technical verification` failed:

```text
AssertionError: promise resolved "{ ok: true, …(3) }" instead of rejecting
Tests 1 failed | 58 skipped (59)
```

Its fixture had a valid canonical human approval, exact head, trusted checks,
controlled commits and single-operator branch protection, but only arbitrary
verification text. The original implementation actually accepted the simulated
merge; the regression expects a denial and no merge HTTP request.

With the original provisioning SQL and before migration 0026, a transaction
switched to `jev_runtime`, successfully changed one verified GitHub numeric ID
and one SUCCESS operation's request hash, then rolled back both changes:

```text
P2_BASELINE_FORBIDDEN_MUTATIONS_SUCCEEDED: identity numeric ID and successful ledger hash
```

Both paths are now covered by real restricted-role SQL denial tests. These were
disposable local fixtures; no persistent or live database was used.

## Changed surfaces

- `github-verification.ts`: strict signed report format, operator trust roots,
  independent issuer/key authentication, exact scope/cycle/revision, PASS, expiry.
- `github-operations.ts`: canonical history lookup under the existing project
  lock and revalidation immediately before merge. Existing human approval,
  ADMIN/session, provenance, CI/App, GitHub policy and legacy review checks remain.
- API bootstrap and opt-in staging overlay: public verifier keys only; no key
  configuration defaults to successful verification.
- Forward-only migration **0025**: immutable canonical task transition history.
- Forward-only migration **0026**: immutable GitHub identity binding and operation
  scope/results, tenant consistency, explicit PENDING/SUCCESS/FAILED/UNKNOWN graph.
  Migrations 0001–0024 are unchanged; historical rows remain readable.
- Runtime and staging provisioners: revoke stale table/column grants and restore
  only permitted DML. No new SECURITY DEFINER helper or owner/bypass privilege.
- Shared startup guard and topology verifier: effective GitHub/history ACLs,
  18 audited triggers, 26 migration checksums and eight existing definer helpers.
- Real-PostgreSQL/simulated-HTTP tests and restricted-runtime SQL smoke. Owner-only
  disposable teardown in Model Gateway/Work Orders accounts for immutable history;
  no runtime constraint is disabled. Smoke ports may be isolated on a shared host.
- `GITHUB_APP.md`: corrected current status, retained historical identifiers and
  acceptance evidence, documented the new trust model and rollout boundary.

## Required controls and regression coverage

| Control | Executable evidence |
| --- | --- |
| No persisted technical verification | Dedicated negative GitHub operations test, reproduced red on baseline |
| Forgery/implementer key/tampering/untrusted issuer | Parameterized persisted-report denial cases |
| Another organization/project/repository/task/PR/SHA/cycle | Signed scope mismatch denial cases |
| Stale or expired report | Previous-cycle, wrong-cycle and expiry cases, plus expiry immediately before HTTP mutation |
| Genuine independent verification | Existing successful merge fixtures now sign using an isolated test verifier; service receives public key only |
| Single operator without second human | Zero GitHub reviews still succeeds after authentic technical report and canonical human approval |
| Legacy independent mode | Trusted eligible numeric reviewer required; implementer/PR author reviews rejected |
| Missing/stale human approval | Running task and stale canonical approval denials |
| Current ADMIN/session | Revoked role/session/expiry and project-lock/concurrent authority tests |
| Exact SHA/check App and provenance | Stale head/review, failed/pending check, wrong App, outside-ledger commit denials |
| No GitHub bypass | REST/GraphQL policy, bypass allowance and CODEOWNERS regressions |
| Restricted SQL | Identity/scope/result/history mutations denied; startup rejects broader column ACLs |
| Replay safety | In-flight PENDING and ambiguous UNKNOWN do not repeat HTTP mutation; definitive FAILED may retry |

The RSA/Ed25519 keys in tests are generated ephemeral fixtures. GitHub HTTP is
simulated; PostgreSQL and browser execution are real. No productive verifier is
mocked or claimed to exist.

## Trust and rollout limitations

The independent verifier must keep its private key and trust-root configuration
outside the implementer and API/worker security domains. JEV verifies the signed
attestation and report digest; the verifier remains responsible for actually
reviewing the exact revision and retaining its report. A fully compromised API
can still report a fabricated HTTP outcome while completing its own PENDING
operation; immutable SQL scope/results do not turn GitHub responses into signed
receipts. Neither limitation permits forging an independent signed verification.

Absent verifier configuration/evidence fails closed. The implementation supplies
the minimum signature gate on canonical persisted evidence; it does not deploy a
future Verification Engine. Existing staging/production need separately approved
migration, restricted grants, isolated verifier key provisioning and process restart.
No live rollout was performed for this PR; canonical closure remains unchanged.

Final validation, independent read-only review, PR and exact-head CI results are
recorded in the remediation PR description and delivery message.
