export function createAnonymousPlayerAuthEnsurer({ auth, signInAnonymously }) {
  let signInFlight = null;

  return async function ensureAnonymousPlayerAuth() {
    if (typeof auth?.authStateReady === "function") {
      await auth.authStateReady();
    }
    if (auth?.currentUser) return auth.currentUser;
    if (!signInFlight) {
      signInFlight = Promise.resolve(signInAnonymously(auth))
        .then((credential) => credential.user)
        .finally(() => {
          signInFlight = null;
        });
    }
    return signInFlight;
  };
}
