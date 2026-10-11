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

interface LoginResponse {
  token: string;
  user: {
    displayName: string;
    role: string;
  };
}

const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

async function api<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "REQUEST_FAILED" }));
    throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function Login({
  onLogin
}: {
  onLogin: (session: LoginResponse) => void;
}) {
  const [organizationId, setOrganizationId] = useState(DEFAULT_ORGANIZATION_ID);
  const [email, setEmail] = useState("admin@jev.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const session = await api<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ organizationId, email, password })
      });
      onLogin(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo iniciar sesión");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div>
          <p className="eyebrow">JEV Platform</p>
          <h1>Acceso administrativo</h1>
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
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}

function ProviderCard({
  provider,
  status,
  token,
  refresh
}: {
  provider: ProviderName;
  status: ProviderStatus;
  token: string;
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
        { method: "PUT", body: JSON.stringify({ apiKey }) },
        token
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
        { method: "POST" },
        token
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
        { method: "DELETE" },
        token
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

function Settings({
  session,
  onLogout
}: {
  session: LoginResponse;
  onLogout: () => void;
}) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setError("");
      const result = await api<{ providers: ProviderStatus[] }>(
        "/providers",
        {},
        session.token
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
        <button className="nav-item" onClick={onLogout}>Cerrar sesión</button>
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
                token={session.token}
                refresh={refresh}
              />
            );
          })}
        </div>
      </section>
    </main>
  );
}

function App() {
  const [session, setSession] = useState<LoginResponse | null>(null);

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  async function logout() {
    if (!session) return;
    try {
      await api("/auth/logout", { method: "POST" }, session.token);
    } finally {
      setSession(null);
    }
  }

  return <Settings session={session} onLogout={() => void logout()} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
