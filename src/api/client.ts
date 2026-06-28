import type { CadDocument, InterviewSession, InterviewTemplate } from "../cad/model";

export interface AuthConfig {
  mode: string;
  authProvider: string;
  keycloakEnabled: boolean;
  oidcEnabled: boolean;
  localPasswordEnabled: boolean;
  clientId: string;
  issuer: string;
  authorizationEndpoint: string;
  redirectUri: string;
  scopes: string[];
  allowDevAuth: boolean;
}

export interface AppSession {
  token: string;
  name: string;
  email: string;
  subject: string;
  master: boolean;
  provider: string;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || data.details || `Request failed with HTTP ${response.status}`);
  }
  return data as T;
}

export const API = {
  authConfig() {
    return request<AuthConfig>("/api/auth/config");
  },
  keycloakLogin(payload: { code?: string; codeVerifier?: string; redirectUri?: string; idToken?: string }) {
    return request<{ session: AppSession }>("/api/auth/keycloak-login", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  devLogin() {
    return request<{ session: AppSession }>("/api/auth/dev-login", { method: "POST" });
  },
  me(token: string) {
    return request<{ session: AppSession }>("/api/me", {
      headers: { Authorization: `Bearer ${token}` }
    });
  },
  templates(token: string) {
    return request<{ templates: InterviewTemplate[] }>("/api/interview/templates", {
      headers: { Authorization: `Bearer ${token}` }
    });
  },
  createSession(token: string, templateId: string) {
    return request<{ session: InterviewSession }>("/api/interview/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ templateId })
    });
  },
  getSession(token: string, sessionId: string) {
    return request<{ session: InterviewSession }>(`/api/interview/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  },
  saveDocument(token: string, sessionId: string, document: CadDocument) {
    return request<{ session: InterviewSession }>(`/api/interview/sessions/${sessionId}/document`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ document })
    });
  },
  logEvent(token: string, sessionId: string, type: string, detail: string) {
    return request<{ ok: true }>(`/api/interview/sessions/${sessionId}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type, detail })
    });
  },
  submit(token: string, sessionId: string, document: CadDocument) {
    return request<{ session: InterviewSession }>(`/api/interview/sessions/${sessionId}/submit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ document })
    });
  }
};
