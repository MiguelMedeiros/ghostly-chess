// covers: apps.chess
// The settings record: checked on read, defaults for anything missing or wrong, strict JSON through the broker.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, PREFS_KEY, PrefsStore, readPrefs } from "../src/prefs.ts";
import type { MiniAppJson } from "../src/vendor/miniApp.ts";
import { MockBroker } from "./mockBroker.ts";

describe("prefs", () => {
  it("fall back to the defaults for a missing, foreign or damaged value", () => {
    for (const value of [undefined, null, 3, "prefs", [], {}, { v: 2, theme: "blue" }, { theme: "blue" }] as (MiniAppJson | undefined)[]) {
      expect(readPrefs(value), JSON.stringify(value)).toEqual(DEFAULT_PREFS);
    }
    expect(readPrefs({ v: 1, theme: "pink", pieces: "merida", coords: "yes", autoQueen: 1, legal: null, sound: false, turned: true })).toEqual({
      ...DEFAULT_PREFS,
      sound: false,
      turned: true,
    });
  });

  it("default to the chess.com look: green board, drawn pieces, coordinates, legal moves", () => {
    expect(DEFAULT_PREFS).toEqual({ v: 1, theme: "green", pieces: "cburnett", coords: true, autoQueen: false, legal: true, sound: true, premove: false, turned: false });
  });

  it("round-trip through the broker's strict-JSON storage, per chat", async () => {
    const broker = new MockBroker("ana");
    const store = new PrefsStore(broker);
    await store.load();
    await store.set({ theme: "brown", pieces: "classic", coords: false, autoQueen: true, legal: false, turned: true });
    const again = new PrefsStore(broker);
    expect(await again.load()).toEqual({ v: 1, theme: "brown", pieces: "classic", coords: false, autoQueen: true, legal: false, sound: true, premove: false, turned: true });
    // Another chat's broker has its own.
    expect(await new PrefsStore(new MockBroker("bob")).load()).toEqual(DEFAULT_PREFS);
    // Nothing else is stored, and nothing extra rides in the record.
    expect([...broker.stored.keys()]).toEqual([PREFS_KEY]);
    expect(Object.keys(JSON.parse(broker.stored.get(PREFS_KEY)!)).sort()).toEqual(Object.keys(DEFAULT_PREFS).sort());
  });

  it("ignore a value set to something outside its range", async () => {
    const store = new PrefsStore(new MockBroker("ana"));
    await store.load();
    await store.set({ theme: "purple" as never });
    expect(store.get().theme).toBe("green");
  });

  it("keep working when the storage fails", async () => {
    const broker = new MockBroker("ana");
    broker.storage.get = async () => Promise.reject(new Error("broker gone"));
    broker.storage.set = async () => Promise.reject(new Error("broker gone"));
    const store = new PrefsStore(broker);
    expect(await store.load()).toEqual(DEFAULT_PREFS);
    await store.set({ theme: "blue" });
    expect(store.get().theme).toBe("blue");
  });
});
