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
    expect(DEFAULT_PREFS).toEqual({ v: 1, theme: "green", pieces: "cburnett", coords: true, autoQueen: false, legal: true, sound: true, premove: true, turned: false });
  });

  it("round-trip through the broker's strict-JSON storage, per chat", async () => {
    const broker = new MockBroker("ana");
    const store = new PrefsStore(broker);
    await store.load();
    await store.set({ theme: "brown", pieces: "classic", coords: false, autoQueen: true, legal: false, premove: false, turned: true });
    const again = new PrefsStore(broker);
    expect(await again.load()).toEqual({ v: 1, theme: "brown", pieces: "classic", coords: false, autoQueen: true, legal: false, sound: true, premove: false, turned: true });
    // Another chat's broker has its own.
    expect(await new PrefsStore(new MockBroker("bob")).load()).toEqual(DEFAULT_PREFS);
    // Nothing else is stored, and nothing extra rides in the record.
    expect([...broker.stored.keys()]).toEqual([PREFS_KEY]);
    expect(Object.keys(JSON.parse(broker.stored.get(PREFS_KEY)!)).sort()).toEqual([...Object.keys(DEFAULT_PREFS), "pm"].sort());
  });

  it("turn premoves on for a record written by 2.0 or 2.1, whose premove: false was never the player's choice", async () => {
    // Chess 2.1 had no premove control, but wrote its whole record, premove: false included, on any change.
    const old = { v: 1, theme: "blue", pieces: "cburnett", coords: false, autoQueen: false, legal: true, sound: false, premove: false, turned: false };
    expect(readPrefs(old)).toEqual({ ...DEFAULT_PREFS, theme: "blue", coords: false, sound: false, premove: true });
    const broker = new MockBroker("ana");
    broker.stored.set(PREFS_KEY, JSON.stringify(old));
    const store = new PrefsStore(broker);
    expect((await store.load()).premove).toBe(true);
    // A choice made from 2.2.0 on is kept, and the other settings stay as they were.
    await store.set({ premove: false });
    const again = await new PrefsStore(broker).load();
    expect(again).toEqual({ ...DEFAULT_PREFS, theme: "blue", coords: false, sound: false, premove: false });
    await store.set({ theme: "brown" });
    expect((await new PrefsStore(broker).load()).premove).toBe(false);
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
