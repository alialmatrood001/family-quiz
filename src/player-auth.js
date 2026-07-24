import { signInAnonymously } from "firebase/auth";
import { auth } from "./firebase.js";

let anonymousSignIn = null;

export async function ensureAnonymousPlayerAuth() {
  if (auth.currentUser) return auth.currentUser;
  if (!anonymousSignIn) {
    anonymousSignIn = signInAnonymously(auth)
      .then((credential) => credential.user)
      .finally(() => {
        anonymousSignIn = null;
      });
  }
  return anonymousSignIn;
}
