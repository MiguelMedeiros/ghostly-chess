/**
 * The settings dialog: board colours, piece set, coordinates, auto-queen, legal-move dots and premoves. Each change
 * is saved at once (PrefsStore writes only what changed) and the board redraws from it. Settings are per chat, as the
 * broker's storage is; the dialog says so.
 */
import { openDialog, type Dialog } from "./dialog.ts";
import { PIECE_SETS } from "./pieces.ts";
import { BOARD_THEMES, type Prefs, type PrefsStore } from "./prefs.ts";
import type { Strings } from "./strings.ts";

type Toggle = "coords" | "autoQueen" | "legal" | "premove";
const TOGGLES: [Toggle, keyof Strings][] = [
  ["coords", "set_coords"],
  ["autoQueen", "set_autoQueen"],
  ["legal", "set_legal"],
  ["premove", "set_premove"],
];

let groups = 0;

function radios<T extends string>(legend: string, values: readonly T[], label: (value: T) => string, current: T, pick: (value: T) => void): HTMLFieldSetElement {
  const set = document.createElement("fieldset");
  set.className = "choices";
  const title = document.createElement("legend");
  title.textContent = legend;
  set.append(title);
  const name = `choice-${++groups}`;
  for (const value of values) {
    const row = document.createElement("label");
    row.className = `choice choice-${value}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = value === current;
    input.addEventListener("change", () => input.checked && pick(value));
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label(value);
    row.append(input, swatch, text);
    set.append(row);
  }
  return set;
}

export function openSettings(host: HTMLElement, prefs: PrefsStore, t: Strings, opener?: HTMLElement | null): Dialog {
  const dialog = openDialog(host, { title: t.settings, closeLabel: t.close, opener });
  dialog.element.classList.add("settings");
  const now: Prefs = prefs.get();
  dialog.body.append(
    radios(t.set_theme, BOARD_THEMES, (v) => t[`theme_${v}`], now.theme, (theme) => void prefs.set({ theme })),
    radios(t.set_pieces, PIECE_SETS, (v) => t[`pieces_${v}`], now.pieces, (pieces) => void prefs.set({ pieces })),
  );
  for (const [key, label] of TOGGLES) {
    const row = document.createElement("label");
    row.className = "toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = now[key];
    input.dataset.pref = key;
    input.addEventListener("change", () => void prefs.set({ [key]: input.checked }));
    const text = document.createElement("span");
    text.textContent = t[label];
    row.append(input, text);
    dialog.body.append(row);
  }
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = t.settingsHint;
  dialog.body.append(hint);
  return dialog;
}
