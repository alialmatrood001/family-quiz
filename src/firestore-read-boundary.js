const DEFAULT_READ_ERROR_MESSAGE =
  "تعذر تحميل بيانات المسابقة. تحقق من صلاحيات القراءة ثم حاول مرة أخرى.";

export function adminFirestoreListenersReady(session) {
  return session?.loading === false && session?.user != null && session?.isAdmin === true;
}

export function firestoreReadFailure(error, path) {
  const code = String(error?.code || "unknown");
  return Object.freeze({
    code,
    path: String(path || "unknown"),
    message:
      code === "permission-denied"
        ? "تعذر قراءة بيانات المسابقة بسبب عدم نشر صلاحيات Firestore المطلوبة لبيئة Staging."
        : DEFAULT_READ_ERROR_MESSAGE,
  });
}

export function startFirestoreListener({
  enabled = true,
  path,
  subscribe,
  onData,
  onError,
}) {
  if (!enabled) return () => {};
  return subscribe(
    onData,
    (error) => onError?.(firestoreReadFailure(error, path)),
  );
}

export async function confirmFirestoreDocumentReadable({ path, read }) {
  try {
    const snapshot = await read();
    if (!snapshot?.exists?.()) {
      throw Object.assign(new Error("لم يظهر مستند المسابقة بعد التهيئة."), {
        code: "not-found",
      });
    }
    return snapshot;
  } catch (error) {
    if (error?.code === "not-found") throw error;
    const failure = firestoreReadFailure(error, path);
    throw Object.assign(new Error(failure.message), failure, { cause: error });
  }
}

export { DEFAULT_READ_ERROR_MESSAGE };
