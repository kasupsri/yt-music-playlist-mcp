import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, removeFileIfExists, writeJsonFile } from "./authState.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ytmcp-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("auth state storage", () => {
  it("round-trips JSON with secure parent directories", async () => {
    const filePath = path.join(tempDir, "nested", "state.json");
    await writeJsonFile(filePath, { ok: true });

    await expect(readJsonFile<{ ok: boolean }>(filePath)).resolves.toEqual({ ok: true });
  });

  it("returns null for missing files", async () => {
    await expect(readJsonFile(path.join(tempDir, "missing.json"))).resolves.toBeNull();
  });

  it("removes existing files and ignores missing files", async () => {
    const filePath = path.join(tempDir, "state.json");
    await writeJsonFile(filePath, { ok: true });

    await expect(removeFileIfExists(filePath)).resolves.toBe(true);
    await expect(removeFileIfExists(filePath)).resolves.toBe(false);
  });
});
