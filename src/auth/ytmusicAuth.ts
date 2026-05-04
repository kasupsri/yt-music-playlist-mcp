import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import open from "open";
import { ytMusicAuthPath, ytMusicConfigPath } from "../config/paths.js";
import { readJsonFile, removeFileIfExists, writeJsonFile } from "./authState.js";

export interface YouTubeMusicAuthState {
  headers: Record<string, string>;
  browserLoginConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface YouTubeMusicAuthStatus {
  tokenFileExists: boolean;
  hasHeaders: boolean;
  browserLoginConfirmed: boolean;
  path: string;
  message: string;
}

export async function youtubeMusicAuthStatus(): Promise<YouTubeMusicAuthStatus> {
  const state = await readJsonFile<YouTubeMusicAuthState>(ytMusicAuthPath());
  const hasHeaders = Boolean(state && Object.keys(state.headers).length > 0);

  return {
    tokenFileExists: Boolean(state),
    hasHeaders,
    browserLoginConfirmed: Boolean(state?.browserLoginConfirmed),
    path: ytMusicAuthPath(),
    message: state
      ? hasHeaders
        ? "YouTube Music browser headers are available."
        : "YouTube Music browser login marker is available; adapter will use public requests when possible."
      : "Run `youtube-music-playlist-mcp auth ytmusic`."
  };
}

export async function loadYouTubeMusicAuth(): Promise<YouTubeMusicAuthState | null> {
  return readJsonFile<YouTubeMusicAuthState>(ytMusicAuthPath());
}

export async function resetYouTubeMusicAuth(): Promise<{ authRemoved: boolean; configRemoved: boolean }> {
  const [authRemoved, configRemoved] = await Promise.all([
    removeFileIfExists(ytMusicAuthPath()),
    removeFileIfExists(ytMusicConfigPath())
  ]);

  return { authRemoved, configRemoved };
}

export async function runYouTubeMusicAuthFlow(headersFile?: string): Promise<YouTubeMusicAuthStatus> {
  if (headersFile) {
    const imported = await readJsonFile<Record<string, string>>(headersFile);
    if (!imported || typeof imported !== "object") {
      throw new Error(`Could not read headers JSON from ${headersFile}.`);
    }

    await saveYouTubeMusicAuth(imported, true, `Imported from ${headersFile}.`);
    return youtubeMusicAuthStatus();
  }

  await open("https://music.youtube.com", { wait: false }).catch(() => {
    process.stderr.write("Open https://music.youtube.com manually and sign in.\n");
  });

  const rl = createInterface({ input, output });
  try {
    process.stderr.write(
      [
        "Sign in to YouTube Music in the browser.",
        "Optional: paste a one-line JSON object of request headers from music.youtube.com.",
        "If you just press Enter, the adapter will use unauthenticated YouTube Music requests when possible."
      ].join("\n") + "\n"
    );
    const answer = await rl.question("Headers JSON or Enter to continue: ");
    const headers = answer.trim() ? parseHeaders(answer.trim()) : {};
    await saveYouTubeMusicAuth(headers, true, headersPresent(headers) ? "Browser headers pasted." : undefined);
    return youtubeMusicAuthStatus();
  } finally {
    rl.close();
  }
}

function parseHeaders(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }

  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key.toLowerCase(), value as string])
  );
}

function headersPresent(headers: Record<string, string>): boolean {
  return Object.keys(headers).length > 0;
}

async function saveYouTubeMusicAuth(
  headers: Record<string, string>,
  browserLoginConfirmed: boolean,
  notes?: string
): Promise<void> {
  const now = new Date().toISOString();
  await writeJsonFile<YouTubeMusicAuthState>(ytMusicAuthPath(), {
    headers,
    browserLoginConfirmed,
    createdAt: now,
    updatedAt: now,
    notes
  });
}
