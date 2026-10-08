import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabasePool, DEFAULT_MIGRATIONS_DIR } from "./index.js";

describe("restricted deployment writer", () => {
  it("denies direct updates and allows controlled status changes", async () => {
    const pool = createDatabasePool();
    const owner = await pool.connect();
    const schema = "jev_acl_" + randomUUID().replaceAll("-", "");
    const role = "jev_acl_role_" + randomUUID().replaceAll("-", "");
    let roleCreated = false;
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
        "0014_controlled_project_scope_lock.sql"
      ];
      for (const file of files) {
        let sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
        if (file.startsWith("0001_")) sql = sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "");
        await owner.query(sql);
      }
      const organization = randomUUID();
      const project = randomUUID();
      await owner.query("INSERT INTO organizations(id,name) VALUES($1,'ACL Org')", [organization]);
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
      await owner.query(`GRANT INSERT ON TABLE orders, requirements, task_requirements, projects, repositories TO "${role}"`);
      await owner.query(`GRANT UPDATE ON TABLE orders TO "${role}"`);

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

      const persisted = await owner.query("SELECT status FROM deployments WHERE id=$1", [deployment]);
      expect(persisted.rows[0].status).toBe("FAILED");
    } finally {
      try { await owner.query("ROLLBACK"); } catch {}
      await owner.query("SET search_path TO public");
      if (roleCreated) {
        await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_set_deployment_status(uuid,uuid[],text) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_create_task(uuid,uuid,uuid,text,text,jsonb) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_create_environment(uuid,uuid,text,text,text,jsonb) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_transition_task(uuid,text,text,text,text,jsonb) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON SCHEMA "${schema}" FROM "${role}"`);
        await owner.query(`DROP ROLE "${role}"`);
      }
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      owner.release();
      await pool.end();
    }
  });
});
