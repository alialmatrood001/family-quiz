const EMULATOR_CONNECTION_FLAG = '__FAMILY_QUIZ_FIREBASE_EMULATORS_CONNECTED__'

export async function connectFirebaseEmulators() {
  if (!import.meta.env.DEV || globalThis[EMULATOR_CONNECTION_FLAG]) {
    return
  }

  globalThis[EMULATOR_CONNECTION_FLAG] = true

  const [
    { getApp },
    { getAuth, connectAuthEmulator },
    { getDatabase, connectDatabaseEmulator },
    { getFirestore, connectFirestoreEmulator },
    { getFunctions, connectFunctionsEmulator },
  ] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/database'),
    import('firebase/firestore'),
    import('firebase/functions'),
  ])

  try {
    const app = getApp()
    const db = getFirestore(app)
    const functions = getFunctions(app, 'us-central1')
    const auth = getAuth(app)
    const realtimeDb = getDatabase(app)

    connectFirestoreEmulator(db, '127.0.0.1', 8080)
    connectFunctionsEmulator(functions, '127.0.0.1', 5001)
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', {
      disableWarnings: true,
    })
    connectDatabaseEmulator(realtimeDb, '127.0.0.1', 9000)

    console.info('[development] Firebase Emulator Suite connected on localhost.')
  } catch (error) {
    globalThis[EMULATOR_CONNECTION_FLAG] = false
    console.error('[development] Firebase Emulator Suite setup failed.', error)
  }
}
