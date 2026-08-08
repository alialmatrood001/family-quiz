import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import process from "node:process";
import {
  ensureServerRequestDatabase,
  serverRuntime,
  withServerRequestIdentity,
} from "./server-runtime.js";

const require = createRequire(import.meta.url);
const {
  measureServerTiming,
  runWithServerTimings,
  serverTimingHeader,
  serverTimingSnapshot,
} = require("../../functions/server/request-timing.js");

export const MAX_JSON_BYTES = 32 * 1024;

const LOCAL_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const STATUS_BY_CODE = {
  aborted: 409,
  "already-exists": 409,
  "deadline-exceeded": 504,
  "failed-precondition": 409,
  internal: 500,
  "invalid-argument": 400,
  "not-found": 404,
  "permission-denied": 403,
  "resource-exhausted": 429,
  unauthenticated: 401,
  unavailable: 503,
};

const SAFE_MESSAGES = {
  internal: "The operation could not be completed",
  "invalid-token": "Authentication token is invalid",
  "missing-token": "Authentication is required",
  "server-authentication-unavailable": "Server authentication is temporarily unavailable",
  "server-configuration-error": "Server authentication configuration is invalid",
  "unknown-action": "The requested action is not supported",
};

const STAGING_FIREBASE_PROJECT_ID = "family-quiz-staging";
export function environmentGuardDiagnostic(error) {
  if (error?.diagnosticStage !== "environment-guard") return null;
  return Object.freeze({
    failedCheck: String(error.failedCheck || "unknown-environment-check"),
    configurationVariable: String(error.configurationVariable || "unknown"),
    expectedValue: String(error.expectedValue || "unspecified"),
    actualValue: String(error.actualValue || "unspecified"),
  });
}

function copySafeDiagnostic(source, target) {
  for (const name of [
    "diagnosticStage",
    "failedCheck",
    "configurationVariable",
    "expectedValue",
    "actualValue",
  ]) {
    if (typeof source?.[name] === "string" && source[name]) {
      target[name] = source[name];
    }
  }
  return target;
}

function runtimeInitializationDiagnostic(error) {
  const code = String(error?.code || "");
  if (code === "firestore/invalid-credential") {
    return Object.freeze({
      diagnosticStage: "firebase-admin-initialization",
      failedCheck: "firebase-admin-firestore-credential-compatibility",
      configurationVariable: "FIREBASE_ADMIN_AUTH_MODE",
      expectedValue: "Firebase Admin credential compatible with Firestore",
      actualValue: "firestore/invalid-credential",
    });
  }
  return Object.freeze({
    diagnosticStage: "firebase-admin-initialization",
    failedCheck: "firebase-admin-runtime-initialization",
    configurationVariable: "FIREBASE_ADMIN_AUTH_MODE",
    expectedValue: "successful Firebase Admin initialization",
    actualValue: code || "initialization-failed",
  });
}

export function safeServerFailureDiagnostic(error, normalized) {
  const guardDiagnostic = environmentGuardDiagnostic(error);
  if (guardDiagnostic) {
    return Object.freeze({
      failedStage: "environment-guard",
      ...guardDiagnostic,
      errorCode: normalized.code,
    });
  }
  const safeToken = (value, fallback) => {
    const token = String(value || "");
    return /^[a-z0-9_./:-]{1,100}$/i.test(token) ? token : fallback;
  };
  const resetDiagnostic = error?.failedStep
    ? {
        failedStep: safeToken(error.failedStep, "unknown-reset-step"),
        firestoreCode: safeToken(error.firestoreCode || error.code, "unknown"),
        elapsedMs: Number.isFinite(Number(error.elapsedMs))
          ? Math.max(0, Math.round(Number(error.elapsedMs)))
          : 0,
      }
    : {};
  return Object.freeze({
    failedStage: String(error?.diagnosticStage || "unknown"),
    failedCheck: String(error?.failedCheck || "server-runtime-failure"),
    configurationVariable: String(error?.configurationVariable || "not-applicable"),
    expectedValue: String(error?.expectedValue || "successful server request"),
    actualValue: String(error?.actualValue || "failed"),
    errorCode: normalized.code,
    ...resetDiagnostic,
  });
}

