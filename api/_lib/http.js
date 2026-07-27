import { Buffer } from "node:buffer";
import process from "node:process";
import { serverRuntime } from "./server-runtime.js";

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
  "unknown-action": "The requested action is not supported",
};

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

function setCors(req, res) {
  const origin = req.headers?.origin;
  if (!origin) return;
  if (!configuredOrigins().has(origin)) {
    throw httpError(403, "origin-not-allowed", "Request origin is not allowed");
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!match) {
    throw httpError(401, "missing-token", SAFE_MESSAGES["missing-token"]);
  }
  return match[1];
}

async function verifiedAuth(req) {
  const token = bearerToken(req);
  try {
    const claims = await serverRuntime().auth.verifyIdToken(token);
    return { uid: claims.uid || claims.sub, token: claims };
  } catch {
    throw httpError(401, "invalid-token", SAFE_MESSAGES["invalid-token"]);
  }
}

function normalizeError(error) {
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

export function createActionEndpoint({ actions, adminOnly = false }) {
  const allowed = new Set(actions);
  return async function actionEndpoint(req, res) {
    try {
      setNoStore(res);
      setCors(req, res);
      if (req.method === "OPTIONS") {
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
      const auth = await verifiedAuth(req);
      if (adminOnly && auth.token?.admin !== true) {
        throw httpError(403, "permission-denied", "Admin permission is required");
      }
      const operation = serverRuntime().operations[action];
      if (typeof operation !== "function") {
        throw httpError(404, "unknown-action", SAFE_MESSAGES["unknown-action"]);
      }
      const result = await operation({ auth, data });
      send(res, 200, { ok: true, data: result ?? {} });
    } catch (error) {
      const normalized = normalizeError(error);
      send(res, normalized.status, {
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
        },
      });
    }
  };
}

export function createHealthEndpoint() {
  return async function healthEndpoint(req, res) {
    try {
      setNoStore(res);
      setCors(req, res);
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      if (req.method !== "GET") {
        throw httpError(405, "method-not-allowed", "Only GET is supported");
      }
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
      send(res, normalized.status, {
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
        },
      });
    }
  };
}
