import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getServerFirebase } = require("../../functions/server/firebase-admin.js");
const { getServerOperations } = require("../../functions/server/operations.js");

export function serverRuntime() {
  const firebase = getServerFirebase();
  return {
    ...firebase,
    operations: getServerOperations(),
  };
}
