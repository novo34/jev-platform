import { checkDatabase, createDatabasePool } from "@jev/db";
import { parseKey } from "@jev/model-gateway";
import { buildApi } from "./app.js";
import { readFile } from "node:fs/promises";
import { GitHubAppClient, GitHubInstallationFlow, GitHubOperations, type GitHubMergePolicy } from "@jev/control";

const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? 3001);
const encryptionKey = process.env.JEV_SECRET_ENCRYPTION_KEY;
if (process.env.JEV_REQUIRE_SECRET_KEY === "1") {
  parseKey(encryptionKey);
}
const pool = createDatabasePool();
const githubVariables = ["JEV_GITHUB_APP_ID", "JEV_GITHUB_APP_PRIVATE_KEY_FILE", "JEV_GITHUB_APP_SLUG",
  "JEV_GITHUB_CLIENT_ID", "JEV_GITHUB_CLIENT_SECRET", "JEV_GITHUB_CALLBACK_URL"] as const;
let githubInstallation: GitHubInstallationFlow | undefined;
let githubOperations: GitHubOperations | undefined;
if (githubVariables.some((name) => process.env[name] !== undefined)) {
  if (githubVariables.some((name) => !process.env[name])) throw new Error("GITHUB_CONFIGURATION_INCOMPLETE");
  const github = new GitHubAppClient({
    appId: process.env.JEV_GITHUB_APP_ID!,
    privateKey: await readFile(process.env.JEV_GITHUB_APP_PRIVATE_KEY_FILE!, "utf8")
  });
  githubInstallation = new GitHubInstallationFlow({
    slug: process.env.JEV_GITHUB_APP_SLUG!, clientId: process.env.JEV_GITHUB_CLIENT_ID!,
    clientSecret: process.env.JEV_GITHUB_CLIENT_SECRET!, callbackUrl: process.env.JEV_GITHUB_CALLBACK_URL!
  }, github);
  let mergePolicy: GitHubMergePolicy | undefined;
  if (process.env.JEV_GITHUB_MERGE_POLICY) {
    try { mergePolicy = JSON.parse(process.env.JEV_GITHUB_MERGE_POLICY); }
    catch { throw new Error("GITHUB_MERGE_CONFIGURATION_INVALID"); }
  }
  githubOperations = new GitHubOperations(pool, github, mergePolicy);
}
const app = buildApi({ pool, githubInstallation, githubOperations });

app.addHook("onClose", async () => {
  await pool.end();
});

try {
  await checkDatabase(pool);
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}

