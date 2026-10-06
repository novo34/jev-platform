import type { AuthenticatedUser, ProjectPermission } from "@jev/auth";

export const CONTROL_ACTIONS = [
  "GET_PROJECT_STATUS",
  "CREATE_ORDER",
  "PAUSE_PROJECT",
  "RESUME_PROJECT"
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
