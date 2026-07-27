import { Buffer } from "node:buffer";
import adminHandler from "../../../api/admin.js";
import healthHandler from "../../../api/health.js";
import playerHandler from "../../../api/player.js";
import quizHandler from "../../../api/quiz.js";

export const LOCAL_ORIGIN = "http://127.0.0.1:5173";

export const API_HANDLERS = Object.freeze({
  admin: adminHandler,
  health: healthHandler,
  player: playerHandler,
  quiz: quizHandler,
});

export function responseMock() {
  return {
    body: null,
    headers: {},
    statusCode: 200,
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

export async function invokeApi(
  endpoint,
  {
    method = "POST",
    token,
    action,
    data = {},
    origin = LOCAL_ORIGIN,
    body,
    headers = {},
  } = {},
) {
  const handler = typeof endpoint === "function" ? endpoint : API_HANDLERS[endpoint];
  if (!handler) throw new TypeError(`Unknown local endpoint: ${endpoint}`);
  const requestBody = body ?? (action === undefined ? undefined : { action, data });
  const serialized =
    typeof requestBody === "string" || Buffer.isBuffer(requestBody)
      ? requestBody
      : requestBody === undefined
        ? undefined
        : JSON.stringify(requestBody);
  const req = {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(serialized !== undefined
        ? {
            "content-length": String(Buffer.byteLength(serialized)),
            "content-type": "application/json",
          }
        : {}),
      ...headers,
    },
    body: serialized,
  };
  const res = responseMock();
  await handler(req, res);
  return res;
}

export async function localApiFetch(url, options) {
  const endpoint = String(url).split("/api/")[1];
  const response = await invokeApi(endpoint, {
    method: options.method,
    origin: LOCAL_ORIGIN,
    body: options.body,
    headers: Object.fromEntries(
      Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
    ),
  });
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    async json() {
      return response.body;
    },
  };
}

export function tokenAuth(token) {
  return {
    currentUser: {
      async getIdToken() {
        return token;
      },
    },
  };
}
