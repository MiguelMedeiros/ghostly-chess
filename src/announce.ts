/**
 * The page's one polite live region. Moves are announced here in words ("Your contact: knight to f6, check"), with game
 * ends and the notices that are not errors. The status line has no role of its own, so a move is not read twice;
 * errors go to the notice line, which keeps role=alert.
 *
 * A screen reader reads the region once the task that changed it ends, so the texts said in one task are joined, in
 * order and each once ("Your contact: pawn to e5. You: knight to f3"): a premove played on the contact's move, or a
 * mating move and the game's end, would otherwise leave only the last text to be heard.
 */
export interface Announcer {
  readonly element: HTMLElement;
  say(text: string): void;
}

/** `sep` goes between two texts of one task, after one with no full stop of its own (". ", or "。"). */
export function createAnnouncer(sep = ". "): Announcer {
  const element = document.createElement("div");
  element.className = "sr-only announce";
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "true");
  let last = "";
  // The texts said in this task; null once it ended.
  let task: string[] | null = null;
  return {
    element,
    say(text: string): void {
      if (!text) return;
      if (!task) {
        task = [];
        setTimeout(() => (task = null));
      }
      if (task.includes(text)) return;
      task.push(text);
      const all = task.reduce((a, b) => a + (/[.!?。！？]$/.test(a) ? " " : sep) + b);
      // The same words twice in a row (two "check"s) must still be read: a no-break space makes them new text.
      const next = all === last ? `${all}\u00a0` : all;
      last = next;
      element.textContent = next;
    },
  };
}
