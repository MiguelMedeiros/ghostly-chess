// @vitest-environment happy-dom
// covers: apps.chess
// The new-game panel and the invitation card (src/setup.ts) on the page, and the compat banner's details.
import { afterEach, describe, expect, it } from "vitest";
import type { View } from "../src/game.ts";
import { ar } from "../src/languages.ts";
import { encodeMessage } from "../src/protocol.ts";
import { invitationReason, kindOf, PRESETS, presetState, termsWords } from "../src/setup.ts";
import { commitment, newSalt } from "../src/toss.ts";
import { en, stringsFor } from "../src/strings.ts";
import { chatPair } from "./mockBroker.ts";
import { mount, open, settle, startChat } from "./sides.ts";

afterEach(() => document.body.replaceChildren());

const view = (over: Partial<View>): Pick<View, "mode" | "features" | "peerVersion"> => ({ mode: "v2", features: [], ...over });

describe("the presets", () => {
  it("are 1|0, 3|2, 5|0, 10|0, 30|0 and Unlimited, named by chess.com's bands", () => {
    expect(PRESETS.map((p) => (p.tc ? p.tc.join("+") : "-"))).toEqual(["60+0", "180+2", "300+0", "600+0", "1800+0", "-"]);
    expect(PRESETS.map((p) => kindOf(p.tc))).toEqual(["bullet", "blitz", "blitz", "rapid", "classical", "unlimited"]);
    expect(termsWords(undefined, en)).toBe("Unlimited");
    expect(termsWords([300, 0], en)).toBe("Blitz, 5 min");
    expect(termsWords([180, 2], en)).toBe("Blitz, 3 min + 2 s");
    expect(termsWords([600, 0], stringsFor("ar"))).toBe(`${ar.tc_rapid}، 10 د`);
  });

  it("enable Unlimited only until this build has clocks, and say why for the others", () => {
    expect(presetState(undefined, view({}), [], en)).toEqual({ enabled: true });
    expect(presetState([300, 0], view({ features: ["clock"] }), [], en)).toEqual({ enabled: false, reason: "Coming in a later version of Chess" });
  });

  it("disable a timed preset the contact's Chess lacks, naming its version", () => {
    const own = ["clock"];
    expect(presetState([300, 0], view({ mode: "v2", features: ["clock"] }), own, en)).toEqual({ enabled: true });
    expect(presetState([300, 0], view({ mode: "v2", features: [], peerVersion: "2.0.0" }), own, en)).toEqual({ enabled: false, reason: "Your contact needs to update Chess (they have 2.0.0)" });
    expect(presetState([300, 0], view({ mode: "v1", peerVersion: "1.0.2" }), own, en)).toEqual({ enabled: false, reason: "Your contact needs to update Chess (they have 1.0.2)" });
    expect(presetState([300, 0], view({ mode: "v1" }), own, en)).toEqual({ enabled: false, reason: "Your contact needs to update Chess" });
    expect(presetState([300, 0], view({ mode: "hello" }), own, en)).toEqual({ enabled: false, reason: "Your contact needs to update Chess" });
  });
});

