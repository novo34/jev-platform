import React, { FormEvent, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

type ProviderName = "openai" | "deepseek" | "qwen" | "glm";

interface ProviderStatus {
  provider: ProviderName;
  configured: boolean;
  lastFour?: string;
  updatedAt?: string;
}

interface BrowserSession {
  user: {
    displayName: string;
    role: string;
  };
}

const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body != null ? { "Content-Type": "application/json" } : {}),
      "X-JEV-Browser-Session": "1",
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "REQUEST_FAILED" }));
    throw new ApiError(response.status, body.message ??
      (typeof body.error === "object" ? body.error?.message : body.error) ?? `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function Login({
  onLogin,
  notice
}: {
  onLogin: (session: BrowserSession) => void;
  notice?: string;
}) {
  const [organizationId, setOrganizationId] = useState(DEFAULT_ORGANIZATION_ID);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverySent, setRecoverySent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (recovering) {
        await api("/auth/password-recovery", {
          method: "POST", body: JSON.stringify({ organizationId, email })
        });
        setRecoverySent(true);
        return;
      }
      const session = await api<BrowserSession>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ organizationId, email, password })
      });
      onLogin(session);
    } catch (caught) {
      setError(recovering ? "No se pudo solicitar la recuperación. Inténtalo más tarde." :
        caught instanceof Error ? caught.message : "No se pudo iniciar sesión");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div>
          <p className="eyebrow">JEV Platform</p>
          <h1>{recovering ? "Recuperar contraseña" : "Acceso administrativo"}</h1>
          <p className="muted">
            Entorno local de desarrollo. Las credenciales de proveedores se
            cifran en el servidor y nunca vuelven a mostrarse completas.
          </p>
        </div>

        <label>
          Organization ID
          <input value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} />
        </label>
        <label>
          Email
          <input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {!recovering ? <label>
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label> : null}

        {notice && !recovering ? <p role="status">{notice}</p> : null}
        {recoverySent && recovering
          ? <p role="status">Si existe una cuenta con esos datos, recibirás un correo con un enlace.</p>
          : null}
        {error ? <p className="error" role="alert">{error}</p> : null}

        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "Enviando…" : recovering ? "Enviar enlace" : "Entrar"}
        </button>
        <button type="button" disabled={submitting} onClick={() => {
          setError("");
          setPassword("");
          setRecoverySent(false);
          setRecovering(!recovering);
        }}>{recovering ? "Volver al acceso" : "Olvidé mi contraseña"}</button>
      </form>
    </main>
  );
}

function ProviderCard({
  provider,
  status,
  refresh
}: {
  provider: ProviderName;
  status: ProviderStatus;
  refresh: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const displayName =
    provider === "openai"
      ? "OpenAI / Codex"
      : provider === "deepseek"
        ? "DeepSeek"
        : provider === "qwen"
          ? "Qwen"
          : "GLM";

  async function save() {
    if (!apiKey.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await api(
        `/providers/${provider}/credential`,
        { method: "PUT", body: JSON.stringify({ apiKey }) }
      );
      setApiKey("");
      setMessage("Credencial guardada de forma segura.");
      await refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMessage("");
    try {
      const result = await api<{ ok: boolean; detail?: string }>(
        `/providers/${provider}/test`,
        { method: "POST" }
      );
      setMessage(result.ok ? "Conexión correcta." : result.detail ?? "La prueba falló.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "La prueba falló");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`¿Eliminar la credencial de ${displayName}?`)) return;
    setBusy(true);
    setMessage("");
    try {
      await api(
        `/providers/${provider}/credential`,
        { method: "DELETE" }
      );
      setMessage("Credencial eliminada.");
      await refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "No se pudo eliminar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="provider-card">
      <div className="provider-heading">
        <div>
          <h3>{displayName}</h3>
          <p className="muted">
            {status.configured
              ? `Configurada ••••${status.lastFour ?? ""}`
              : "No configurada"}
          </p>
        </div>
        <span className={status.configured ? "badge ok" : "badge"}>
          {status.configured ? "Configured" : "Not configured"}
        </span>
      </div>

      <label>
        {status.configured ? "Reemplazar API key" : "API key"}
        <input
          type="password"
          autoComplete="off"
          placeholder="Pega la clave aquí"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>

      <div className="actions">
        <button className="primary" onClick={save} disabled={busy || !apiKey.trim()}>
          {status.configured ? "Reemplazar" : "Guardar"}
        </button>
        <button onClick={test} disabled={busy || !status.configured}>
          Probar conexión
        </button>
        <button className="danger" onClick={remove} disabled={busy || !status.configured}>
          Eliminar
        </button>
      </div>

      {message ? <p className="status-message">{message}</p> : null}
    </article>
  );
}

function GitHubSettings({ session }: { session: BrowserSession }) {
  const [projectId, setProjectId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

  async function connect(action: "START_GITHUB_INSTALLATION" | "CONNECT_GITHUB_IDENTITY") {
    setBusy(true); setError("");
    try {
      const result = await api<{ data: { installUrl: string } }>("/control/commands", {
        method: "POST", body: JSON.stringify({ commandId: crypto.randomUUID(), action, projectId, payload: { repositoryId } })
      });
      const url = new URL(result.data.installUrl);
      if (url.origin !== "https://github.com") throw new Error("Destino de autorización inválido");
      window.location.assign(url.toString());
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "No se pudo iniciar la conexión";
      setError(message === "GITHUB_INVALID_CONFIGURATION" ? "La GitHub App todavía no está configurada en este entorno." : message);
      setBusy(false);
    }
  }

  return (
    <article className="provider-card" aria-label="GitHub App">
      <h2>GitHub App</h2>
      <p className="muted">Vincula un repositorio del registro de JEV o verifica tu identidad en GitHub.</p>
      <form onSubmit={(event) => { event.preventDefault(); void connect("CONNECT_GITHUB_IDENTITY"); }}>
        <label>Proyecto del registro (ID)
          <input required pattern={uuidPattern} value={projectId} onChange={(event) => setProjectId(event.target.value)} />
        </label>
        <label>Repositorio del registro (ID)
          <input required pattern={uuidPattern} value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)} />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy}>Conectar mi identidad GitHub</button>
          <button className="primary" type="button" disabled={busy || session.user.role !== "ADMIN"}
            onClick={(event) => { if (event.currentTarget.form?.reportValidity()) void connect("START_GITHUB_INSTALLATION"); }}>
            Instalar o vincular GitHub App
          </button>
        </div>
      </form>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </article>
  );
}

function Settings({
  session,
  onLogout,
  loggingOut,
  logoutError
}: {
  session: BrowserSession;
  onLogout: () => void;
  loggingOut: boolean;
  logoutError: string;
}) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setError("");
      const result = await api<{ providers: ProviderStatus[] }>(
        "/providers"
      );
      setProviders(result.providers);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudieron cargar los providers");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">JEV Platform</p>
          <strong>{session.user.displayName}</strong>
          <p className="muted small">{session.user.role}</p>
        </div>
        <nav>
          <button className="nav-item active">Settings</button>
          <button className="nav-item active-sub">Providers</button>
        </nav>
        <button className="nav-item" onClick={onLogout} disabled={loggingOut}>Cerrar sesión</button>
          {logoutError ? <p role="alert">{logoutError}</p> : null}
      </aside>

      <section className="content">
        <header>
          <p className="eyebrow">Settings</p>
          <h1>Model Providers</h1>
          <p className="muted">
            Añade o rota las claves sin guardarlas en GitHub ni mostrarlas de
            nuevo en el navegador.
          </p>
        </header>

        {error ? <p className="error">{error}</p> : null}

        <div className="provider-grid">
          {(["openai", "deepseek", "qwen", "glm"] as ProviderName[]).map((provider) => {
            const status =
              providers.find((item) => item.provider === provider) ??
              ({ provider, configured: false } as ProviderStatus);
            return (
              <ProviderCard
                key={provider}
                provider={provider}
                status={status}
                refresh={refresh}
              />
            );
          })}
        </div>
        <GitHubSettings session={session} />
      </section>
    </main>
  );
}

function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirmation) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/auth/password-reset", {
        method: "POST", body: JSON.stringify({ token, password })
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError && caught.message === "INVALID_RESET_TOKEN"
        ? "El enlace ya no es válido. Solicita otro desde el formulario de acceso."
        : "No se pudo cambiar la contraseña. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1>Cambiar contraseña</h1>
        <label>Nueva contraseña
          <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required
            value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label>Confirma la contraseña
          <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required
            value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button type="submit" className="primary" disabled={busy}>Cambiar contraseña</button>
        <a href="/">Volver al acceso</a>
      </form>
    </main>
  );
}

function App() {
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("reset"));
  const [resetCompleted, setResetCompleted] = useState(false);
  const [session, setSession] = useState<BrowserSession | null | undefined>(undefined);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [error, setError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (resetToken !== null) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return;
    }
    if (resetCompleted) return;

    const request = new AbortController();
    api<BrowserSession>("/auth/me", { signal: request.signal }).then(
      (result) => { if (!request.signal.aborted) setSession(result); },
      (caught: unknown) => {
        if (request.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 401) {
          setSession(null);
        } else {
          setError("No se pudo comprobar la sesión.");
        }
      }
    );
    return () => request.abort();
  }, [resetToken, resetCompleted, restoreAttempt]);

  if (resetToken !== null) {
    return <ResetPassword token={resetToken} onDone={() => {
      setSession(null);
      setResetCompleted(true);
      setResetToken(null);
    }} />;
  }
  if (session === undefined) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          {error ? <>
            <p role="alert">{error}</p>
            <button type="button" onClick={() => {
              setError("");
              setRestoreAttempt((attempt) => attempt + 1);
            }}>Reintentar</button>
          </> : <p role="status">Comprobando sesión…</p>}
        </div>
      </main>
    );
  }

  if (!session) return <Login notice={resetCompleted ? "Contraseña actualizada. Inicia sesión." : undefined} onLogin={setSession} />;

  async function logout() {
    setError("");
    setLoggingOut(true);
    try {
      await api("/auth/logout", { method: "POST" });
      setSession(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSession(null);
      } else {
        setError("No se pudo cerrar la sesión. Vuelve a intentarlo.");
      }
    } finally {
      setLoggingOut(false);
    }
  }

  return <Settings session={session} onLogout={() => void logout()} loggingOut={loggingOut} logoutError={error} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

