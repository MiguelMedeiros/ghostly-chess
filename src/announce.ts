/**
 * The page's one polite live region. Moves are announced here in words ("Your contact: knight to f6, check"), with game
 * ends and the notices that are not errors. The status line has no role of its own, so a move is not read twice;
 * errors go to the notice line, which keeps role=alert.
 */
export interface Announcer {
  readonly element: HTMLElement;
  say(text: string): void;
}

export function createAnnouncer(): Announcer {
  const element = document.createElement("div");
  element.className = "sr-only announce";
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "true");
  let last = "";
  return {
    element,
    say(text: string): void {
      if (!text) return;
      // The same words twice in a row (two "check"s) must still be read: a no-break space makes them new text.
      const next = text === last ? `${text} ` : text;
      last = next;
      element.textContent = next;
    },
  };
}
