export const APP_VIEWS = Object.freeze({
  PLAYER: "player",
  CONTROL: "control",
  PRESENTER: "presenter",
  DISPLAY: "display",
  SETTINGS: "settings",
  LAST_GAME: "lastgame",
});

const ADMIN_VIEWS = new Set([
  APP_VIEWS.CONTROL,
  APP_VIEWS.PRESENTER,
  APP_VIEWS.SETTINGS,
  APP_VIEWS.LAST_GAME,
]);

export function resolveRequestedView(search = "") {
  const params = new URLSearchParams(search);
  const requested = params.get("view");
  if (requested === APP_VIEWS.DISPLAY) return APP_VIEWS.DISPLAY;
  if (ADMIN_VIEWS.has(requested)) return requested;
  if (params.has("admin")) return APP_VIEWS.CONTROL;
  return APP_VIEWS.PLAYER;
}

export function viewRequiresAdmin(view) {
  return ADMIN_VIEWS.has(view);
}
