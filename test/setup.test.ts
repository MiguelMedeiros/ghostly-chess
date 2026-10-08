// @vitest-environment happy-dom
// covers: apps.chess
// The new-game panel and the invitation card (src/setup.ts) on the page, and the compat banner's details.
import { afterEach, describe, expect, it } from "vitest";
import type { View } from "../src/game.ts";
import { ar } from "../src/languages.ts";
import { kindOf, PRESETS, presetState, termsWords } from "../src/setup.ts";
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
    expect(presets.map((p) => p.disabled)).toEqual([true, true, true, true, true, false]);
    expect(presets[0].title).toBe("Coming in a later version of Chess");
    expect(presets[5].getAttribute("aria-pressed")).toBe("true");
    expect(setup.querySelector(".preset-reason")!.textContent).toBe("Coming in a later version of Chess");
    const bob = await open(b);
    const bobRoot = mount(bob);
    await settle(ana, bob);
    expect(anaRoot.querySelector(".status")!.textContent).toBe("Invite your contact to a game");
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
