import { createHash, createVerify, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");
const staticRoot = join(root, "dist", "client");
const dataDir = resolve(process.env.VCAD_DATA_DIR || join(root, "data"));
const dataPath = join(dataDir, "app-state.json");

const PORT = Number(process.env.PORT || 8080);
const AUTH_MODE = (process.env.VCAD_AUTH_MODE || "keycloak").trim();
const KEYCLOAK_BASE_URL = trimTrailing(process.env.VCAD_KEYCLOAK_BASE_URL || "https://auth.superpoweredjalapenos.org");
const KEYCLOAK_REALM = (process.env.VCAD_KEYCLOAK_REALM || "ftc-interview").trim();
const KEYCLOAK_CLIENT_ID = (process.env.VCAD_KEYCLOAK_CLIENT_ID || "ftc-interview-web").trim();
const KEYCLOAK_CLIENT_SECRET = (process.env.VCAD_KEYCLOAK_CLIENT_SECRET || "").trim();
const KEYCLOAK_ISSUER = trimTrailing(
  process.env.VCAD_KEYCLOAK_ISSUER || (KEYCLOAK_BASE_URL && KEYCLOAK_REALM ? `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}` : "")
);
const KEYCLOAK_AUTHORIZATION_ENDPOINT = process.env.VCAD_KEYCLOAK_AUTHORIZATION_ENDPOINT || `${KEYCLOAK_ISSUER}/protocol/openid-connect/auth`;
const KEYCLOAK_TOKEN_ENDPOINT = process.env.VCAD_KEYCLOAK_TOKEN_ENDPOINT || `${KEYCLOAK_ISSUER}/protocol/openid-connect/token`;
const KEYCLOAK_JWKS_URI = process.env.VCAD_KEYCLOAK_JWKS_URI || `${KEYCLOAK_ISSUER}/protocol/openid-connect/certs`;
const KEYCLOAK_MASTER_EMAILS = (process.env.VCAD_KEYCLOAK_MASTER_EMAILS || "").toLowerCase();
const ALLOW_DEV_AUTH = /^true$/i.test(process.env.VCAD_ALLOW_DEV_AUTH || "");

const sessionsByToken = new Map();
let jwksCache = { fetchedAt: 0, keys: [] };

mkdirSync(dataDir, { recursive: true });

const state = loadState();

function trimTrailing(value) {
  return String(value || "").replace(/\/+$/, "");
}

function loadState() {
  if (!existsSync(dataPath)) {
    return { interviewSessions: {}, submissions: [] };
  }
  try {
    return JSON.parse(readFileSync(dataPath, "utf8"));
  } catch {
    return { interviewSessions: {}, submissions: [] };
  }
}

function saveState() {
  writeFileSync(dataPath, JSON.stringify(state, null, 2));
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function sendError(res, status, error, details = "") {
  sendJson(res, status, { error, details });
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new Error("Request body must be JSON"));
      }
    });
  });
}

