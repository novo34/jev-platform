import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertRestrictedRuntimeRole } from "../packages/db/dist/index.js";

/** Called only by the disposable, CI-gated restricted runtime smoke. */
export async function verifyGitHubLedgerSecurity(admin, runtimeUrl) {
  const runtime = new Pool({ connectionString: runtimeUrl });
  const org = randomUUID(), project = randomUUID(), repo = randomUUID(), user = randomUUID();
  let count = 0;
  const denied = async (sql, values, code = "42501", connection = runtime) => {
    await assert.rejects(connection.query(sql, values), { code }); count++;
  };
  try {
    await admin.query("INSERT INTO organizations(id,name) VALUES($1,'Disposable ledger security')", [org]);
    await admin.query("INSERT INTO users(id,organization_id,email,display_name,role) VALUES($1,$2,$3,'Verifier fixture','ADMIN')", [user, org, `${user}@ledger.test`]);
    await admin.query("INSERT INTO projects(id,organization_id,name) VALUES($1,$2,'Ledger test')", [project, org]);
    await admin.query("INSERT INTO repositories(id,project_id,provider,full_name,role,default_branch) VALUES($1,$2,'github','owner/security-test','other','main')", [repo, project]);
    const order = (await admin.query("INSERT INTO orders(project_id,objective) VALUES($1,'Ledger test') RETURNING id", [project])).rows[0].id;
    const task = (await admin.query("SELECT jev_create_task($1,$2,$3,'Ledger test','R1','[]'::jsonb) AS id", [project, order, repo])).rows[0].id;
    await runtime.query("INSERT INTO github_user_identities(organization_id,user_id,github_user_id,github_login) VALUES($1,$2,12345,'original')", [org,user]);
    await denied("UPDATE github_user_identities SET github_user_id=54321 WHERE user_id=$1", [user]);
    await denied("UPDATE github_user_identities SET github_user_id=54321 WHERE user_id=$1", [user], "23514", admin);
    await runtime.query("UPDATE github_user_identities SET github_login='renamed',verified_at=NOW() WHERE user_id=$1", [user]);
    const reserve = async (id, status="PENDING", result=null) => runtime.query(
      `INSERT INTO github_operations(organization_id,project_id,repository_id,task_id,actor_id,command_id,action,request_hash,status,result)
        VALUES($1,$2,$3,$4,$5,$6,'GITHUB_WRITE_FILE',repeat('a',64),$7,$8)`, [org,project,repo,task,user,id,status,result]);
    const command = randomUUID(); await reserve(command);
    await denied("UPDATE github_operations SET request_hash=repeat('b',64) WHERE command_id=$1", [command]);
    await denied("UPDATE github_operations SET project_id=$1 WHERE command_id=$2", [project,command]);
    await denied("DELETE FROM github_operations WHERE command_id=$1", [command]);
    await assert.rejects(reserve(randomUUID(), "SUCCESS", {}), { code: "23514" }); count++;
    await denied("UPDATE github_operations SET result='{}'::jsonb WHERE command_id=$1", [command], "23514");
    await denied("UPDATE github_operations SET status='SUCCESS' WHERE command_id=$1", [command], "23514");
    await runtime.query("UPDATE github_operations SET status='FAILED' WHERE command_id=$1", [command]);
    await runtime.query("UPDATE github_operations SET status='PENDING',result=NULL WHERE command_id=$1", [command]);
    await runtime.query("UPDATE github_operations SET status='SUCCESS',result=$2::jsonb WHERE command_id=$1", [command,JSON.stringify({ commit: { sha: "a".repeat(40) }, branch: `feat/jev-${task}` })]);
    await denied("UPDATE github_operations SET result='{}'::jsonb WHERE command_id=$1", [command], "23514");
    await denied("UPDATE github_operations SET status='PENDING',result=NULL WHERE command_id=$1", [command], "23514");
    const ambiguous=randomUUID(); await reserve(ambiguous);
    await runtime.query("UPDATE github_operations SET status='UNKNOWN' WHERE command_id=$1", [ambiguous]);
    await denied("UPDATE github_operations SET status='PENDING' WHERE command_id=$1", [ambiguous], "23514");
    await denied("UPDATE task_state_history SET evidence='{}'::jsonb WHERE task_id=$1", [task]);
    await denied("UPDATE task_state_history SET evidence='{}'::jsonb WHERE task_id=$1", [task], "23514", admin);
    await denied("DELETE FROM task_state_history WHERE task_id=$1", [task]);
    await denied("TRUNCATE task_state_history");
    await denied("INSERT INTO task_state_history(task_id,to_status) VALUES($1,'VERIFIED')", [task]);
    // Both startup and the topology gate must reject table AND column ACL drift.
    for (const grant of ["UPDATE (github_user_id) ON github_user_identities", "UPDATE (request_hash) ON github_operations", "INSERT (task_id) ON task_state_history"]) {
      await admin.query(`GRANT ${grant} TO jev_runtime`);
      try { await assert.rejects(assertRestrictedRuntimeRole(runtime), /Unsafe JEV runtime database role/); count++; }
      finally { await admin.query(`REVOKE ${grant} FROM jev_runtime`); }
    }
    await assertRestrictedRuntimeRole(runtime);
    return count;
  } finally { await runtime.end(); }
}
