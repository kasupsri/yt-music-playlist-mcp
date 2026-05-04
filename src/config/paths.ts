import path from "node:path";

export function dataDir(): string {
  return path.resolve(process.env.YOUTUBE_MUSIC_MCP_HOME ?? path.join(process.cwd(), ".local"));
}

export function googleTokenPath(): string {
  return path.join(dataDir(), "google-oauth.json");
}

export function googleClientPath(): string {
  return path.join(dataDir(), "google-client.json");
}

export function ytMusicAuthPath(): string {
  return path.join(dataDir(), "ytmusic-auth.json");
}

export function ytMusicConfigPath(): string {
  return path.join(dataDir(), "ytmusic-config.json");
}

export function mcpOAuthPath(): string {
  return path.join(dataDir(), "mcp-oauth.json");
}

export function trackCachePath(): string {
  return path.join(dataDir(), "track-cache.json");
}

export function quotaUsagePath(): string {
  return path.join(dataDir(), "quota-usage.json");
}
