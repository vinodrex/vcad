import { API, type AppSession, type AuthConfig } from "../api/client";

const SESSION_KEY = "vcad-auth-session";
const OIDC_STATE_KEY = "vcad-oidc-state";

function base64Url(bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function loadSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) || "null") as AppSession | null;
    return parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: AppSession | null) {
  if (!session?.token) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function oidcRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function oidcRandomString(length = 64) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

export async function oidcPkceChallenge(verifier: string) {
  const encoded = new TextEncoder().encode(verifier);
  return base64Url(await crypto.subtle.digest("SHA-256", encoded));
}

export function cleanOidcCallbackUrl() {
  const url = new URL(window.location.href);
  ["code", "state", "session_state", "iss", "error", "error_description"].forEach((key) =>
    url.searchParams.delete(key)
  );
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

export async function startKeycloakLogin(config: AuthConfig) {
  if (!crypto?.subtle || !config.authorizationEndpoint || !config.clientId) {
    throw new Error("Browser PKCE support or Keycloak configuration is missing.");
  }
  const state = oidcRandomString(48);
  const codeVerifier = oidcRandomString(96);
  const redirectUri = oidcRedirectUri();
  const codeChallenge = await oidcPkceChallenge(codeVerifier);
  sessionStorage.setItem(
    OIDC_STATE_KEY,
    JSON.stringify({ state, codeVerifier, redirectUri, createdAt: Date.now() })
  );

  const authUrl = new URL(config.authorizationEndpoint);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", (config.scopes?.length ? config.scopes : ["openid", "profile", "email"]).join(" "));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", oidcRandomString(32));
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  window.location.assign(authUrl.toString());
}

export async function completeKeycloakLogin() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("code") && !params.has("error")) {
    return null;
  }
  const stored = sessionStorage.getItem(OIDC_STATE_KEY);
  sessionStorage.removeItem(OIDC_STATE_KEY);
  if (!stored) {
    cleanOidcCallbackUrl();
    throw new Error("Keycloak sign-in state was not found. Please try again.");
  }
  const loginState = JSON.parse(stored) as { state: string; codeVerifier: string; redirectUri: string };
  if (params.get("error")) {
    cleanOidcCallbackUrl();
    throw new Error(params.get("error_description") || params.get("error") || "Keycloak sign-in failed.");
  }
  if (params.get("state") !== loginState.state) {
    cleanOidcCallbackUrl();
    throw new Error("Keycloak sign-in state did not match. Please try again.");
  }
  const result = await API.keycloakLogin({
    code: params.get("code") || "",
    codeVerifier: loginState.codeVerifier,
    redirectUri: loginState.redirectUri
  });
  cleanOidcCallbackUrl();
  saveSession(result.session);
  return result.session;
}
