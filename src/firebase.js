import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const defaultFirebaseConfig = {
  apiKey: "AIzaSyAMLo_Y6QnuyHfB-_XfFFcHmnun-sO4Mvc",
  authDomain: "family-quiz-b7960.firebaseapp.com",
  projectId: "family-quiz-b7960",
  storageBucket: "family-quiz-b7960.firebasestorage.app",
  messagingSenderId: "1002819143902",
  appId: "1:1002819143902:web:bc2b9becf69945d7485a4f",
  measurementId: "G-X2T4CPDNM0",
};

const stagingFirebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const firebaseConfig = stagingFirebaseConfig.projectId
  ? stagingFirebaseConfig
  : defaultFirebaseConfig;

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");
