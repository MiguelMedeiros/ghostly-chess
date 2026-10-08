// covers: apps.chess
// The version this build publishes as, and the protocol it speaks: a contact on PROTO2_SINCE or later gets a hello,
// so the manifest must never say less than that, nor differ from package.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, PROTO2_SINCE } from "../src/protocol.ts";

const root = join(import.meta.dirname, "..");
const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8")) as { version: string; packages?: Record<string, { version?: string }> };

describe("the version", () => {
  it("is the same in ghostly-app.json, package.json and package-lock.json", () => {
    const manifest = read("ghostly-app.json").version;
    expect(read("package.json").version).toBe(manifest);
    const lock = read("package-lock.json");
    expect(lock.version).toBe(manifest);
    expect(lock.packages?.[""]?.version).toBe(manifest);
  });

  it("is at least PROTO2_SINCE, which Chess 1.0.2 is below", () => {
    expect(compareVersions(read("ghostly-app.json").version, PROTO2_SINCE)).toBeGreaterThanOrEqual(0);
    expect(compareVersions("1.0.2", PROTO2_SINCE)).toBe(-1);
    expect(compareVersions("1.2.0", PROTO2_SINCE)).toBe(-1);
  });
});