function logSafeServerFailure(error, normalized) {
  if (
    process.env.APP_ENVIRONMENT !== "staging" ||
    process.env.STAGING_AUTH_DIAGNOSTICS === "false" ||
    normalized.status < 500
  ) return;
  console.error(
    "staging-server-auth-diagnostic",
    safeServerFailureDiagnostic(error, normalized),
  );
}

function configuredOrigins() {
  const configured = String(process.env.VERCEL_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (process.env.APP_ENVIRONMENT === "staging") {
    const stagingOrigin = String(process.env.STAGING_ORIGIN || "").trim();
    const productionOrigin = String(process.env.PRODUCTION_ORIGIN || "").trim();
    let parsed;
    try {
      parsed = new URL(stagingOrigin);
    } catch {
      throw httpError(500, "staging-configuration-invalid", "Staging configuration is invalid");
    }
    if (
      !stagingOrigin ||
      parsed.protocol !== "https:" ||
      parsed.origin !== stagingOrigin ||
      stagingOrigin.includes("*") ||
      stagingOrigin === productionOrigin ||
      configured.length !== 1 ||
      configured[0] !== stagingOrigin
    ) {
      throw httpError(500, "staging-configuration-invalid", "Staging configuration is invalid");
    }
    return new Set([...LOCAL_ORIGINS, stagingOrigin]);
  }
  return new Set([...LOCAL_ORIGINS, ...configured]);
}

function setCors(req, res, methods = ["POST", "OPTIONS"]) {
  const origin = req.headers?.origin;
  if (!origin) return;
  if (!configuredOrigins().has(origin)) {
    throw httpError(403, "origin-not-allowed", "Request origin is not allowed");
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
  res.setHeader("Access-Control-Expose-Headers", "Server-Timing");
}

function completeServerTimings(res) {
  const snapshot = serverTimingSnapshot();
  res.setHeader("Server-Timing", serverTimingHeader(snapshot));
  if (process.env.APP_ENVIRONMENT === "staging") {
    console.info("staging-server-timing", snapshot);
  }
  return snapshot;
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.httpStatus = status;
  error.stableCode = code;
  return error;
}

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.status(status).json(body);
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function contentLength(req) {
  const declared = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declared) && declared > 0) return declared;
  if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
    return Buffer.byteLength(req.body);
  }
  return Buffer.byteLength(JSON.stringify(req.body ?? {}));
}

function parseProtocolBody(req) {
  if (contentLength(req) > MAX_JSON_BYTES) {
    throw httpError(413, "body-too-large", "Request body is too large");
  }
  const contentType = String(req.headers?.["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType && contentType !== "application/json") {
    throw httpError(415, "unsupported-media-type", "Content-Type must be application/json");
  }
  let body = req.body;
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString());
    } catch {
      throw httpError(400, "invalid-json", "Request body must be valid JSON");
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "invalid-request", "Request body must be an object");
  }
  if (
    Object.keys(body).some((key) => !["action", "data"].includes(key)) ||
    typeof body.action !== "string" ||
    !body.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data)
  ) {
    throw httpError(400, "invalid-request", "Request must contain action and data");
  }
  return body;
}

function bearerToken(req) {
  const authorization = String(req.headers?.authorization || "");
  if (!authorization) {
    throw httpError(401, "missing-token", SAFE_MESSAGES["missing-token"]);
  }
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!match) {
    throw httpError(401, "invalid-token", SAFE_MESSAGES["invalid-token"]);
  }
  return match[1];
}

export function inspectFirebaseIdToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = typeof token === "string" ? token.split(".") : [];
  let claims = null;
  if (parts.length === 3 && parts[0] && parts[1]) {
    try {
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      claims = null;
    }
  }
  return Object.freeze({
    present: typeof token === "string" && token.length > 0,
    partCount: parts.length,
    payloadReadable: Boolean(claims && typeof claims === "object" && !Array.isArray(claims)),
    aud: typeof claims?.aud === "string" ? claims.aud : null,
    iss: typeof claims?.iss === "string" ? claims.iss : null,
    subPresent: typeof claims?.sub === "string" && claims.sub.length > 0,
    adminClaimPresent: claims?.admin === true,
    expValid: Number.isFinite(claims?.exp) && claims.exp > nowSeconds,
  });
}

