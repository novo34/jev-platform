import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { AuthError, authorizeProject, type AuthenticatedUser } from "@jev/auth";
import {
  CachePolicy,
  ModelGateway,
  ModelGatewayError,
  PricingCatalog,
  ProviderCredentialStore,
  createDefaultProviderRegistry,
  type ProviderTarget
} from "@jev/model-gateway";
import {
  INTAKE_WORK_TYPE,
  IntentAcceptanceError,
  IntentAcceptanceService,
  IntentBriefGenerator,
  IntentGenerationError,
  WorkOrderError,
  WorkOrderService,
  parseIntentModelTargets,
  type IntentModelGateway
} from "@jev/work-orders";
import { requireAuthenticatedUser } from "./auth.js";

// PLT-040 PR 6. Same authentication as the other routes (session) and the same
// authorization as CREATE_ORDER in the control plane: authorizeProject with
// "project:write" (ADMIN, or PROJECT_MANAGER/DEVELOPER with a membership of the
// project; AUDITOR and CLIENT are refused; another organization is refused).
// The organization and author always come from the session, never the body.
//
// SAFE BY DEFAULT: nothing here calls a provider unless the operator configured
// JEV_INTENT_MODEL, the CHF pricing of that model, the secret key and the tenant
// namespace secret. Every missing piece fails with a clear error BEFORE the
// intake task is created or any call is made. Only POST /projects/:id/work-orders
// can spend; task creation and re-evaluation never use the gateway.

export interface WorkOrderRoutesOptions {
  /** Injected gateway (tests). Without it the real Model Gateway is built from the environment. */
  intentGateway?: IntentModelGateway;
  /** Explicit targets (tests); otherwise JEV_INTENT_MODEL. */
  intentTargets?: ProviderTarget[];
  /** JEV_SECRET_ENCRYPTION_KEY override (as in the provider routes). */
  encryptionKey?: string;
  env?: NodeJS.ProcessEnv;
}

class IntentRouteConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function resolveGenerator(pool: Pool, options: WorkOrderRoutesOptions): IntentBriefGenerator {
  const env = options.env ?? process.env;
  // Throws INTENT_MODEL_NOT_CONFIGURED (IntentGenerationError) without JEV_INTENT_MODEL.
  const targets = options.intentTargets?.length
    ? options.intentTargets
    : parseIntentModelTargets(env.JEV_INTENT_MODEL ?? "");
  if (options.intentGateway) {
    return new IntentBriefGenerator({ gateway: options.intentGateway, targets });
  }
  let pricing: PricingCatalog;
  try {
    pricing = PricingCatalog.fromJson(env.JEV_MODEL_PRICING_JSON);
  } catch {
    throw new IntentRouteConfigError("INTENT_GATEWAY_NOT_CONFIGURED", "JEV_MODEL_PRICING_JSON is invalid");
  }
  for (const target of targets) {
    const missing = pricing.missingRates(target.provider, target.model);
    if (missing.length > 0) {
      throw new IntentRouteConfigError(
        "PRICING_REQUIRED",
        `verified CHF pricing is required for ${target.provider}:${target.model}; missing: ${missing.join(", ")}`
      );
    }
  }
  const key = options.encryptionKey ?? env.JEV_SECRET_ENCRYPTION_KEY;
  if (!key) throw new IntentRouteConfigError("INTENT_GATEWAY_NOT_CONFIGURED", "JEV_SECRET_ENCRYPTION_KEY is required");
  const tenantSecret = env.JEV_TENANT_NAMESPACE_SECRET;
  if (!tenantSecret) {
    throw new IntentRouteConfigError("INTENT_GATEWAY_NOT_CONFIGURED", "JEV_TENANT_NAMESPACE_SECRET is required");
  }
  const gateway = new ModelGateway(
    pool,
    new ProviderCredentialStore(pool, key),
    createDefaultProviderRegistry(),
    pricing,
    3,
    30_000,
    undefined,
    CachePolicy.fromEnv(env),
    tenantSecret
  );
  return new IntentBriefGenerator({ gateway, targets });
}

const uuid = { type: "string", format: "uuid" } as const;
const projectParams = {
  type: "object", required: ["projectId"], properties: { projectId: uuid }
} as const;
const orderParams = {
  type: "object", required: ["projectId", "orderId"], properties: { projectId: uuid, orderId: uuid }
} as const;

