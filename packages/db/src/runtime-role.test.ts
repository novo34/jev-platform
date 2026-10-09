import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRestrictedRuntimeRole, createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";

describe("restricted deployment writer", () => {
  it("denies direct updates and allows controlled status changes", async () => {
    const pool = createDatabasePool();
    const owner = await pool.connect();
    const schema = "jev_acl_" + randomUUID().replaceAll("-", "");
    const role = "jev_acl_role_" + randomUUID().replaceAll("-", "");
    const switchRole = "jev_acl_writer_" + randomUUID().replaceAll("-", "");
    let roleCreated = false;
    let switchRoleCreated = false;
    try {
      await owner.query(`CREATE SCHEMA "${schema}"`);
      await owner.query(`SET search_path TO "${schema}", public`);
      const files = [
        "0001_canonical_persistence.sql",
        "0002_auth_rbac.sql",
        "0003_queue_worker.sql",
        "0004_project_registry.sql",
        "0005_work_order_task_lifecycle.sql",
        "0006_work_order_task_review_remediation.sql",
        "0007_staging_requirement_approved_guard.sql",
        "0008_serialize_staging_requirement.sql",
        "0009_harden_trigger_function_search_path.sql",
        "0010_controlled_deployment_status_writer.sql",
        "0011_scope_controlled_writer_to_schema.sql",
        "0012_controlled_task_transition.sql",
        "0013_controlled_task_environment_writers.sql",
        "0014_controlled_project_scope_lock.sql",
        "0015_controlled_approval_deployment_creation.sql"
      ];
      for (const file of files) {
        let sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
        if (file.startsWith("0001_")) sql = sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "");
        await owner.query(sql);
      }
      const organization = randomUUID();
      const project = randomUUID();
      const userId = randomUUID();
      await owner.query("INSERT INTO organizations(id,name) VALUES($1,'ACL Org')", [organization]);
      await owner.query(
        "INSERT INTO users(id,organization_id,email,display_name,role) VALUES ($1,$2,'acl@example.test','ACL User','ADMIN')",
        [userId, organization]
      );
      await owner.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'ACL Project')", [project, organization]);
      const repository = (await owner.query(
        "INSERT INTO repositories(project_id,full_name,role) VALUES($1,'acl/test','backend') RETURNING id",
        [project]
      )).rows[0].id;
      const environment = (await owner.query(
        "INSERT INTO environments(project_id,repository_id,kind,name) VALUES($1,$2,'production','ACL') RETURNING id",
        [project, repository]
      )).rows[0].id;
      const order = (await owner.query(
        "INSERT INTO orders(project_id,objective) VALUES($1,'ACL order') RETURNING id",
        [project]
      )).rows[0].id;
      const deployment = (await owner.query(
        "INSERT INTO deployments(project_id,repository_id,environment_id,revision,status) VALUES($1,$2,$3,'acl','READY') RETURNING id",
        [project, repository, environment]
      )).rows[0].id;

      await owner.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);
      roleCreated = true;
      await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION "${schema}".jev_set_deployment_status(uuid,uuid[],text) TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION "${schema}".jev_create_task(uuid,uuid,uuid,text,text,jsonb) TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION "${schema}".jev_create_environment(uuid,uuid,text,text,text,jsonb) TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION "${schema}".jev_transition_task(uuid,text,text,text,text,jsonb) TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION "${schema}".jev_lock_project_scope(uuid) TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION "${schema}".jev_create_deployment(uuid,uuid,uuid,uuid,text,text,text,text,jsonb) TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION "${schema}".jev_create_approval(uuid,uuid,uuid,text,text,text,text,text,jsonb) TO "${role}"`);
      await owner.query(`GRANT INSERT ON TABLE orders, requirements, task_requirements, projects, repositories, order_state_history TO "${role}"`);
      await owner.query(`GRANT UPDATE (status) ON TABLE orders TO "${role}"`);
      await owner.query(`GRANT INSERT ON TABLE auth_sessions, audit_events TO "${role}"`);
      await owner.query(`GRANT UPDATE (last_seen_at) ON TABLE auth_sessions TO "${role}"`);
      await owner.query(`GRANT DELETE ON TABLE auth_sessions TO "${role}"`);
      await owner.query(`GRANT UPDATE (status,updated_at) ON TABLE projects TO "${role}"`);
      await owner.query(`GRANT INSERT, UPDATE ON TABLE jobs, worker_instances TO "${role}"`);

      await owner.query("BEGIN");
      await owner.query(`SET LOCAL ROLE "${role}"`);
      const privilege = await owner.query(
        "SELECT has_table_privilege(current_user,$1,'UPDATE') AS allowed",
        [schema + ".deployments"]
      );
      expect(privilege.rows[0].allowed).toBe(false);
      const readable = await owner.query("SELECT status FROM deployments WHERE id=$1", [deployment]);
      expect(readable.rows[0].status).toBe("READY");
      await expect(owner.query(
        "UPDATE deployments SET status = 'FAILED' WHERE id=$1", [deployment]
      )).rejects.toMatchObject({ code: "42501" });
      await owner.query("ROLLBACK");

      await owner.query("BEGIN");
      await owner.query(`SET LOCAL ROLE "${role}"`);
      const result = await owner.query(
        "SELECT jev_set_deployment_status($1::uuid,$2::uuid[],$3::text) AS updated",
        [project, [deployment], "FAILED"]
      );
      expect(result.rows[0].updated).toBe(1);
      await owner.query("COMMIT");
      // Real restricted role can create and transition Tasks without table DML.
      await owner.query("BEGIN");
      await owner.query(`SET LOCAL ROLE "${role}"`);
      for (const table of ["tasks", "environments", "approvals", "deployments"]) {
        const denied = await owner.query(
          "SELECT has_table_privilege(current_user,$1,'INSERT') AS insert_allowed, has_table_privilege(current_user,$1,'UPDATE') AS update_allowed",
          [schema + "." + table]
        );
        expect(denied.rows[0]).toEqual({ insert_allowed: false, update_allowed: false });
      }
      // Exercise the same guard used at API/worker startup under the real role.
      await assertRestrictedRuntimeRole({ query: owner.query.bind(owner) } as unknown as Pool);
      const cannotUpdateProject = await owner.query(
        "SELECT has_table_privilege(current_user,$1,'UPDATE') AS allowed",
        [schema + ".projects"]
      );
      expect(cannotUpdateProject.rows[0].allowed).toBe(false);
      const scopedLock = await owner.query(
        "SELECT jev_lock_project_scope($1::uuid) AS id", [project]
      );
      expect(scopedLock.rows[0].id).toBe(project);
      // The live order service also needs its non-guarded history trigger.
      const newOrder = await owner.query(
        "INSERT INTO orders(project_id,objective) VALUES($1,'Restricted order') RETURNING id", [project]
      );
      await owner.query("UPDATE orders SET status='READY' WHERE id=$1", [newOrder.rows[0].id]);
      const orderHistory = await owner.query(
        "SELECT to_status FROM order_state_history WHERE order_id=$1 ORDER BY (from_status IS NOT NULL),created_at,id",
        [newOrder.rows[0].id]
      );
      expect(orderHistory.rows.map((x) => x.to_status)).toEqual(["PLANNED", "READY"]);
      // API login/logout and audit DML remain usable by the runtime identity.
      const session = await owner.query(
        "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,'acl-token',NOW()+INTERVAL '1 day') RETURNING id",
        [userId]
      );
      await owner.query("UPDATE auth_sessions SET last_seen_at=NOW() WHERE id=$1", [session.rows[0].id]);
      await owner.query("DELETE FROM auth_sessions WHERE id=$1", [session.rows[0].id]);
      await owner.query(
        "INSERT INTO audit_events(organization_id,project_id,actor_type,action,target_type,result) VALUES($1,$2,'USER','ACL_TEST','PROJECT','SUCCESS')",
        [organization, project]
      );
      // Control API project state mutations remain column-limited.
      await owner.query("UPDATE projects SET status='PAUSED',updated_at=NOW() WHERE id=$1", [project]);
      await owner.query("UPDATE projects SET status='ACTIVE',updated_at=NOW() WHERE id=$1", [project]);
      // Worker registration, queued job claim and state changes require no owner role.
      const job = await owner.query(
        "INSERT INTO jobs(job_type,correlation_id,project_id) VALUES('NOOP','acl-correlation',$1) RETURNING id",
        [project]
      );
      await owner.query("UPDATE jobs SET status='RUNNING' WHERE id=$1", [job.rows[0].id]);
      await owner.query(
        "INSERT INTO worker_instances(worker_id,status) VALUES('acl-worker','RUNNING')"
      );
      await owner.query(
        "UPDATE worker_instances SET current_job_id=$1,last_heartbeat_at=NOW() WHERE worker_id='acl-worker'",
        [job.rows[0].id]
      );

      const createdTask = await owner.query(
        "SELECT jev_create_task($1::uuid,$2::uuid,$3::uuid,'ACL task','R0','[]'::jsonb) AS id",
        [project, order, repository]
      );
      const taskId = createdTask.rows[0].id as string;
      const transitioned = await owner.query(
        "SELECT jev_transition_task($1::uuid,'READY','SYSTEM',NULL,'role-test','{}'::jsonb) AS id",
        [taskId]
      );
      expect(transitioned.rows[0].id).toBe(taskId);
      const createdEnv = await owner.query(
        "SELECT jev_create_environment($1::uuid,$2::uuid,'staging','ACL staging',NULL,'{}'::jsonb) AS id",
        [project, repository]
      );
      expect(createdEnv.rows[0].id).toBeTruthy();
      await owner.query("COMMIT");
      const persistedTask = await owner.query("SELECT status FROM tasks WHERE id=$1", [taskId]);
      expect(persistedTask.rows[0].status).toBe("READY");
      const persistedEnv = await owner.query("SELECT kind FROM environments WHERE id=$1", [createdEnv.rows[0].id]);
      expect(persistedEnv.rows[0].kind).toBe("staging");

      // End-to-end human review under runtime: staging deployment, review
      // decision and approval. Direct guarded-table INSERT stays prohibited.
      await owner.query("BEGIN");
      await owner.query(`SET LOCAL ROLE "${role}"`);
      for (const status of ["RUNNING","VERIFYING","VERIFIED","STAGING"]) {
        await owner.query(
          "SELECT jev_transition_task($1::uuid,$2::text,'SYSTEM',NULL,'runtime-workflow','{}'::jsonb)",
          [taskId, status]
        );
      }
      const stagingUrl = "https://acl-stage.example.test";
      const revision = "runtime-revision-001";
      const newDeployment = await owner.query(
        "SELECT jev_create_deployment($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,'READY',$6::text,'ci','{}'::jsonb) AS id",
        [project, repository, createdEnv.rows[0].id, taskId, revision, stagingUrl]
      );
      const reviewEvidence = {
        stagingDeploymentId: newDeployment.rows[0].id,
        revision,
        url: stagingUrl
      };
      await owner.query(
        "SELECT jev_transition_task($1::uuid,'AWAITING_HUMAN','SYSTEM',NULL,'ready-for-review',$2::jsonb)",
        [taskId, JSON.stringify(reviewEvidence)]
      );
      const approval = await owner.query(
        "SELECT jev_create_approval($1::uuid,$2::uuid,$3::uuid,'APPROVED',$4::text,$5::text,$6::text,$7::text,$8::jsonb) AS id",
        [project, taskId, userId, revision, "a".repeat(40), "https://github.com/example/review/pull/1", stagingUrl, JSON.stringify(reviewEvidence)]
      );
      expect(approval.rows[0].id).toBeTruthy();
      await owner.query(
        "SELECT jev_transition_task($1::uuid,'APPROVED','USER',$2::text,'human-approved',$3::jsonb)",
        [taskId, userId, JSON.stringify(reviewEvidence)]
      );
      await owner.query("COMMIT");
      const approvedTask = await owner.query("SELECT status FROM tasks WHERE id=$1", [taskId]);
      expect(approvedTask.rows[0].status).toBe("APPROVED");
      const approvalPersisted = await owner.query(
        "SELECT decision,stale FROM approvals WHERE id=$1", [approval.rows[0].id]
      );
      expect(approvalPersisted.rows[0]).toEqual({decision:"APPROVED",stale:false});

      // Proof for Codex P1 #1: column-only grants enable direct DML while
      // has_table_privilege remains false. The startup guard must refuse.
      await owner.query(`GRANT UPDATE (status) ON TABLE "${schema}".tasks TO "${role}"`);
      await owner.query("BEGIN");
      await owner.query(`SET LOCAL ROLE "${role}"`);
      const colGrant = await owner.query(
        "SELECT has_table_privilege(current_user,$1,'UPDATE') AS table_allowed, has_column_privilege(current_user,$1,'status','UPDATE') AS column_allowed",
        [schema + ".tasks"]
      );
      expect(colGrant.rows[0]).toEqual({table_allowed:false,column_allowed:true});
      await owner.query("UPDATE tasks SET status=status WHERE id=$1", [taskId]);
      await expect(
        assertRestrictedRuntimeRole({ query: owner.query.bind(owner) } as unknown as Pool)
      ).rejects.toThrow("Unsafe JEV runtime database role");
      await owner.query("ROLLBACK");
      await owner.query(`REVOKE UPDATE (status) ON TABLE "${schema}".tasks FROM "${role}"`);

      // Proof for Codex P1 #2: NOINHERIT can hide a grant that SET ROLE
      // makes reachable; fail startup even before the role switch occurs.
      await owner.query(`CREATE ROLE "${switchRole}" NOLOGIN NOINHERIT`);
      switchRoleCreated = true;
      await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${switchRole}"`);
      await owner.query(`GRANT UPDATE (status) ON TABLE "${schema}".tasks TO "${switchRole}"`);
      await owner.query(`GRANT "${switchRole}" TO "${role}"`);
      await owner.query("BEGIN");
      await owner.query(`SET LOCAL ROLE "${role}"`);
      const hiddenGrant = await owner.query(
        "SELECT has_column_privilege(current_user,$1,'status','UPDATE') AS allowed",
        [schema + ".tasks"]
      );
      expect(hiddenGrant.rows[0].allowed).toBe(false);
      await expect(
        assertRestrictedRuntimeRole({ query: owner.query.bind(owner) } as unknown as Pool)
      ).rejects.toThrow("Unsafe JEV runtime database role");
      await owner.query(`SET LOCAL ROLE "${switchRole}"`);
      const escalated = await owner.query(
        "SELECT has_column_privilege(current_user,$1,'status','UPDATE') AS allowed",
        [schema + ".tasks"]
      );
      expect(escalated.rows[0].allowed).toBe(true);
      await owner.query("ROLLBACK");

      const persisted = await owner.query("SELECT status FROM deployments WHERE id=$1", [deployment]);
      expect(persisted.rows[0].status).toBe("FAILED");
    } finally {
      try { await owner.query("ROLLBACK"); } catch {}
      await owner.query("SET search_path TO public");
      if (switchRoleCreated) {
        await owner.query(`REVOKE "${switchRole}" FROM "${role}"`);
        await owner.query(`REVOKE UPDATE (status) ON TABLE "${schema}".tasks FROM "${switchRole}"`);
        await owner.query(`REVOKE USAGE ON SCHEMA "${schema}" FROM "${switchRole}"`);
        await owner.query(`DROP ROLE "${switchRole}"`);
      }
      if (roleCreated) {
        await owner.query(`REVOKE UPDATE (status) ON TABLE "${schema}".tasks FROM "${role}"`);
        await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_set_deployment_status(uuid,uuid[],text) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_create_task(uuid,uuid,uuid,text,text,jsonb) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_create_environment(uuid,uuid,text,text,text,jsonb) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_transition_task(uuid,text,text,text,text,jsonb) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_lock_project_scope(uuid) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_create_deployment(uuid,uuid,uuid,uuid,text,text,text,text,jsonb) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_create_approval(uuid,uuid,uuid,text,text,text,text,text,jsonb) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON SCHEMA "${schema}" FROM "${role}"`);
        await owner.query(`DROP ROLE "${role}"`);
      }
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      owner.release();
      await pool.end();
    }
  });
});