function publicBaseUrl(req) {
  const configured = trimTrailing(process.env.PUBLIC_BASE_URL || "");
  if (configured) return configured;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function keycloakEnabled() {
  return ["keycloak", "oidc", "hybrid"].includes(AUTH_MODE) && Boolean(KEYCLOAK_CLIENT_ID && KEYCLOAK_ISSUER);
}

function authConfig(req) {
  return {
    mode: AUTH_MODE,
    authProvider: keycloakEnabled() ? "keycloak" : "local",
    keycloakEnabled: keycloakEnabled(),
    oidcEnabled: keycloakEnabled(),
    localPasswordEnabled: ALLOW_DEV_AUTH,
    clientId: KEYCLOAK_CLIENT_ID,
    issuer: KEYCLOAK_ISSUER,
    authorizationEndpoint: KEYCLOAK_AUTHORIZATION_ENDPOINT,
    redirectUri: `${publicBaseUrl(req)}/`,
    scopes: ["openid", "profile", "email"],
    allowDevAuth: ALLOW_DEV_AUTH
  };
}

function base64UrlDecode(text) {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
}

function jsonFromJwtPart(part) {
  return JSON.parse(base64UrlDecode(part).toString("utf8"));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function exchangeKeycloakAuthorizationCode(body) {
  const code = String(body.code || "").trim();
  const codeVerifier = String(body.codeVerifier || "").trim();
  const redirectUri = String(body.redirectUri || "").trim();
  if (!code || !codeVerifier || !redirectUri) {
    throw httpError(400, "Keycloak code, codeVerifier, and redirectUri are required");
  }
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", KEYCLOAK_CLIENT_ID);
  form.set("code", code);
  form.set("redirect_uri", redirectUri);
  form.set("code_verifier", codeVerifier);
  if (KEYCLOAK_CLIENT_SECRET) {
    form.set("client_secret", KEYCLOAK_CLIENT_SECRET);
  }
  return fetchJson(KEYCLOAK_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });
}

async function jwks() {
  if (Date.now() - jwksCache.fetchedAt < 300_000 && jwksCache.keys.length) {
    return jwksCache.keys;
  }
  const data = await fetchJson(KEYCLOAK_JWKS_URI);
  jwksCache = { fetchedAt: Date.now(), keys: Array.isArray(data.keys) ? data.keys : [] };
  return jwksCache.keys;
}

async function validateJwt(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) {
    throw httpError(401, "Keycloak token is not a JWT");
  }
  const header = jsonFromJwtPart(parts[0]);
  const claims = jsonFromJwtPart(parts[1]);
  if (header.alg !== "RS256") {
    throw httpError(401, "Unsupported Keycloak token algorithm");
  }
  const key = (await jwks()).find((item) => item.kid === header.kid);
  if (!key) {
    jwksCache = { fetchedAt: 0, keys: [] };
    throw httpError(401, "Keycloak signing key was not found");
  }
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const publicKey = jwkToPem(key);
  if (!verifier.verify(publicKey, base64UrlDecode(parts[2]))) {
    throw httpError(401, "Keycloak token signature was invalid");
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) {
    throw httpError(401, "Keycloak token is expired");
  }
  if (claims.nbf && claims.nbf > now + 60) {
    throw httpError(401, "Keycloak token is not valid yet");
  }
  if (trimTrailing(claims.iss) !== KEYCLOAK_ISSUER) {
    throw httpError(401, "Keycloak token issuer did not match");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud].filter(Boolean);
  if (audiences.length && !audiences.includes(KEYCLOAK_CLIENT_ID)) {
    const azp = claims.azp || claims.client_id;
    if (azp !== KEYCLOAK_CLIENT_ID) {
      throw httpError(401, "Keycloak token audience did not match");
    }
  }
  return claims;
}