describe("the cards on the page", () => {
  it("show the new-game panel, then the contact's invitation; Decline sends both back to the panel", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    const anaRoot = mount(ana);
    const setup = anaRoot.querySelector<HTMLElement>(".setup")!;
    expect(setup.hidden).toBe(false);
    expect(anaRoot.querySelector(".status")!.textContent).toBe("Waiting for your contact to open Chess");
    const presets = [...setup.querySelectorAll<HTMLButtonElement>(".preset")];
    // Before the contact's Chess has opened, what it can play is not known: only Unlimited, and why.
    expect(presets.map((p) => p.disabled)).toEqual([true, true, true, true, true, false]);
    expect(presets[0].title).toBe("Waiting for your contact to open Chess");
    expect(presets[5].getAttribute("aria-pressed")).toBe("true");
    expect(setup.querySelector(".preset-reason")!.textContent).toBe("Waiting for your contact to open Chess");
    const bob = await open(b);
    const bobRoot = mount(bob);
    await settle(ana, bob);
    expect(anaRoot.querySelector(".status")!.textContent).toBe("Invite your contact to a game");
    // Both name "clock": every preset is on.
    expect(presets.map((p) => p.disabled)).toEqual([false, false, false, false, false, false]);
    expect(setup.querySelector<HTMLElement>(".preset-reason")!.hidden).toBe(true);
    presets[5].click();
    setup.querySelector<HTMLButtonElement>(".invite-btn")!.click();
    await settle(ana, bob);
    expect(anaRoot.querySelector(".status")!.textContent).toBe("Invitation sent");
    expect(setup.hidden).toBe(true);
    const card = bobRoot.querySelector<HTMLElement>(".invitation")!;
    expect(card.hidden).toBe(false);
    expect(bobRoot.querySelector<HTMLElement>(".setup")!.hidden).toBe(true);
    expect(card.querySelector(".invite-words")!.textContent).toBe("Your contact invites you: Unlimited");
    card.querySelector<HTMLButtonElement>(".decline-invite")!.click();
    await settle(ana, bob);
    expect(card.hidden).toBe(true);
    expect(setup.hidden).toBe(false);
    expect(bobRoot.querySelector<HTMLElement>(".setup")!.hidden).toBe(false);
    expect(anaRoot.querySelector(".notice.info")!.textContent).toBe("Your contact declined the invitation.");
    // Invite again; this time Accept.
    setup.querySelector<HTMLButtonElement>(".invite-btn")!.click();
    await settle(ana, bob);
    card.querySelector<HTMLButtonElement>(".accept-invite")!.click();
    await settle(ana, bob);
    for (const root of [anaRoot, bobRoot]) {
      expect(root.querySelector(".side")!.textContent).toMatch(/^You play (white|black)$/);
      expect(root.querySelector<HTMLElement>(".setup")!.hidden).toBe(true);
      expect(root.querySelector<HTMLElement>(".invitation")!.hidden).toBe(true);
    }
  });

  it("says the contact's invitation in the status and aloud, and keeps focus on the page through Accept", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    const bob = await open(b);
    const anaRoot = mount(ana);
    const bobRoot = mount(bob);
    await settle(ana, bob);
    expect(bobRoot.querySelector(".status")!.textContent).toBe("Invite your contact to a game");
    // Bob's focus is on his own panel's Invite when Ana's invitation replaces the panel.
    // (One document holds both pages here, so Ana's Invite is clicked without taking focus.)
    bobRoot.querySelector<HTMLButtonElement>(".setup .invite-btn")!.focus();
    anaRoot.querySelector<HTMLButtonElement>(".setup .invite-btn")!.click();
    await settle(ana, bob);
    expect(bobRoot.querySelector(".status")!.textContent).toBe("Your contact invites you: Unlimited");
    expect(bobRoot.querySelector(".announce")!.textContent).toBe("Your contact invites you: Unlimited");
    const accept = bobRoot.querySelector<HTMLButtonElement>(".invitation .accept-invite")!;
    expect(document.activeElement).toBe(accept);
    accept.click();
    await settle(ana, bob);
    expect(bobRoot.querySelector(".side")!.textContent).toMatch(/^You play (white|black)$/);
    // The card went: focus is on the board, not dropped to the page.
    expect(bobRoot.querySelector(".board")!.contains(document.activeElement)).toBe(true);
  });

  it("keeps a timed invitation's card with Accept off and the reason, and Decline on, when the contact names no clock", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    const root = mount(ana);
    b.launch(); // a Chess 2.0.0 (no clocks) that still sends a timed seek: a script here
    await settle(ana);
    a.inject(encodeMessage({ k: "hello", pv: 2, f: [] }));
    a.inject(encodeMessage({ k: "seek", c: commitment(newSalt()), a: [], tc: [300, 0] }));
    await settle(ana);
    const card = root.querySelector<HTMLElement>(".invitation")!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".invite-words")!.textContent).toBe("Your contact invites you: Blitz, 5 min");
    const accept = card.querySelector<HTMLButtonElement>(".accept-invite")!;
    expect(accept.disabled).toBe(true);
    const reason = card.querySelector<HTMLElement>(".invite-reason")!;
    expect(reason.hidden).toBe(false);
    expect(reason.textContent).toBe("Your contact needs to update Chess (they have 2.0.0)");
    expect(accept.getAttribute("aria-describedby")).toBe(reason.id);
    expect(card.querySelector<HTMLButtonElement>(".decline-invite")!.disabled).toBe(false);
  });

  it("names why a rematch cannot be accepted", () => {
    const rematch = { rematch: true, playable: false };
    expect(invitationReason(rematch, view({ features: ["rematch"] }), [], en)).toBe("Coming in a later version of Chess");
    expect(invitationReason(rematch, view({ peerVersion: "2.1.0" }), ["rematch"], en)).toBe("Your contact needs to update Chess (they have 2.1.0)");
    expect(invitationReason({ rematch: false, playable: true }, view({}), [], en)).toBeUndefined();
  });

  it("puts the compat details behind ⓘ, in a dialog", async () => {
    const { white } = await startChat("1.0.2");
    const root = mount(white);
    expect(root.querySelector(".standing-text")!.textContent).toBe("Your contact has Chess 1.0.2. Clocks, takebacks and rematches come when they update.");
    const info = root.querySelector<HTMLButtonElement>(".standing .info-btn")!;
    expect(info.getAttribute("aria-label")).toBe("About this");
    info.click();
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Ghostly updates apps on start, once a day and on the Apps page.");
    // With protocol 2 there is no banner.
    const v2 = await startChat();
    const r2 = mount(v2.white);
    expect(r2.querySelector<HTMLElement>(".standing")!.hidden).toBe(true);
  });
});
