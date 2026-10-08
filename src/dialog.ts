/**
 * A modal dialog that keeps focus inside it: Tab and Shift+Tab wrap, Escape and a click on the backdrop close it, and
 * focus goes back to what opened it. Plain elements (no <dialog>), so it behaves the same in every web view.
 */
export interface DialogOptions {
  title: string;
  closeLabel: string;
  /** Where focus returns when the dialog closes. */
  opener?: HTMLElement | null;
  onClose?: () => void;
}

export interface Dialog {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  close(): void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let opened = 0;

export function openDialog(host: HTMLElement, options: DialogOptions): Dialog {
  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  const panel = document.createElement("div");
  panel.className = "dialog";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  const titleId = `dialog-title-${++opened}`;
  panel.setAttribute("aria-labelledby", titleId);
  const head = document.createElement("div");
  head.className = "dialog-head";
  const title = document.createElement("h2");
  title.id = titleId;
  title.textContent = options.title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn";
  close.textContent = "×";
  close.setAttribute("aria-label", options.closeLabel);
  head.append(title, close);
  const body = document.createElement("div");
  body.className = "dialog-body";
  panel.append(head, body);
  backdrop.append(panel);
  host.append(backdrop);

  let done = false;
  const dialog: Dialog = {
    element: panel,
    body,
    close() {
      if (done) return;
      done = true;
      backdrop.remove();
      options.onClose?.();
      options.opener?.focus();
    },
  };
  close.addEventListener("click", () => dialog.close());
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) dialog.close();
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  queueMicrotask(() => (body.querySelector<HTMLElement>(FOCUSABLE) ?? close).focus());
  return dialog;
}
