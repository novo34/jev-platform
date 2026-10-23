import { readFile } from "node:fs/promises";
import { GitHubAppClient, GitHubError } from "@jev/control";

// Explicit operator diagnostic only. No install binding, write, merge or deploy.
// The application integration must still use ControlService and persisted scope.
try {
  const privateKeyFile = process.env.JEV_GITHUB_APP_PRIVATE_KEY_FILE;
  if (!privateKeyFile || !process.env.JEV_GITHUB_APP_ID) throw new Error("CONFIGURATION_REQUIRED");
  const scope = {
    installationId: Number(process.env.JEV_GITHUB_TEST_INSTALLATION_ID),
    repositoryId: Number(process.env.JEV_GITHUB_TEST_REPOSITORY_ID),
    fullName: process.env.JEV_GITHUB_TEST_REPOSITORY ?? ""
  };
  const client = new GitHubAppClient({
    appId: process.env.JEV_GITHUB_APP_ID,
    privateKey: await readFile(privateKeyFile, "utf8")
  });
  const installation = await client.installation(scope.installationId);
  if (installation.id !== scope.installationId || installation.suspended_at !== null) throw new Error("INSTALLATION_UNAVAILABLE");
  const repository = await client.repository(scope);
  console.log(JSON.stringify({
    capability: "github-app-transport", status: "PARTIAL",
    realApiObserved: true, installationId: installation.id,
    repositoryId: repository.id, repository: repository.full_name,
    observedAt: new Date().toISOString(),
    limitations: ["install-flow-unverified", "control-path-unverified", "write-and-merge-unverified"]
  }));
} catch (error) {
  console.error(JSON.stringify({
    capability: "github-app-transport", status: "BLOCKED", realApiObserved: false,
    code: error instanceof GitHubError ? error.code : "GITHUB_ACCEPTANCE_UNAVAILABLE"
  }));
  process.exitCode = 1;
}
