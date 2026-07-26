const FIREBASE_CLIENT_MODULE = "/src/firebase.js";

export async function load(url, context, nextLoad) {
  if (!url.replaceAll("\\", "/").endsWith(FIREBASE_CLIENT_MODULE)) {
    return nextLoad(url, context);
  }

  return {
    format: "module",
    shortCircuit: true,
    source: `
      import { getApps, initializeApp } from "firebase/app";
      import { connectAuthEmulator, getAuth } from "firebase/auth";
      import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
      import { connectFunctionsEmulator, getFunctions } from "firebase/functions";

      const name = "admin-flow-test-adapter";
      const existing = getApps().find((candidate) => candidate.name === name);
      export const app = existing || initializeApp({
        apiKey: "demo-api-key",
        authDomain: "demo-family-quiz.firebaseapp.com",
        projectId: "demo-family-quiz",
      }, name);
      export const auth = getAuth(app);
      export const db = getFirestore(app);
      export const functions = getFunctions(app, "us-central1");

      if (!globalThis.__ADMIN_FLOW_FIREBASE_ADAPTER_CONNECTED__) {
        connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
        connectFirestoreEmulator(db, "127.0.0.1", 8080);
        connectFunctionsEmulator(functions, "127.0.0.1", 5001);
        globalThis.__ADMIN_FLOW_FIREBASE_ADAPTER_CONNECTED__ = true;
      }
    `,
  };
}
