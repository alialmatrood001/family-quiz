import { readFile } from 'node:fs/promises'
import { initializeApp, deleteApp } from 'firebase/app'
import {
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  setDoc,
  terminate,
} from 'firebase/firestore'

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST

if (!emulatorHost) {
  throw new Error(
    'Refusing to run: FIRESTORE_EMULATOR_HOST is required so this check cannot write to production.',
  )
}

const hostMatch = emulatorHost.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/)
if (!hostMatch) {
  throw new Error('FIRESTORE_EMULATOR_HOST must use the host:port format.')
}

const host = hostMatch[1].replace(/^\[|\]$/g, '')
const port = Number(hostMatch[2])
const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1'])

if (!allowedHosts.has(host) || !Number.isInteger(port) || port <= 0) {
  throw new Error('Refusing to run: the Firestore emulator must be on localhost.')
}

const firebasercUrl = new URL('../.firebaserc', import.meta.url)
const firebaserc = JSON.parse(await readFile(firebasercUrl, 'utf8'))
const projectId = process.env.GCLOUD_PROJECT || firebaserc?.projects?.default

if (!projectId) {
  throw new Error('No Firebase project ID is available for the emulator namespace.')
}

const app = initializeApp({ projectId }, `emulator-health-${process.pid}`)
const db = getFirestore(app)
connectFirestoreEmulator(db, host, port)

const checkRef = doc(db, 'emulatorHealth', 'check')

try {
  await setDoc(checkRef, {
    ok: true,
    createdAtMs: Date.now(),
    source: 'local-emulator-check',
  })

  const snapshot = await getDoc(checkRef)
  if (!snapshot.exists() || snapshot.data()?.ok !== true) {
    throw new Error('The emulator health document could not be read back.')
  }

  console.log('Firestore Emulator write/read check passed.')
  await deleteDoc(checkRef)

  const deletedSnapshot = await getDoc(checkRef)
  if (deletedSnapshot.exists()) {
    throw new Error('The emulator health document could not be deleted.')
  }

  console.log('Firestore Emulator delete check passed.')
} finally {
  await terminate(db).catch(() => {})
  await deleteApp(app).catch(() => {})
}
