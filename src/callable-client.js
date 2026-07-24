import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";

export function normalizeCallableError(error, fallbackMessage) {
  return {
    code: String(error?.code || "internal").replace(/^functions\//, ""),
    message: String(error?.message || fallbackMessage),
  };
}

export function createSingleFlightCallable(name, fallbackMessage) {
  const callable = httpsCallable(functions, name);
  const inFlight = new Map();
  return async (data, key = JSON.stringify(data)) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = callable(data)
      .then((response) => response.data)
      .catch((error) => {
        throw normalizeCallableError(error, fallbackMessage);
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, operation);
    return operation;
  };
}
