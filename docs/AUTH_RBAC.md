# Authentication and RBAC

PLT-004 introduces server-side human authentication and project-scoped authorization.

## Human roles

- ADMIN
- PROJECT_MANAGER
- DEVELOPER
- AUDITOR
- CLIENT

ADMIN is organization-scoped. Every non-admin role requires an explicit
`project_memberships` row before project access is granted.

CLIENT access is always explicit and read-only. A project membership can never
raise a user's permission ceiling above the user's global role.

## Authentication

Passwords are stored as salted scrypt hashes. Successful login creates a
cryptographically random opaque session token. Only the SHA-256 hash of that
token is persisted in `auth_sessions`; the plaintext token is returned once to
the caller.

Current API endpoints:

- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`

Login requires `organizationId`, `email` and `password`.

## Project authorization

Server code must call `authorizeProject()` with the authenticated actor,
project ID and required permission. Organization boundaries are checked before
project membership. Cross-organization access is denied even for ADMIN users.

Project permissions currently defined:

- `project:read`
- `project:write`
- `project:admin`
- `audit:read`

Later Control Layer work must reuse this authorization boundary rather than
reimplementing role logic in UI or route handlers.
