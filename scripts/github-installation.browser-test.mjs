import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Real browser + built web assets; external GitHub and API responses are simulated.
// This regression suite never installs an App or counts as real acceptance.
const root = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
let browser, server, origin;
before(async () => {
  const candidates = [process.env.JEV_BROWSER_EXECUTABLE, "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
  let executablePath;
  for (const candidate of candidates) {
    try { await access(candidate); executablePath = candidate; break; } catch { /* try next installed browser */ }
  }
  assert.ok(executablePath, "Install Chromium/Chrome or set JEV_BROWSER_EXECUTABLE; browser tests may not be skipped");
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    const target = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(root)) { response.writeHead(403).end(); return; }
    try {
      const data = await readFile(target);
      response.setHeader("Content-Type", target.endsWith(".js") ? "application/javascript" : target.endsWith(".css") ? "text/css" : "text/html");
      response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://localhost:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function pageWithSession(controlResponse) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const commands = [], githubRequests = [];
  const runtimeErrors = [], consoleErrors = [], networkFailures = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => networkFailures.push(request.failure()?.errorText));
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) {
      if (url.pathname === "/api/auth/login") return route.fulfill({ json: { token: "disposable-browser-session", user: { displayName: "Test Admin", role: "ADMIN" } } });
      if (url.pathname === "/api/providers") return route.fulfill({ json: { providers: [] } });
      if (url.pathname === "/api/control/commands") {
        commands.push(request.postDataJSON());
        assert.equal(request.headers().authorization, "Bearer disposable-browser-session");
        return route.fulfill(controlResponse);
      }
      return route.continue();
    }
    if (url.origin === "https://github.com") {
      githubRequests.push(request.headers());
      return route.fulfill({ contentType: "text/html", body: "<h1>Simulated GitHub authorization</h1>" });
    }
    return route.abort();
  });
  await page.goto(origin);
  await page.locator('input[type="password"]').fill("disposable-browser-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  const form = page.getByRole("article", { name: "GitHub App" });
  await form.getByLabel("Proyecto del registro (ID)").fill("11111111-1111-4111-8111-111111111111");
  await form.getByLabel("Repositorio del registro (ID)").fill("22222222-2222-4222-8222-222222222222");
  return { context, page, form, commands, githubRequests, runtimeErrors, consoleErrors, networkFailures };
}

function assertBrowserFindings(value, expectedHttpStatus) {
  assert.deepEqual(value.runtimeErrors, []);
  assert.deepEqual(value.networkFailures.filter((message) => message !== "net::ERR_ABORTED"), []);
  assert.deepEqual(value.consoleErrors.filter((message) => !expectedHttpStatus || !message.includes(String(expectedHttpStatus))), []);
}

for (const [button, action] of [
  ["Instalar o vincular GitHub App", "START_GITHUB_INSTALLATION"],
  ["Conectar mi identidad GitHub", "CONNECT_GITHUB_IDENTITY"]
]) test(`browser starts ${action} with shared secure cookie and no credential on GitHub navigation`, async () => {
  const state = "a".repeat(43);
  const value = await pageWithSession({ status: 200, headers: { "Set-Cookie": `__Host-jev_github_install=${state}; Path=/; Secure; HttpOnly; SameSite=Lax` },
    json: { data: { installUrl: `https://github.com/apps/jev-test/installations/new?state=${state}` } } });
  try {
    await value.form.getByRole("button", { name: button, exact: true }).click();
    await value.page.waitForURL("https://github.com/**");
    assert.equal(value.commands.length, 1);
    assert.equal(value.commands[0].action, action);
    assert.equal(value.commands[0].projectId, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(value.commands[0].payload, { repositoryId: "22222222-2222-4222-8222-222222222222" });
    const cookie = (await value.context.cookies(origin)).find((item) => item.name === "__Host-jev_github_install");
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Lax");
    assert.equal(value.githubRequests[0].authorization, undefined);
    assert.equal(value.githubRequests[0].cookie, undefined);
    assertBrowserFindings(value);
  } finally { await value.context.close(); }
});

test("browser displays nested configuration failure without navigating", async () => {
  const value = await pageWithSession({ status: 503, json: { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "GITHUB_INVALID_CONFIGURATION" } } });
  try {
    await value.form.getByRole("button", { name: "Instalar o vincular GitHub App" }).click();
    await value.form.getByRole("alert").waitFor();
    assert.match(await value.form.getByRole("alert").textContent(), /todavía no está configurada/);
    assert.equal(new URL(value.page.url()).origin, origin);
    assertBrowserFindings(value, 503);
  } finally { await value.context.close(); }
});

test("browser refuses an authorization redirect outside GitHub", async () => {
  const value = await pageWithSession({ status: 200, json: { data: { installUrl: "https://untrusted.invalid/" } } });
  try {
    await value.form.getByRole("button", { name: "Conectar mi identidad GitHub" }).click();
    await value.form.getByRole("alert").waitFor();
    assert.match(await value.form.getByRole("alert").textContent(), /Destino de autorización inválido/);
    assert.equal(new URL(value.page.url()).origin, origin);
    assertBrowserFindings(value);
  } finally { await value.context.close(); }
});
