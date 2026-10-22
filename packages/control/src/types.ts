import type { AuthenticatedUser, ProjectPermission } from "@jev/auth";

export const GITHUB_ACTIONS = ["GITHUB_READ_REPOSITORY", "GITHUB_CREATE_BRANCH", "GITHUB_WRITE_FILE",
  "GITHUB_CREATE_PR", "GITHUB_READ_PR", "GITHUB_READ_CHECKS", "GITHUB_READ_REVIEWS", "GITHUB_MERGE_PR"] as const;

export const CONTROL_ACTIONS = [
  "GET_PROJECT_STATUS",
  "CREATE_ORDER",
  "PAUSE_PROJECT",
  "RESUME_PROJECT",
  "START_GITHUB_INSTALLATION",
  "CONNECT_GITHUB_IDENTITY",
  ...GITHUB_ACTIONS
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export interface ControlCommand {
  commandId: string;
  action: ControlAction;
  projectId: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

export interface ControlContext {
  actor: AuthenticatedUser;
  correlationId: string;
}

export type ControlSuccess<T = unknown> = {
  ok: true;
  commandId: string;
  action: ControlAction;
  data: T;
};

export type ControlFailure = {
  ok: false;
  commandId?: string;
  error: {
    code:
      | "INVALID_COMMAND"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "RATE_LIMITED"
      | "UPSTREAM_UNAVAILABLE"
      | "INTERNAL_ERROR";
    message: string;
    details?: Record<string, unknown>;
  };
};

export class ControlError extends Error {
  constructor(
    public readonly code: ControlFailure["error"]["code"],
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export interface ActionPolicy {
  permission: ProjectPermission;
  mutating: boolean;
}

