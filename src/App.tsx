import { LogOut, MonitorUp, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { API, type AppSession, type AuthConfig } from "./api/client";
import type { CadDocument, InterviewSession, InterviewTemplate } from "./cad/model";
import { CadInterviewPanel } from "./components/CadInterviewPanel";
import {
  completeKeycloakLogin,
  loadSession,
  saveSession,
  startKeycloakLogin
} from "./auth/keycloak";

const SESSION_KEY = "vcad-active-session-id";

function App() {
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [user, setUser] = useState<AppSession | null>(() => loadSession());
  const [templates, setTemplates] = useState<InterviewTemplate[]>([]);
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [document, setDocument] = useState<CadDocument | null>(null);
  const [status, setStatus] = useState("Loading");
  const saveTimer = useRef<number | null>(null);

  const token = user?.token || "";

  useEffect(() => {
    API.authConfig()
      .then(setAuthConfig)
      .catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    completeKeycloakLogin()
      .then((sessionResult) => {
        if (sessionResult) {
          setUser(sessionResult);
          setStatus("Signed in");
        }
      })
      .catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!token) return;
    API.me(token)
      .then((result) => {
        setUser(result.session);
        saveSession(result.session);
      })
      .catch(() => {
        saveSession(null);
        setUser(null);
      });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    API.templates(token)
      .then((result) => setTemplates(result.templates))
      .catch((error) => setStatus(error.message));
  }, [token]);

  useEffect(() => {
    if (!token || !templates.length) return;
    const existingId = localStorage.getItem(SESSION_KEY);
    const load = existingId ? API.getSession(token, existingId) : API.createSession(token, templates[0].id);
    load
      .then((result) => {
        setSession(result.session);
        setDocument(result.session.document);
        localStorage.setItem(SESSION_KEY, result.session.id);
        setStatus("Session ready");
      })
      .catch(async () => {
        const result = await API.createSession(token, templates[0].id);
        setSession(result.session);
        setDocument(result.session.document);
        localStorage.setItem(SESSION_KEY, result.session.id);
      });
  }, [token, templates]);

  useEffect(() => {
    if (!token || !session?.id) return;
    const id = window.setInterval(() => {
      API.getSession(token, session.id)
        .then((result) => {
          setSession(result.session);
          setDocument((current) => current || result.session.document);
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(id);
  }, [token, session?.id]);

  const activeTemplate = useMemo(
    () => templates.find((template) => template.id === session?.templateId) || templates[0],
    [templates, session]
  );

  const login = async () => {
    if (!authConfig) return;
    if (authConfig.keycloakEnabled) {
      await startKeycloakLogin(authConfig);
      return;
    }
    if (authConfig.allowDevAuth) {
      const result = await API.devLogin();
      saveSession(result.session);
      setUser(result.session);
      return;
    }
    setStatus("Authentication is not configured");
  };

  const signOut = () => {
    saveSession(null);
    localStorage.removeItem(SESSION_KEY);
    setUser(null);
    setSession(null);
    setDocument(null);
  };

  const createNewSession = async () => {
    if (!token || !templates[0]) return;
    const result = await API.createSession(token, templates[0].id);
    setSession(result.session);
    setDocument(result.session.document);
    localStorage.setItem(SESSION_KEY, result.session.id);
  };

  const handleDocumentChange = (next: CadDocument, detail: string) => {
    setDocument(next);
    setStatus(detail);
    if (!token || !session) return;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      API.saveDocument(token, session.id, next)
        .then((result) => setSession(result.session))
        .catch((error) => setStatus(error.message));
      API.logEvent(token, session.id, "cad_change", detail).catch(() => undefined);
    }, 450);
  };

  if (!user) {
    return (
      <main className="login-shell">
        <section className="login-hero">
          <div className="brand-mark">
            <MonitorUp size={30} />
          </div>
          <h1>VCAD Interview</h1>
          <p>{status}</p>
          <button type="button" className="command-button primary large" onClick={login} disabled={!authConfig}>
            <ShieldCheck size={18} /> Sign in
          </button>
        </section>
      </main>
    );
  }

  if (!session || !document) {
    return (
      <main className="app-shell">
        <div className="loading-row">
          <RefreshCw size={18} /> {status}
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Cloud CAD Interview</p>
          <h1>{activeTemplate?.title || "CAD session"}</h1>
        </div>
        <div className="app-actions">
          <span className="session-chip">{session.id}</span>
          <button type="button" className="command-button" onClick={createNewSession}>
            <Plus size={17} /> New
          </button>
          <button type="button" className="icon-button" title="Sign out" aria-label="Sign out" onClick={signOut}>
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="brief-band">
        <strong>{activeTemplate?.target}</strong>
        <span>{activeTemplate?.rubric.join(" / ")}</span>
      </section>

      <div className="test-app-grid">
        <CadInterviewPanel
          role="candidate"
          user={user}
          session={session}
          authToken={token}
          document={document}
          onDocumentChange={handleDocumentChange}
          onSessionChange={(nextSession) => {
            setSession(nextSession);
            setDocument(nextSession.document);
          }}
        />
        <CadInterviewPanel
          role="interviewer"
          user={user}
          session={session}
          authToken={token}
          document={session.document}
          readOnly
          onDocumentChange={() => undefined}
          onSessionChange={(nextSession) => {
            setSession(nextSession);
            setDocument(nextSession.document);
          }}
        />
      </div>
    </main>
  );
}

export default App;
