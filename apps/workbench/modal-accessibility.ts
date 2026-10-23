import { useEffect } from "react";

/** Shared keyboard boundary for every local dialog, including nested assistant dialogs. */
export function useModalAccessibility() {
  useEffect(() => {
    let active: HTMLElement | null = null;
    let previous: HTMLElement | null = document.activeElement as HTMLElement;
    let inert: { element: HTMLElement; before: boolean }[] = [];
    const focusable = (dialog: HTMLElement) =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, a[href], [tabindex="0"], [contenteditable="true"]',
        ),
      ).filter(
        (element) =>
          !element.matches(":disabled") && element.getClientRects().length > 0,
      );
    function restore() {
      for (const item of inert) item.element.inert = item.before;
      inert = [];
    }
    function refresh() {
      const dialogs = document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-modal="true"]',
      );
      const next = dialogs.length ? dialogs[dialogs.length - 1] : null;
      if (active === next) return;
      const hadDialog = !!active;
      restore();
      active = next;
      if (!active) {
        if (hadDialog && previous?.isConnected) previous.focus();
        return;
      }
      let branch: HTMLElement = active;
      while (branch.parentElement) {
        for (const sibling of Array.from(branch.parentElement.children))
          if (sibling !== branch && sibling instanceof HTMLElement) {
            inert.push({ element: sibling, before: sibling.inert });
            sibling.inert = true;
          }
        branch = branch.parentElement;
        if (branch === document.body) break;
      }
      if (!active.contains(document.activeElement)) {
        active.tabIndex = -1;
        (focusable(active)[0] || active).focus();
      }
    }
    function onFocus(event: FocusEvent) {
      const element = event.target as HTMLElement;
      if (!element.closest('[role="dialog"]')) {
        if (!active) previous = element;
        else (focusable(active)[0] || active).focus();
      }
    }
    function onKey(event: KeyboardEvent) {
      if (!active) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopImmediatePropagation();
        active
          .querySelector<HTMLButtonElement>(
            "button[data-dialog-save]:not(:disabled)",
          )
          ?.click();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const close = focusable(active).find((element) => {
          const label =
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            element.textContent?.trim() ||
            "";
          return label.startsWith("关闭") || label === "取消";
        });
        close?.click();
        return;
      }
      if (event.key !== "Tab") return;
      const targets = focusable(active),
        first = targets[0],
        last = targets[targets.length - 1];
      if (!first) {
        event.preventDefault();
        active.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !active.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !active.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    refresh();
    return () => {
      restore();
      observer.disconnect();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
    };
  }, []);
}
