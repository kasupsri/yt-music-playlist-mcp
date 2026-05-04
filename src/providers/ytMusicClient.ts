import { ytMusicConfigPath } from "../config/paths.js";
import { readJsonFile, writeJsonFile } from "../auth/authState.js";
import { loadYouTubeMusicAuth } from "../auth/ytmusicAuth.js";
import type { TrackCandidate } from "./types.js";
import { parseClockDurationSeconds } from "../utils/time.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface YouTubeMusicConfig {
  apiKey: string;
  clientName: string;
  clientVersion: string;
  updatedAt: string;
}

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

export class YTMusicClient {
  async searchTracks(query: string, maxResults = 10): Promise<TrackCandidate[]> {
    const config = await getYouTubeMusicConfig();
    const auth = await loadYouTubeMusicAuth();

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }

      const response = await fetch(
        `https://music.youtube.com/youtubei/v1/search?key=${encodeURIComponent(config.apiKey)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://music.youtube.com",
            referer: "https://music.youtube.com/search",
            "user-agent": process.env.YTMUSIC_USER_AGENT ?? DEFAULT_USER_AGENT,
            ...(auth?.headers ?? {})
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: config.clientName,
                clientVersion: config.clientVersion
              }
            },
            query,
            params: "EgWKAQIIAWoKEAkQBRAKEAMQBQ%3D%3D"
          })
        }
      );

      if (response.ok) {
        const payload = (await response.json()) as unknown;
        return parseMusicSearchResults(payload).slice(0, maxResults);
      }

      // Don't retry client errors (4xx except 429 rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new Error(`YouTube Music search failed: ${response.status} ${response.statusText}`);
      }

      lastError = new Error(`YouTube Music search failed: ${response.status} ${response.statusText}`);
    }

    throw lastError ?? new Error("YouTube Music search failed after retries.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseMusicSearchResults(payload: unknown): TrackCandidate[] {
  const renderers = collectRenderers(payload, "musicResponsiveListItemRenderer");
  const candidates: TrackCandidate[] = [];

  for (const renderer of renderers) {
    const videoId = findVideoId(renderer);
    const columns = renderer.flexColumns ?? [];
    const title = textFromRuns(columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
    const subtitle = textFromRuns(columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
    const durationText = textFromRuns(renderer.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs);

    if (!videoId || !title) {
      continue;
    }

    const subtitleParts = subtitle
      .split("•")
      .map((part) => part.trim())
      .filter(Boolean);
    const artists = subtitleParts
      .filter((part) => !/^(song|video|single|album|ep)$/i.test(part))
      .filter((part) => !/^\d{1,2}:\d{2}/.test(part))
      .slice(0, 3);

    candidates.push({
      videoId,
      title,
      artists: artists.length ? artists : ["Unknown artist"],
      durationSeconds: parseClockDurationSeconds(durationText) ?? parseClockDurationSeconds(subtitleParts.at(-1)),
      source: "youtube-music",
      url: `https://music.youtube.com/watch?v=${videoId}`
    });
  }

  return dedupeByVideoId(candidates);
}

async function getYouTubeMusicConfig(): Promise<YouTubeMusicConfig> {
  const cached = await readJsonFile<YouTubeMusicConfig>(ytMusicConfigPath());
  if (cached?.apiKey && cached.clientVersion) {
    return cached;
  }

  const response = await fetch("https://music.youtube.com", {
    headers: {
      "user-agent": process.env.YTMUSIC_USER_AGENT ?? DEFAULT_USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Could not load YouTube Music config: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const apiKey = matchRequired(html, /"INNERTUBE_API_KEY":"([^"]+)"/, "INNERTUBE_API_KEY");
  const clientName = matchRequired(html, /"INNERTUBE_CLIENT_NAME":"?([^",}]+)"?/, "INNERTUBE_CLIENT_NAME");
  const clientVersion = matchRequired(
    html,
    /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/,
    "INNERTUBE_CLIENT_VERSION"
  );

  const config: YouTubeMusicConfig = {
    apiKey,
    clientName,
    clientVersion,
    updatedAt: new Date().toISOString()
  };
  await writeJsonFile(ytMusicConfigPath(), config);
  return config;
}

function matchRequired(input: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(input);
  if (!match?.[1]) {
    throw new Error(`Could not find ${label} in YouTube Music page.`);
  }

  return match[1];
}

function collectRenderers(payload: unknown, key: string): Record<string, any>[] {
  const results: Record<string, any>[] = [];

  function visit(value: unknown): void {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    if (record[key] && typeof record[key] === "object" && !Array.isArray(record[key])) {
      results.push(record[key] as Record<string, any>);
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  }

  visit(payload);
  return results;
}

function textFromRuns(runs: unknown): string {
  if (!Array.isArray(runs)) {
    return "";
  }

  return runs
    .map((run) => (run && typeof run === "object" && "text" in run ? String((run as { text: unknown }).text) : ""))
    .join("")
    .trim();
}

function findVideoId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, any>;
  if (typeof record.videoId === "string") {
    return record.videoId;
  }

  if (typeof record.playlistItemData?.videoId === "string") {
    return record.playlistItemData.videoId;
  }

  if (typeof record.navigationEndpoint?.watchEndpoint?.videoId === "string") {
    return record.navigationEndpoint.watchEndpoint.videoId;
  }

  for (const child of Object.values(record)) {
    const found = findVideoId(child);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function dedupeByVideoId(candidates: TrackCandidate[]): TrackCandidate[] {
  const seen = new Set<string>();
  const deduped: TrackCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.videoId)) {
      continue;
    }

    seen.add(candidate.videoId);
    deduped.push(candidate);
  }

  return deduped;
}
