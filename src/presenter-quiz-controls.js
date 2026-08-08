import { createElement } from "react";

export function PresenterQuizControls({ controller }) {
  const { controls, busyAction, error, execute } = controller;
  return createElement(
    "div",
    { className: "display-presenter-bottom-dock", "aria-label": "أدوات تحكم المقدم" },
    createElement(
      "div",
      { className: "presenter-control-heading" },
      createElement("strong", null, "تحكم المقدم"),
      createElement("span", null, "الأوامر الحساسة تمر عبر الخادم"),
    ),
    createElement(
      "div",
      { className: "presenter-control-actions" },
      ...controls.map((control) => createElement(
        "button",
        {
          type: "button",
          key: control.id,
          className: control.primary ? "presenter-primary-action" : "presenter-secondary-action",
          disabled: control.disabled || busyAction !== null,
          onClick: () => void execute(control.id),
        },
        busyAction === control.id ? "جاري التنفيذ..." : control.label,
      )),
      controls.length === 0
        ? createElement("span", { className: "presenter-no-action" }, "لا يوجد إجراء خادمي مطلوب في هذه المرحلة.")
        : null,
    ),
    error ? createElement("p", { className: "presenter-control-error", role: "alert" }, error) : null,
  );
}