const WORK_ORDER_STATUS: Record<WorkOrderError["code"], number> = {
  INVALID_ORDER: 400,
  INVALID_INTENT: 400,
  INTENT_REQUIRED: 400,
  REQUIREMENT_NOT_FOUND: 400,
  ORDER_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  REPOSITORY_NOT_FOUND: 404,
  AMBIGUOUS_REPOSITORY_TARGET: 409,
  ILLEGAL_TRANSITION: 409
};

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) {
    const status = error.code === "UNAUTHENTICATED" || error.code === "INVALID_CREDENTIALS" ? 401 : 403;
    return reply.code(status).send({ error: error.code });
  }
  if (error instanceof IntentRouteConfigError) {
    return reply.code(503).send({ error: error.code, message: error.message });
  }
  if (error instanceof IntentGenerationError) {
    // No model configured: 503 (nothing was spent). Invalid model output: 502.
    return reply
      .code(error.code === "INTENT_MODEL_NOT_CONFIGURED" ? 503 : 502)
      .send({ error: error.code, message: error.message });
  }
  if (error instanceof ModelGatewayError) {
    // Codes only: provider details never leave the gateway.
    return reply.code(error.code === "PRICING_REQUIRED" ? 503 : 502).send({ error: error.code });
  }
  if (error instanceof WorkOrderError) {
    return reply.code(WORK_ORDER_STATUS[error.code]).send({ error: error.code, message: error.message });
  }
  if (error instanceof IntentAcceptanceError) {
    return reply.code(400).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

async function authorize(
  pool: Pool, request: Parameters<typeof requireAuthenticatedUser>[1], projectId: string
): Promise<AuthenticatedUser> {
  const actor = await requireAuthenticatedUser(pool, request);
  await authorizeProject(pool, actor, projectId, "project:write");
  return actor;
}

export function registerWorkOrderRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: WorkOrderRoutesOptions = {}
): void {
  const intents = new IntentAcceptanceService(pool);
  // Without generator: enough for tasks and re-evaluation (no gateway, no spend).
  const plain = new WorkOrderService(pool, undefined, { intentService: intents });
  const text = { type: "string", minLength: 1, maxLength: 20000 } as const;

  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>(
    "/projects/:projectId/work-orders",
    {
      schema: {
        params: projectParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["objective"],
          properties: {
            objective: text,
            priority: { type: "string", minLength: 1, maxLength: 64 },
            workType: { type: "string", minLength: 1, maxLength: 64 },
            constraints: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
            acceptanceCriteria: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
            requirements: {
              type: "array", maxItems: 100,
              items: {
                type: "object", additionalProperties: false, required: ["key", "title", "description"],
                properties: {
                  key: { type: "string", minLength: 1, maxLength: 128 },
                  title: { type: "string", minLength: 1, maxLength: 512 },
                  description: { type: "string", minLength: 1, maxLength: 20000 }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const actor = await authorize(pool, request, request.params.projectId);
        if (request.body.workType === INTAKE_WORK_TYPE) {
          return reply.code(400).send({ error: "INVALID_ORDER", message: "workType is reserved" });
        }
        // Configuration is checked BEFORE the intake task exists or any call is made.
        const generator = resolveGenerator(pool, options);
        const service = new WorkOrderService(pool, undefined, { intentService: intents, intentGenerator: generator });
        const intake = await service.ensureIntakeTask(request.params.projectId);
        const order = await service.createOrderWithGeneratedIntent(
          { ...request.body, objective: request.body.objective, projectId: request.params.projectId, authorUserId: actor.id },
          intake.taskId,
          intake.orderId
        );
        return reply.code(201).send({ order });
      } catch (error) {
        return fail(reply, error);
      }
    }
  );

  app.post<{ Params: { projectId: string; orderId: string }; Body: Record<string, any> }>(
    "/projects/:projectId/orders/:orderId/tasks",
    {
      schema: {
        params: orderParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 512 },
            repositoryId: uuid,
            risk: { type: "string", enum: ["R0", "R1", "R2", "R3", "R4"] },
            acceptanceCriteria: { type: "array", maxItems: 50, items: { type: "string", maxLength: 2000 } },
            requirementIds: { type: "array", maxItems: 100, items: uuid }
          }
        }
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        await authorize(pool, request, request.params.projectId);
        await assertUserOrder(pool, request.params.projectId, request.params.orderId);
        const task = await plain.createTask({
          ...request.body,
          title: request.body.title,
          projectId: request.params.projectId,
          orderId: request.params.orderId
        });
        return reply.code(201).send({ task });
      } catch (error) {
        return fail(reply, error);
      }
    }
  );

  app.post<{ Params: { projectId: string; orderId: string } }>(
    "/projects/:projectId/orders/:orderId/reevaluate-blocked-tasks",
    { schema: { params: orderParams } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        await authorize(pool, request, request.params.projectId);
        await assertUserOrder(pool, request.params.projectId, request.params.orderId);
        return reply.code(200).send({ result: await plain.reevaluateBlockedTasks(request.params.orderId) });
      } catch (error) {
        return fail(reply, error);
      }
    }
  );
}

/** The order must belong to the authorized project and must not be the system intake order. */
async function assertUserOrder(pool: Pool, projectId: string, orderId: string): Promise<void> {
  const found = await pool.query(
    "SELECT work_type FROM orders WHERE id = $1 AND project_id = $2",
    [orderId, projectId]
  );
  if (!found.rows[0]) throw new WorkOrderError("ORDER_NOT_FOUND");
  if (found.rows[0].work_type === INTAKE_WORK_TYPE) {
    throw new WorkOrderError("INVALID_ORDER", "the system intake order accepts no tasks");
  }
}
