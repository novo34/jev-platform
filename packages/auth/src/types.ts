export const HUMAN_ROLES = [
  "ADMIN",
  "PROJECT_MANAGER",
  "DEVELOPER",
  "AUDITOR",
  "CLIENT"
] as const;

export type HumanRole = (typeof HUMAN_ROLES)[number];

export const PROJECT_PERMISSIONS = [
  "project:read",
  "project:write",
  "project:admin",
  "audit:read"
] as const;

export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  role: HumanRole;
  sessionId: string;
}

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CREDENTIALS"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "USER_INACTIVE",
    message = code
  ) {
    super(message);
    this.name = "AuthError";
  }
}