function expectedFirebaseProjectId(env) {
  const emulatorMode = Boolean(
    env.FIRESTORE_EMULATOR_HOST ||
      env.FIREBASE_AUTH_EMULATOR_HOST ||
      env.FIREBASE_DATABASE_EMULATOR_HOST,
  );
  if (emulatorMode) {
    return (
      env.GCLOUD_PROJECT ||
      env.GOOGLE_CLOUD_PROJECT ||
      env.FIREBASE_ADMIN_PROJECT_ID ||
      "demo-family-quiz"
    );
  }
  if (env.APP_ENVIRONMENT === "staging") {
    if (env.FIREBASE_ADMIN_PROJECT_ID !== STAGING_FIREBASE_PROJECT_ID) {
      throw httpError(
        500,
        "server-configuration-error",
        SAFE_MESSAGES["server-configuration-error"],
      );
    }
    return STAGING_FIREBASE_PROJECT_ID;
  }
  const projectId =
    env.FIREBASE_ADMIN_PROJECT_ID || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw httpError(
      500,
      "server-configuration-error",
      SAFE_MESSAGES["server-configuration-error"],
    );
  }
  return projectId;
}

function assertFirebaseTokenEnvelope(token, projectId, { allowUnsigned = false } = {}) {
  const diagnostic = inspectFirebaseIdToken(token);
  const signaturePresent = typeof token === "string" && Boolean(token.split(".")[2]);
  if (
    diagnostic.partCount !== 3 ||
    !diagnostic.payloadReadable ||
    (!allowUnsigned && !signaturePresent) ||
    diagnostic.aud !== projectId ||
    diagnostic.iss !== `https://securetoken.google.com/${projectId}` ||
    !diagnostic.subPresent ||
    !diagnostic.expValid
  ) {
    throw httpError(401, "invalid-token", SAFE_MESSAGES["invalid-token"]);
  }
  return diagnostic;
}

function tokenVerificationError(error) {
  const code = String(error?.code || "");
  if (!code || (code.startsWith("auth/") && code !== "auth/internal-error")) {
    return httpError(401, "invalid-token", SAFE_MESSAGES["invalid-token"]);
  }
  return httpError(
    503,
    "server-authentication-unavailable",
    SAFE_MESSAGES["server-authentication-unavailable"],
  );
}

export async function verifiedAuth(
  req,
  { runtimeFactory = serverRuntime, env = process.env } = {},
) {
  const token = bearerToken(req);
  const emulatorMode = Boolean(
    env.FIRESTORE_EMULATOR_HOST ||
      env.FIREBASE_AUTH_EMULATOR_HOST ||
      env.FIREBASE_DATABASE_EMULATOR_HOST,
  );
  const projectId = expectedFirebaseProjectId(env);
  assertFirebaseTokenEnvelope(token, projectId, { allowUnsigned: emulatorMode });
  let runtime;
  try {
    runtime = runtimeFactory();
  } catch (error) {
    const wrapped = httpError(
      500,
      "server-configuration-error",
      SAFE_MESSAGES["server-configuration-error"],
    );
    wrapped.cause = error;
    if (error?.diagnosticStage === "environment-guard") {
      copySafeDiagnostic(error, wrapped);
    } else {
      copySafeDiagnostic(runtimeInitializationDiagnostic(error), wrapped);
    }
    throw wrapped;
  }
  if (runtime?.projectId !== projectId || typeof runtime?.auth?.verifyIdToken !== "function") {
    throw httpError(
      500,
      "server-configuration-error",
      SAFE_MESSAGES["server-configuration-error"],
    );
  }
  let claims;
  try {
    claims = await measureServerTiming("verifyFirebaseTokenMs", () =>
      runtime.auth.verifyIdToken(token),
    );
  } catch (error) {
    throw tokenVerificationError(error);
  }
  if (
    claims?.aud !== projectId ||
    claims?.iss !== `https://securetoken.google.com/${projectId}` ||
    typeof claims?.sub !== "string" ||
    !claims.sub
  ) {
    throw httpError(401, "invalid-token", SAFE_MESSAGES["invalid-token"]);
  }
  return { uid: claims.uid || claims.sub, token: claims };
}