function jwkToPem(jwk) {
  const modulus = base64UrlDecode(jwk.n);
  const exponent = base64UrlDecode(jwk.e);
  const encodeLength = (length) => {
    if (length < 128) return Buffer.from([length]);
    const hex = length.toString(16).padStart(length.toString(16).length + (length.toString(16).length % 2), "0");
    const bytes = Buffer.from(hex, "hex");
    return Buffer.concat([Buffer.from([0x80 + bytes.length]), bytes]);
  };
  const integer = (buffer) => {
    const value = buffer[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buffer]) : buffer;
    return Buffer.concat([Buffer.from([0x02]), encodeLength(value.length), value]);
  };
  const body = Buffer.concat([integer(modulus), integer(exponent)]);
  const sequence = Buffer.concat([Buffer.from([0x30]), encodeLength(body.length), body]);
  const b64 = sequence.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN RSA PUBLIC KEY-----\n${b64}\n-----END RSA PUBLIC KEY-----\n`;
}

function emailFromClaims(claims) {
  return String(claims.email || claims.preferred_username || claims.upn || "").trim();
}

function issueSession(claims, provider = "keycloak") {
  const email = emailFromClaims(claims);
  const subject = String(claims.sub || "").trim();
  const name = String(claims.name || claims.given_name || email || "CAD User").trim();
  if (!subject || !email) {
    throw httpError(400, "Keycloak token is missing required identity claims");
  }
  const master = KEYCLOAK_MASTER_EMAILS.split(/[,;\s]+/).filter(Boolean).includes(email.toLowerCase());
  const token = `vcad-session-${randomBytes(28).toString("base64url")}`;
  const session = { token, name, email, subject, master, provider };
  sessionsByToken.set(token, session);
  return session;
}

function requireAuth(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const session = sessionsByToken.get(token);
  if (!session) {
    throw httpError(401, "Sign-in required");
  }
  return session;
}

function httpError(status, message, details = "") {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function defaultDocument() {
  const now = new Date().toISOString();
  const rectId = `ent-${randomUUID().slice(0, 8)}`;
  const holeId = `ent-${randomUUID().slice(0, 8)}`;
  return {
    id: `doc-${randomUUID().slice(0, 8)}`,
    name: "Mounting bracket",
    parameters: {
      width: { name: "width", expression: "72 mm", unit: "mm" },
      height: { name: "height", expression: "44 mm", unit: "mm" },
      depth: { name: "depth", expression: "18 mm", unit: "mm" },
      holeRadius: { name: "holeRadius", expression: "6 mm", unit: "mm" },
      revolveAngle: { name: "revolveAngle", expression: "360 deg", unit: "deg" }
    },
    sketch: {
      id: `sketch-${randomUUID().slice(0, 8)}`,
      name: "Front profile",
      plane: "front",
      entities: [
        {
          id: rectId,
          type: "rectangle",
          x: -36,
          y: -22,
          width: 72,
          height: 44,
          widthParam: "width",
          heightParam: "height",
          constraints: ["horizontal", "vertical"]
        },
        {
          id: holeId,
          type: "circle",
          cx: 0,
          cy: 0,
          radius: 6,
          radiusParam: "holeRadius",
          constraints: ["tangent"]
        }
      ],
      constraints: [
        { id: `con-${randomUUID().slice(0, 8)}`, type: "dimension", entityIds: [rectId], parameter: "width", label: "Driven width" },
        { id: `con-${randomUUID().slice(0, 8)}`, type: "dimension", entityIds: [rectId], parameter: "height", label: "Driven height" },
        { id: `con-${randomUUID().slice(0, 8)}`, type: "dimension", entityIds: [holeId], parameter: "holeRadius", label: "Driven hole radius" }
      ]
    },
    features: [
      { id: `feat-${randomUUID().slice(0, 8)}`, type: "extrude", entityId: rectId, operation: "new", distanceParam: "depth", createdAt: now },
      { id: `feat-${randomUUID().slice(0, 8)}`, type: "extrude", entityId: holeId, operation: "cut", distanceParam: "depth", createdAt: now }
    ],
    selectedEntityId: rectId,
    updatedAt: now
  };
}

function templates() {
  return [
    {
      id: "mounting-bracket",
      title: "Parametric mounting bracket",
      target: "Create a constrained bracket with a driven base, mounting hole, extrude, and at least one revolve feature.",
      expectedParameters: ["width", "height", "depth", "holeRadius"],
      rubric: ["closed profile", "driven dimensions", "extrude/cut features", "clean feature order"],
      starterDocument: defaultDocument()
    }
  ];
}

function createInterviewSession(user, templateId) {
  const template = templates().find((item) => item.id === templateId) || templates()[0];
  const now = new Date().toISOString();
  const interviewSession = {
    id: `cad-${randomUUID().slice(0, 8)}`,
    title: template.title,
    templateId: template.id,
    candidateName: user.name,
    interviewerName: user.master ? user.name : "Interviewer",
    status: "active",
    createdAt: now,
    updatedAt: now,
    document: template.starterDocument,
    eventLog: [
      {
        id: `evt-${randomUUID().slice(0, 8)}`,
        type: "session_created",
        actor: user.email,
        at: now,
        detail: "Session created"
      }
    ]
  };
  state.interviewSessions[interviewSession.id] = interviewSession;
  saveState();
  return interviewSession;
}

function logEvent(session, user, type, detail) {
  session.eventLog.push({
    id: `evt-${randomUUID().slice(0, 8)}`,
    type,
    actor: user.email,
    at: new Date().toISOString(),
    detail
  });
  session.eventLog = session.eventLog.slice(-300);
}

function grade(document) {
  const checks = [
    {
      label: "Sketch geometry",
      ok: document.sketch.entities.length >= 2,
      detail: `${document.sketch.entities.length} sketch entities`
    },
    {
      label: "Driving dimensions",
      ok: Object.keys(document.parameters).length >= 4,
      detail: `${Object.keys(document.parameters).length} parameters`
    },
    {
      label: "Extrude feature",
      ok: document.features.some((feature) => feature.type === "extrude"),
      detail: "Extrude is present"
    },
    {
      label: "Revolve feature",
      ok: document.features.some((feature) => feature.type === "revolve"),
      detail: "Revolve is present"
    },
    {
      label: "Cut/add operation",
      ok: document.features.some((feature) => ["cut", "add"].includes(feature.operation)),
      detail: "Boolean operation is present"
    }
  ];
  const score = Math.round((checks.filter((check) => check.ok).length / checks.length) * 100);
  return { score, checks };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, auth: keycloakEnabled() ? "keycloak" : "dev", at: new Date().toISOString() });
    return true;
  }

  if (url.pathname === "/api/auth/config" && req.method === "GET") {
    sendJson(res, 200, authConfig(req));
    return true;
  }

  if (url.pathname === "/api/auth/keycloak-login" && req.method === "POST") {
    if (!keycloakEnabled()) {
      throw httpError(400, "Keycloak sign-in is not configured");
    }
    const body = await parseBody(req);
    let idToken = String(body.idToken || "").trim();
    if (!idToken && body.code) {
      const tokenResponse = await exchangeKeycloakAuthorizationCode(body);
      idToken = String(tokenResponse.id_token || "");
    }
    if (!idToken) {
      throw httpError(400, "Keycloak authorization code or idToken is required");
    }
    const claims = await validateJwt(idToken);
    sendJson(res, 200, { session: issueSession(claims) });
    return true;
  }

  if (url.pathname === "/api/auth/dev-login" && req.method === "POST") {
    if (!ALLOW_DEV_AUTH) {
      throw httpError(404, "Dev auth is disabled");
    }
    sendJson(res, 200, {
      session: issueSession(
        {
          sub: `dev-${createHash("sha1").update("local").digest("hex")}`,
          email: "local.cad@example.test",
          name: "Local CAD User"
        },
        "dev"
      )
    });
    return true;
  }

  if (url.pathname === "/api/me" && req.method === "GET") {
    sendJson(res, 200, { session: requireAuth(req) });
    return true;
  }

  if (url.pathname === "/api/interview/templates" && req.method === "GET") {
    requireAuth(req);
    sendJson(res, 200, { templates: templates() });
    return true;
  }

  if (url.pathname === "/api/interview/sessions" && req.method === "POST") {
    const user = requireAuth(req);
    const body = await parseBody(req);
    sendJson(res, 200, { session: createInterviewSession(user, String(body.templateId || "")) });
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/interview\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (sessionMatch) {
    const user = requireAuth(req);
    const interviewSession = state.interviewSessions[sessionMatch[1]];
    if (!interviewSession) {
      throw httpError(404, "Interview session was not found");
    }
    const action = sessionMatch[2] || "";

    if (!action && req.method === "GET") {
      sendJson(res, 200, { session: interviewSession });
      return true;
    }

    if (action === "document" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.document?.sketch || !body.document?.features) {
        throw httpError(400, "CAD document is required");
      }
      interviewSession.document = body.document;
      interviewSession.updatedAt = new Date().toISOString();
      logEvent(interviewSession, user, "document_saved", "Document saved");
      saveState();
      sendJson(res, 200, { session: interviewSession });
      return true;
    }

    if (action === "events" && req.method === "POST") {
      const body = await parseBody(req);
      logEvent(interviewSession, user, String(body.type || "event"), String(body.detail || ""));
      interviewSession.updatedAt = new Date().toISOString();
      saveState();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action === "submit" && req.method === "POST") {
      const body = await parseBody(req);
      const submittedDocument = body.document?.sketch ? body.document : interviewSession.document;
      const result = grade(submittedDocument);
      interviewSession.document = submittedDocument;
      interviewSession.status = "submitted";
      interviewSession.updatedAt = new Date().toISOString();
      interviewSession.submission = {
        id: `sub-${randomUUID().slice(0, 8)}`,
        submittedAt: interviewSession.updatedAt,
        score: result.score,
        checks: result.checks,
        document: submittedDocument
      };
      state.submissions.push({ sessionId: interviewSession.id, ...interviewSession.submission });
      logEvent(interviewSession, user, "submitted", `Score ${result.score}`);
      saveState();
      sendJson(res, 200, { session: interviewSession });
      return true;
    }
  }

  return false;
}

function serveStatic(req, res, url) {
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const requested = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(staticRoot, requested);
  if (!filePath.startsWith(staticRoot)) {
    sendError(res, 403, "Forbidden");
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(staticRoot, "index.html");
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".wasm": "application/wasm"
  };
  res.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) {
        sendError(res, 404, "API route was not found");
      }
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    sendError(res, status, error.message || "Server error", error.details || "");
  }
});

server.listen(PORT, () => {
  console.log(`VCAD Interview listening on http://localhost:${PORT}`);
});
