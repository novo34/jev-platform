import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { AuthError, type AuthenticatedUser, type HumanRole, type ProjectPermission } from "./types.js";
import { verifyPassword } from "./password.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  display_name: string;
  role: HumanRole;
  status: string;
  password_hash: string | null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toAuthenticatedUser(row: UserRow, sessionId: string): AuthenticatedUser {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    sessionId
  };
}

export async function login(
  pool: Pool,
  input: { organizationId: string; email: string; password: string }
): Promise<{ token: string; user: AuthenticatedUser }> {
  const result = await pool.query<UserRow>(
    `SELECT id, organization_id, email, display_name, role, status, password_hash
       FROM users
      WHERE organization_id = $1 AND lower(email) = lower($2)
      LIMIT 1`,
    [input.organizationId, input.email.trim()]
  );

  const row = result.rows[0];

  if (!row?.password_hash || !verifyPassword(input.password, row.password_hash)) {
    throw new AuthError("INVALID_CREDENTIALS");
  }

  if (row.status !== "ACTIVE") {
    throw new AuthError("USER_INACTIVE");
  }

  const token = randomBytes(32).toString("base64url");
  const session = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [row.id, tokenHash(token), new Date(Date.now() + SESSION_TTL_MS)]
  );

  return {
    token,
    user: toAuthenticatedUser(row, session.rows[0].id)
  };
}

export async function authenticateToken(
  pool: Pool,
  token: string | undefined
): Promise<AuthenticatedUser> {
  if (!token) {
    throw new AuthError("UNAUTHENTICATED");
  }

  const result = await pool.query<UserRow & { session_id: string }>(
    `SELECT
       u.id, u.organization_id, u.email, u.display_name, u.role, u.status,
       u.password_hash, s.id AS session_id
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > NOW()
     LIMIT 1`,
    [tokenHash(token)]
  );

  const row = result.rows[0];

  if (!row || row.status !== "ACTIVE") {
    throw new AuthError("UNAUTHENTICATED");
  }

  await pool.query(
    "UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = $1",
    [row.session_id]
  );

  return toAuthenticatedUser(row, row.session_id);
}

export async function logout(pool: Pool, sessionId: string): Promise<void> {
  await pool.query("DELETE FROM auth_sessions WHERE id = $1", [sessionId]);
}

const ROLE_PERMISSIONS: Record<Exclude<HumanRole, "ADMIN">, ReadonlySet<ProjectPermission>> = {
  PROJECT_MANAGER: new Set(["project:read", "project:write", "project:admin", "audit:read"]),
  DEVELOPER: new Set(["project:read", "project:write"]),
  AUDITOR: new Set(["project:read", "audit:read"]),
  CLIENT: new Set(["project:read"])
};

export async function authorizeProject(
  pool: Pool,
  actor: AuthenticatedUser,
  projectId: string,
  permission: ProjectPermission
): Promise<void> {
  const project = await pool.query<{ organization_id: string }>(
    "SELECT organization_id FROM projects WHERE id = $1 LIMIT 1",
    [projectId]
  );

  const projectRow = project.rows[0];

  if (!projectRow || projectRow.organization_id !== actor.organizationId) {
    throw new AuthError("FORBIDDEN");
  }

  if (actor.role === "ADMIN") {
    return;
  }

  const membership = await pool.query<{ role: Exclude<HumanRole, "ADMIN"> }>(
    `SELECT role
       FROM project_memberships
      WHERE project_id = $1 AND user_id = $2
      LIMIT 1`,
    [projectId, actor.id]
  );

  const role = membership.rows[0]?.role;

  if (!role || !ROLE_PERMISSIONS[role]?.has(permission)) {
    throw new AuthError("FORBIDDEN");
  }
}

export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const [scheme, token] = authorization.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}
