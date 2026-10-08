/**
 * The new-game panel and the contact's invitation, as cards on the board (like the game-over card), so neither
 * resizes the board.
 *
 * - Setup (phase "setup"): the time-control presets 1|0, 3|2, 5|0, 10|0, 30|0 and Unlimited, and Invite. The toss
 *   decides colours. A preset is enabled only when both sides can play it: a timed one needs "clock" named by both
 *   hellos, and one the contact's Chess lacks (2.0.0, or 1.0.2) says "Your contact needs to update Chess (they have
 *   X.Y.Z)".
 * - Invitation (view.invitation): "Your contact invites you: Unlimited", with Accept and Decline. Only the contact's
 *   latest proposal is shown. Terms this build cannot play (a clock, a rematch) keep the card, with Accept off and
 *   the reason under it, as a preset's.
 *
 * Alone there is no setup: New game starts an unlimited game at once.
 */
import { PRESET_TCS } from "./clock.ts";
import { fill } from "./panel.ts";
import type { View } from "./game.ts";
import type { TimeControl } from "./protocol.ts";
import type { Strings } from "./strings.ts";

export type PresetKind = "bullet" | "blitz" | "rapid" | "classical" | "unlimited";

export interface Preset {
  /** [base s, increment s]; absent is Unlimited. */
  tc?: TimeControl;
  kind: PresetKind;
}

export const PRESETS: readonly Preset[] = [...PRESET_TCS.map((tc): Preset => ({ tc, kind: kindOf(tc) })), { kind: "unlimited" }];

/** The kind of a time control, by chess.com's bands (estimated time = base + 40 x increment). */
export function kindOf(tc: TimeControl | undefined): PresetKind {
  if (!tc) return "unlimited";
  const total = tc[0] + 40 * tc[1];
  return total < 180 ? "bullet" : total < 600 ? "blitz" : total < 1800 ? "rapid" : "classical";
}

const kindWord = (kind: PresetKind, t: Strings) => t[`tc_${kind}`];

/** A time control in words: "Unlimited", "Blitz, 5 min", "Blitz, 3 min + 2 s". */
export function termsWords(tc: TimeControl | undefined, t: Strings): string {
  if (!tc) return t.tc_unlimited;
  const min = Math.round((tc[0] / 60) * 100) / 100;
  return fill(tc[1] ? t.tc_wordsInc : t.tc_words, { kind: kindWord(kindOf(tc), t), min, inc: tc[1] });
}

/** The contact's invitation in words: "Your contact invites you: Unlimited", or "Rematch? (5 | 0)". */
export function invitationWords(invitation: Pick<NonNullable<View["invitation"]>, "tc" | "rematch">, t: Strings): string {
  if (!invitation.rematch) return fill(t.invitesYou, { terms: termsWords(invitation.tc, t) });
  const tc = invitation.tc;
  return fill(t.rematchYou, { terms: tc ? `${Math.round((tc[0] / 60) * 100) / 100} | ${tc[1]}` : t.tc_unlimited });
}

/** A preset's short label on its button: "3 | 2", or "Unlimited". */
export function presetLabel(preset: Preset, t: Strings): string {
  return preset.tc ? `${Math.round(preset.tc[0] / 60)} | ${preset.tc[1]}` : t.tc_unlimited;
}

/**
 * Whether a preset can be offered now, and why not. `own` is what this build implements; the contact's side is read
 * from the view: its mode (version 1 is Chess 1.0.2's protocol, with no clocks) and the features both named.
 */
export function presetState(
  tc: TimeControl | undefined,
  view: Pick<View, "mode" | "features" | "peerVersion"> & Partial<Pick<View, "peerOpen">>,
  own: readonly string[],
  t: Strings,
): { enabled: boolean; reason?: string } {
  if (!tc) return { enabled: true };
  if (!own.includes("clock")) return { enabled: false, reason: t.comingSoon };
  const peerHasClock = view.mode === "v2" && view.features.includes("clock");
  if (peerHasClock) return { enabled: true };
  // A contact not seen since this page opened: what its Chess can do is known when it opens.
  if (view.peerOpen === false && view.mode !== "v2" && !view.peerVersion) return { enabled: false, reason: t.waitingPeer };
  const known = view.mode === "v1" || view.mode === "v2";
  if (!known) return { enabled: false, reason: t.needsUpdateOld };
  return { enabled: false, reason: view.peerVersion ? fill(t.needsUpdate, { version: view.peerVersion }) : t.needsUpdateOld };
}

