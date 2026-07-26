import { normalizeServerError, serverApiClient } from "./server-api-client.js";

export function normalizeCallableError(error, fallbackMessage) {
  return normalizeServerError(error, fallbackMessage);
}

export function createSingleFlightCallable(name, fallbackMessage) {
  const inFlight = new Map();
  return async (data, key = JSON.stringify(data)) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = serverApiClient.call(name, data, { fallbackMessage })
      .catch((error) => {
        throw normalizeCallableError(error, fallbackMessage);
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, operation);
    return operation;
  };
}
