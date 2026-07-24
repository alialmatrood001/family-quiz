import {
  getIdTokenResult,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { auth } from "./firebase.js";

function toAdminSession(user, tokenResult = null) {
  return {
    user,
    claims: tokenResult?.claims || {},
    isAdmin: tokenResult?.claims?.admin === true,
  };
}

export function createAdminAuthService(authInstance) {
  return {
    async signIn(email, password) {
      const credential = await signInWithEmailAndPassword(
        authInstance,
        String(email || "").trim(),
        password,
      );
      const tokenResult = await getIdTokenResult(credential.user, true);
      return toAdminSession(credential.user, tokenResult);
    },

    async signOut() {
      await signOut(authInstance);
    },

    async refreshClaims() {
      if (!authInstance.currentUser) {
        return toAdminSession(null);
      }
      const tokenResult = await getIdTokenResult(authInstance.currentUser, true);
      return toAdminSession(authInstance.currentUser, tokenResult);
    },

    subscribe(listener) {
      return onIdTokenChanged(authInstance, async (user) => {
        if (!user) {
          listener(toAdminSession(null));
          return;
        }

        try {
          const tokenResult = await getIdTokenResult(user);
          listener(toAdminSession(user, tokenResult));
        } catch (error) {
          listener({ ...toAdminSession(user), error });
        }
      });
    },
  };
}

export const adminAuth = createAdminAuthService(auth);