/** Why the contact's invitation cannot be accepted, or undefined when it can. */
export function invitationReason(
  invitation: NonNullable<View["invitation"]>,
  view: Pick<View, "mode" | "features" | "peerVersion"> & Partial<Pick<View, "peerOpen">>,
  own: readonly string[],
  t: Strings,
): string | undefined {
  if (invitation.playable) return undefined;
  if (invitation.tc) {
    const reason = presetState(invitation.tc, view, own, t).reason;
    if (reason) return reason;
  }
  if (!own.includes("rematch")) return t.comingSoon;
  return view.peerVersion ? fill(t.needsUpdate, { version: view.peerVersion }) : t.needsUpdateOld;
}

export interface SetupActions {
  invite: (tc: TimeControl | undefined) => void;
  accept: () => void;
  decline: () => void;
}

export interface SetupCards {
  /** The new-game panel. */
  readonly setup: HTMLElement;
  /** The contact's invitation. */
  readonly invitation: HTMLElement;
  render(view: View): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let made = 0;

export function createSetup(t: Strings, own: readonly string[], actions: SetupActions): SetupCards {
  const id = ++made;
  const setup = el("section", "setup card");
  setup.hidden = true;
  const head = el("h2", "card-head", t.setupTitle);
  head.id = `setup-head-${id}`;
  setup.setAttribute("aria-labelledby", head.id);
  const group = el("div", "presets");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", t.setupTitle);
  const reason = el("p", "card-hint preset-reason");
  reason.id = `setup-reason-${id}`;
  const hint = el("p", "card-hint", t.setupHint);
  const invite = el("button", "act primary invite-btn", t.invite);
  invite.type = "button";
  let chosen: TimeControl | undefined;
  const buttons = PRESETS.map((preset) => {
    const b = el("button", `act preset preset-${preset.kind}`);
    b.type = "button";
    b.dataset.tc = preset.tc ? preset.tc.join("+") : "-";
    const label = el("span", "preset-label", presetLabel(preset, t));
    b.append(label);
    if (preset.tc) b.append(el("span", "preset-kind", kindWord(preset.kind, t)));
    b.addEventListener("click", () => {
      chosen = preset.tc;
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === b));
    });
    return b;
  });
  group.append(...buttons);
  invite.addEventListener("click", () => actions.invite(chosen));
  setup.append(head, group, reason, hint, el("div", "card-actions"));
  setup.lastElementChild!.append(invite);

  const invitation = el("section", "invitation card");
  invitation.hidden = true;
  invitation.setAttribute("role", "group");
  const words = el("p", "card-head invite-words");
  words.id = `invite-words-${id}`;
  invitation.setAttribute("aria-labelledby", words.id);
  const why = el("p", "card-hint invite-reason");
  why.id = `invite-reason-${id}`;
  why.hidden = true;
  const row = el("div", "card-actions");
  const accept = el("button", "act primary accept-invite", t.accept);
  accept.type = "button";
  accept.addEventListener("click", () => actions.accept());
  const decline = el("button", "act decline-invite", t.decline);
  decline.type = "button";
  decline.addEventListener("click", () => actions.decline());
  row.append(accept, decline);
  invitation.append(words, why, row);

  return {
    setup,
    invitation,
    render(view) {
      const dir = document.documentElement.dir || "ltr";
      const incoming = view.invitation;
      invitation.hidden = !incoming;
      if (incoming) {
        invitation.dir = dir;
        words.textContent = invitationWords(incoming, t);
        const reason = invitationReason(incoming, view, own, t);
        accept.disabled = Boolean(reason);
        why.textContent = reason ?? "";
        why.hidden = !reason;
        if (reason) {
          accept.title = reason;
          accept.setAttribute("aria-describedby", why.id);
        } else {
          accept.removeAttribute("title");
          accept.removeAttribute("aria-describedby");
        }
      }
      setup.hidden = view.phase !== "setup" || Boolean(incoming);
      if (setup.hidden) return;
      setup.dir = dir;
      let reasonText = "";
      for (const [i, preset] of PRESETS.entries()) {
        const b = buttons[i];
        const state = presetState(preset.tc, view, own, t);
        b.disabled = !state.enabled;
        if (state.reason) {
          b.title = state.reason;
          b.setAttribute("aria-describedby", reason.id);
          reasonText ||= state.reason;
        } else {
          b.removeAttribute("title");
          b.removeAttribute("aria-describedby");
        }
        if (!state.enabled && tcKey(chosen) === tcKey(preset.tc)) chosen = undefined;
      }
      for (const [i, preset] of PRESETS.entries()) buttons[i].setAttribute("aria-pressed", String(tcKey(chosen) === tcKey(preset.tc)));
      reason.textContent = reasonText;
      reason.hidden = !reasonText;
    },
  };
}

const tcKey = (tc: TimeControl | undefined) => (tc ? tc.join("+") : "-");
