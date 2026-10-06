# API / Control Plane

PLT-005 establishes the Control Layer as the canonical application-facing boundary for authenticated project commands.

## Boundary

Application routes do not perform project mutations directly. The API authenticates the human actor and maps the request to a typed `ControlCommand`. `ControlService` then:

1. validates the command;
2. resolves the required project permission;
3. enforces server-side authorization;
4. executes the read or mutation;
5. persists an audit event;
6. returns a stable typed result or error.

For mutations, the business write and SUCCESS audit event share the same PostgreSQL transaction. If audit persistence fails, the mutation is rolled back.

Authentication bootstrap endpoints (`/auth/login`, `/auth/me`, `/auth/logout`) remain the security boundary established by PLT-004; authenticated project commands enter through the Control Layer.

## API

`POST /control/commands`

Example:

```json
{
  "commandId": "optional-client-command-id",
  "action": "CREATE_ORDER",
  "projectId": "00000000-0000-0000-0000-000000000000",
  "payload": {
    "objective": "Implement the requested change",
    "priority": "P0"
  }
}
```

Currently implemented actions:

- `GET_PROJECT_STATUS`
- `CREATE_ORDER`
- `PAUSE_PROJECT`
- `RESUME_PROJECT`

The API must not duplicate the business logic or authorization policy from `@jev/control`.

## Error contract

Errors use one stable envelope:

```json
{
  "ok": false,
  "commandId": "command-id",
  "error": {
    "code": "FORBIDDEN",
    "message": "project action is not permitted"
  }
}
```

Canonical error codes are `INVALID_COMMAND`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT` and `INTERNAL_ERROR`.

## Audit invariant

A denied command produces a BLOCKED audit event. A failed authorized command produces FAILED. A successful command produces SUCCESS.

Successful mutations and their SUCCESS audit record are atomic. There is no exported mutation service that bypasses the authorization-and-audit sequence.
