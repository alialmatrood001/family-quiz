import { signInAnonymously } from "firebase/auth";
import { auth } from "./firebase.js";
import { createAnonymousPlayerAuthEnsurer } from "./player-auth-core.js";

export const ensureAnonymousPlayerAuth = createAnonymousPlayerAuthEnsurer({
  auth,
  signInAnonymously,
});
