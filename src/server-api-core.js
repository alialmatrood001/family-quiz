const KNOWN_TRANSPORTS = new Set(["callable", "vercel"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const FINALIZE_TIMEOUT_MS = 25_000;

export const SERVER_OPERATIONS = Object.freeze({
  registerPlayer: { endpoint: "player" },
  recoverPlayer: { endpoint: "player" },
  submitAnswer: { endpoint: "player" },
  activateJoker: { endpoint: "player" },
  cancelJoker: { endpoint: "player" },
  updatePlayerProfile: { endpoint: "player" },
  prepareQuestion: { endpoint: "quiz" },
  startQuestion: { endpoint: "quiz" },
  controlQuestion: { endpoint: "quiz" },
  finalizeQuestion: { endpoint: "quiz", timeoutMs: FINALIZE_TIMEOUT_MS },
  adjustPlayerScore: { endpoint: "admin" },
  getPlayerPrivateDetails: { endpoint: "admin" },
  initializeQuiz: { endpoint: "admin" },
  deletePlayer: { endpoint: "admin" },
  resetPracticeScores: { endpoint: "admin" },
  resetQuizData: { endpoint: "admin" },
});

export class ServerApiError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(String(message || "Server request failed"), cause ? { cause } : undefined);
    this.name = "ServerApiError";
    this.code = String(code || "internal");
    if (status !== undefined) this.status = status;
  }
}

export function resolveServerTransport(value) {
  const transport = String(value || "").trim() || "callable";
  if (!KNOWN_TRANSPORTS.has(transport)) {
    throw new ServerApiError(
      "invalid-server-transport",
      `Unsupported server transport: ${transport}`,
    );
  }
  return transport;
}

export function normalizeServerError(error, fallbackMessage) {
  if (error instanceof ServerApiError) return error;
  return new ServerApiError(
    String(error?.code || "internal").replace(/^functions\//, ""),
    String(error?.message || fallbackMessage || "Server request failed"),
    { status: error?.status, cause: error },
  );
}

function mergeAbortSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new ServerApiError("network-error", "Server returned an invalid response", {
      status: response.status,
      cause: error,
    });
  }
}

function publicFailure(body, status) {
  return new ServerApiError(
    body?.error?.code || (status === 401 ? "unauthenticated" : "internal"),
    body?.error?.message || "Server request failed",
    { status },
  );
}

export function createServerApiClient({
  transport = "callable",
  auth,
  callableInvoker,
  fetchImpl = globalThis.fetch,
  apiBase = "",
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const selectedTransport = resolveServerTransport(transport);

  async function callCallable(operation, data, fallbackMessage) {
    if (typeof callableInvoker !== "function") {
      throw new ServerApiError("internal", "Firebase Callable adapter is unavailable");
    }
    try {
      return await callableInvoker(operation, data);
    } catch (error) {
      throw normalizeServerError(error, fallbackMessage);
    }
  }

  async function vercelAttempt(operation, data, token, signal) {
    const definition = SERVER_OPERATIONS[operation];
    let response;
    try {
      response = await fetchImpl(`${apiBase}/api/${definition.endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: operation, data }),
        signal,
        cache: "no-store",
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ServerApiError("network-error", "Unable to reach the server", { cause: error });
    }
    const body = await parseJson(response);
    if (!response.ok || body?.ok !== true) throw publicFailure(body, response.status);
    return body.data;
  }

  async function callVercel(operation, data, { signal, timeoutMs } = {}) {
    const user = auth?.currentUser;
    if (!user || typeof user.getIdToken !== "function") {
      throw new ServerApiError("unauthenticated", "Authentication is required", { status: 401 });
    }
    const requestAbort = mergeAbortSignal(
      signal,
      timeoutMs || SERVER_OPERATIONS[operation].timeoutMs || defaultTimeoutMs,
    );
    try {
      const token = await user.getIdToken(false);
      try {
        return await vercelAttempt(operation, data, token, requestAbort.signal);
      } catch (error) {
        if (!(error instanceof ServerApiError) || error.status !== 401) throw error;
        const refreshedToken = await user.getIdToken(true);
        return await vercelAttempt(operation, data, refreshedToken, requestAbort.signal);
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new ServerApiError(
          requestAbort.timedOut() ? "request-timeout" : "cancelled",
          requestAbort.timedOut() ? "Server request timed out" : "Request was cancelled",
          { cause: error },
        );
      }
      throw normalizeServerError(error);
    } finally {
      requestAbort.cleanup();
    }
  }

  async function call(operation, data = {}, options = {}) {
    if (!Object.hasOwn(SERVER_OPERATIONS, operation)) {
      throw new ServerApiError("invalid-argument", `Unknown server operation: ${operation}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ServerApiError("invalid-argument", "Operation data must be an object");
    }
    const trustedData = { ...data };
    delete trustedData.uid;
    delete trustedData.authUid;
    return selectedTransport === "vercel"
      ? callVercel(operation, trustedData, options)
      : callCallable(operation, trustedData, options.fallbackMessage);
  }

  const client = { call, transport: selectedTransport };
  for (const operation of Object.keys(SERVER_OPERATIONS)) {
    client[operation] = (data, options) => call(operation, data, options);
  }
  return Object.freeze(client);
}
