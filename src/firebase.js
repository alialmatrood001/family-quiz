import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyAMLo_Y6QnuyHfB-_XfFFcHmnun-sO4Mvc",
  authDomain: "family-quiz-b7960.firebaseapp.com",
  projectId: "family-quiz-b7960",
  storageBucket: "family-quiz-b7960.firebasestorage.app",
  messagingSenderId: "1002819143902",
  appId: "1:1002819143902:web:bc2b9becf69945d7485a4f",
  measurementId: "G-X2T4CPDNM0",
};

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");