function normalizeError(error) {
  if (error?.diagnosticStage === "environment-guard") {
    return {
      status: 500,
      code: "server-configuration-error",
      message: SAFE_MESSAGES["server-configuration-error"],
    };
  }
  if (error?.stableCode && error?.httpStatus) {
    return {
      status: error.httpStatus,
      code: error.stableCode,
      message: error.message,
    };
  }
  const rawCode = String(error?.code || "").replace(/^functions\//, "");
  const code = STATUS_BY_CODE[rawCode] ? rawCode : "internal";
  return {
    status: STATUS_BY_CODE[code] || 500,
    code,
    message: code === "internal" ? SAFE_MESSAGES.internal : String(error?.message || "Request failed"),
  };
}

export function createActionEndpoint({
  actions,
  adminOnly = false,
  runtimeFactory = serverRuntime,
  requestIdentity = withServerRequestIdentity,
}) {
  const allowed = new Set(actions);
  return async function actionEndpoint(req, res) {
    return runWithServerTimings(async () => {
      try {
        setNoStore(res);
        setCors(req, res);
        if (req.method === "OPTIONS") {
          completeServerTimings(res);
          res.status(204).end();
          return;
        }
        if (req.method !== "POST") {
          throw httpError(405, "method-not-allowed", "Only POST is supported");
        }
        const { action, data } = parseProtocolBody(req);
        if (!allowed.has(action)) {
          throw httpError(404, "unknown-action", SAFE_MESSAGES["unknown-action"]);
        }
        const result = await requestIdentity(req, async () => {
          const auth = await verifiedAuth(req, { runtimeFactory });
          if (adminOnly && auth.token?.admin !== true) {
            throw httpError(403, "permission-denied", "Admin permission is required");
          }
          await ensureServerRequestDatabase();
          const operation = runtimeFactory().operations[action];
          if (typeof operation !== "function") {
            throw httpError(404, "unknown-action", SAFE_MESSAGES["unknown-action"]);
          }
          return measureServerTiming("firestoreOperationMs", () => operation({ auth, data }));
        });
        completeServerTimings(res);
        send(res, 200, { ok: true, data: result ?? {} });
      } catch (error) {
        const normalized = normalizeError(error);
        logSafeServerFailure(error, normalized);
        completeServerTimings(res);
        send(res, normalized.status, {
          ok: false,
          error: {
            code: normalized.code,
            message: normalized.message,
          },
        });
      }
    });
  };
}

export function createHealthEndpoint() {
  return async function healthEndpoint(req, res) {
    return runWithServerTimings(async () => {
      try {
        setNoStore(res);
        setCors(req, res, ["GET", "OPTIONS"]);
        if (req.method === "OPTIONS") {
          completeServerTimings(res);
          res.status(204).end();
          return;
        }
        if (req.method !== "GET") {
          throw httpError(405, "method-not-allowed", "Only GET is supported");
        }
        completeServerTimings(res);
        send(res, 200, {
          ok: true,
          data: {
            status: "ok",
            service: "family-quiz-vercel-api",
            environment:
              process.env.APP_ENVIRONMENT ||
              (process.env.FIRESTORE_EMULATOR_HOST ? "local-emulator" : "local"),
            transport: process.env.SERVER_TRANSPORT || "vercel",
          },
        });
      } catch (error) {
        const normalized = normalizeError(error);
        completeServerTimings(res);
        send(res, normalized.status, {
          ok: false,
          error: {
            code: normalized.code,
            message: normalized.message,
          },
        });
      }
    });
  };
}
