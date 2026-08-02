const INITIALIZATION_ERROR_MESSAGE = "تعذر إنشاء المسابقة. حاول مرة أخرى.";

export async function runQuizInitialization({ execute, setBusy, setError, onSuccess }) {
  setBusy(true);
  setError("");
  try {
    const result = await execute();
    onSuccess?.(result);
    return { ok: true, result };
  } catch (error) {
    setError(String(error?.message || INITIALIZATION_ERROR_MESSAGE));
    return { ok: false, error };
  } finally {
    setBusy(false);
  }
}

export { INITIALIZATION_ERROR_MESSAGE };
