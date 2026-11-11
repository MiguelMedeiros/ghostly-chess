// French sets a no-break space before ? ! ; and : (a narrow one before ? ! ;), so a narrow dialog never starts a line
// with the mark alone ("Abandonner cette partie" / "?" at 320 px).
import { describe, expect, it } from "vitest";
import { fr } from "../src/languages.ts";

describe("French", () => {
  it("never breaks a line before ? ! ; or :", () => {
    const loose = Object.entries(fr).filter(([, text]) => typeof text === "string" && / [?!;:]/.test(text));
    expect(loose.map(([key]) => key)).toEqual([]);
  });

  it("puts a narrow no-break space before ? ! ; and a no-break space before :", () => {
    const texts = Object.values(fr).filter((text): text is string => typeof text === "string");
    expect(texts.filter((text) => /[^\u202f][?!;]/.test(text))).toEqual([]);
    expect(texts.filter((text) => /[^\u00a0]:/.test(text))).toEqual([]);
  });
});
