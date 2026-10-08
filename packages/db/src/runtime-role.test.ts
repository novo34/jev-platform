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
        "0011_scope_controlled_writer_to_schema.sql"
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
      const deployment = (await owner.query(
        "INSERT INTO deployments(project_id,repository_id,environment_id,revision,status) VALUES($1,$2,$3,'acl','READY') RETURNING id",
        [project, repository, environment]
      )).rows[0].id;

      await owner.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);
      roleCreated = true;
      await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await owner.query(`GRANT EXECUTE ON FUNCTION "${schema}".jev_set_deployment_status(uuid,uuid[],text) TO "${role}"`);

      await owner.query("BEGIN");
      await owner.query(`SET LOCAL ROLE "${role}"`);
      const privilege = await owner.query(
        "SELECT has_table_privilege(current_user,$1,'UPDATE') AS allowed",
        [schema + ".deployments"]
      );
      expect(privilege.rows[0].allowed).toBe(false);
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
      const persisted = await owner.query("SELECT status FROM deployments WHERE id=$1", [deployment]);
      expect(persisted.rows[0].status).toBe("FAILED");
    } finally {
      try { await owner.query("ROLLBACK"); } catch {}
      await owner.query("SET search_path TO public");
      if (roleCreated) {
        await owner.query(`REVOKE ALL ON FUNCTION "${schema}".jev_set_deployment_status(uuid,uuid[],text) FROM "${role}"`);
        await owner.query(`REVOKE ALL ON SCHEMA "${schema}" FROM "${role}"`);
        await owner.query(`DROP ROLE "${role}"`);
      }
      await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      owner.release();
      await pool.end();
    }
  });
});
