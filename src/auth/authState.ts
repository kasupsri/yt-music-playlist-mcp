import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await rm(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
