import {
  authPaths,
  authStatus as desktopAuthStatus,
  getAuthorizedOAuth2Client
} from "../auth/desktopGoogleOAuth.js";
import { readJsonFile, writeJsonFile } from "../auth/authState.js";
import { youtubeMusicAuthStatus } from "../auth/ytmusicAuth.js";
import { trackCachePath } from "../config/paths.js";
import { classifyMatch, trackSpecToQuery } from "../utils/match.js";
import type {
  BulkMutationPreview,
  MatchedTrack,
  PlaylistDetail,
  PlaylistItem,
  PlaylistSummary,
  PrivacyStatus,
  TrackCandidate,
  TrackSearchSpec
} from "./types.js";
import { YTDataClient } from "./ytDataClient.js";
import { YTMusicClient } from "./ytMusicClient.js";

export type SearchProvider = "auto" | "ytmusic" | "youtube-data";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface TrackCacheEntry {
  videoId: string;
  cachedAt: number;
}

interface PlaylistCreatePreview {
  dryRun: true;
  operation: "playlist_create";
  playlist: {
    title: string;
    description?: string;
    privacyStatus: PrivacyStatus;
  };
  preview: BulkMutationPreview;
  message: string;
}

interface PlaylistUpdatePreview {
  dryRun: true;
  operation: "playlist_update";
  playlistId: string;
  patch: {
    title?: string;
    description?: string;
    privacyStatus?: PrivacyStatus;
  };
  message: string;
}

interface PlaylistAddTracksResult {
  playlist?: PlaylistSummary;
  playlistId: string;
  requestedCount: number;
  matchedCount: number;
  addedCount: number;
  added: PlaylistItem[];
  skipped: MatchedTrack[];
}

export class YTProvider {
  private dataClient?: YTDataClient;
  private readonly musicClient = new YTMusicClient();
  private trackCache: Record<string, TrackCacheEntry> | null = null;

  async authStatus(): Promise<Record<string, unknown>> {
    const [google, ytmusic] = await Promise.all([desktopAuthStatus(), youtubeMusicAuthStatus()]);
    return { google: { ...google, paths: authPaths() }, ytmusic };
  }

  async searchTracks(
    spec: TrackSearchSpec,
    maxResults = 10,
    provider: SearchProvider = "auto"
  ): Promise<TrackCandidate[]> {
    if (spec.videoId) {
      return [
        {
          videoId: spec.videoId,
          title: spec.title ?? spec.videoId,
          artists: spec.artist ? [spec.artist] : ["Unknown artist"],
          album: spec.album,
          durationSeconds: spec.durationSeconds,
          source: "youtube-data",
          confidence: 1,
          url: `https://music.youtube.com/watch?v=${spec.videoId}`
        }
      ];
    }

    const query = trackSpecToQuery(spec);
    if (!query) {
      throw new Error("Search requires query, videoId, or title/artist fields.");
    }

    const candidates: TrackCandidate[] = [];
    const failures: string[] = [];

    if (provider !== "youtube-data") {
      try {
        candidates.push(...(await this.musicClient.searchTracks(query, maxResults)));
      } catch (error) {
        failures.push(`youtube-music: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Only fall back to Data API if Music returned nothing (not just "fewer than maxResults")
    // This conserves YouTube Data API quota (100 units/search) for playlist CRUD operations.
    if (provider !== "ytmusic" && candidates.length === 0) {
      try {
        const data = await this.getDataClient();
        candidates.push(...(await data.searchTracks(query, maxResults)));
      } catch (error) {
        failures.push(`youtube-data: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!candidates.length && failures.length) {
      throw new Error(`No search provider succeeded. ${failures.join("; ")}`);
    }

    return candidates.slice(0, maxResults);
  }

  async matchTracks(
    specs: TrackSearchSpec[],
    options: { maxCandidates?: number; minConfidence?: number; searchProvider?: SearchProvider } = {}
  ): Promise<MatchedTrack[]> {
    const maxCandidates = options.maxCandidates ?? 5;
    const provider = options.searchProvider ?? "ytmusic";
    const cache = await this.loadTrackCache();

    return Promise.all(
      specs.map(async (spec) => {
        // Check cache first (skip for specs that already have a videoId)
        if (!spec.videoId) {
          const cacheKey = trackCacheKey(spec);
          const cachedEntry = cacheKey ? cache[cacheKey] : undefined;
          if (cachedEntry) {
            const resolved: TrackCandidate = {
              videoId: cachedEntry.videoId,
              title: spec.title ?? spec.query ?? cachedEntry.videoId,
              artists: spec.artist ? [spec.artist] : ["Unknown artist"],
              source: "youtube-music",
              confidence: 1,
              url: `https://music.youtube.com/watch?v=${cachedEntry.videoId}`
            };
            return { input: spec, selected: resolved, candidates: [resolved], status: "matched" as const };
          }
        }

        const candidates = await this.searchTracks(spec, maxCandidates, provider);
        const result = classifyMatch(spec, candidates, options.minConfidence);

        // Cache successful matches
        if (result.status === "matched" && result.selected) {
          const cacheKey = trackCacheKey(spec);
          if (cacheKey) {
            cache[cacheKey] = { videoId: result.selected.videoId, cachedAt: Date.now() };
            this.saveTrackCache(cache).catch((error) => {
              process.stderr.write(`Failed to save track cache: ${error instanceof Error ? error.message : String(error)}\n`);
            });
          }
        }

        return result;
      })
    );
  }

  proposePlaylist(input: {
    title: string;
    description?: string;
    tracks: Array<{ title: string; artist: string; reason?: string }>;
    mood?: string;
    genre?: string;
    notes?: string;
  }): {
    proposedTitle: string;
    proposedDescription?: string;
    mood?: string;
    genre?: string;
    trackCount: number;
    tracks: Array<{ title: string; artist: string; reason?: string }>;
    notes?: string;
    nextStep: string;
  } {
    return {
      proposedTitle: input.title,
      proposedDescription: input.description,
      mood: input.mood,
      genre: input.genre,
      trackCount: input.tracks.length,
      tracks: input.tracks,
      notes: input.notes,
      nextStep:
        "Review this proposed track list. Once approved, call playlist_match_tracks with these tracks to resolve them to YouTube videoIds, then playlist_create with the resolved videoIds."
    };
  }

  private async loadTrackCache(): Promise<Record<string, TrackCacheEntry>> {
    if (this.trackCache !== null) {
      return this.trackCache;
    }

    const loaded = await readJsonFile<Record<string, TrackCacheEntry | string>>(trackCachePath());
    const now = Date.now();

    // Migrate legacy string-value entries and drop expired entries
    const migrated: Record<string, TrackCacheEntry> = {};
    for (const [key, value] of Object.entries(loaded ?? {})) {
      const entry: TrackCacheEntry =
        typeof value === "string" ? { videoId: value, cachedAt: now } : value;
      if (now - entry.cachedAt < CACHE_TTL_MS) {
        migrated[key] = entry;
      }
    }

    this.trackCache = migrated;
    return this.trackCache;
  }

  private async saveTrackCache(cache: Record<string, TrackCacheEntry>): Promise<void> {
    this.trackCache = cache;
    await writeJsonFile(trackCachePath(), cache);
  }

  async listPlaylists(): Promise<PlaylistSummary[]> {
    return (await this.getDataClient()).listPlaylists();
  }

  async getPlaylist(playlistId: string): Promise<PlaylistDetail> {
    return (await this.getDataClient()).getPlaylist(playlistId);
  }

  async createPlaylist(input: {
    title: string;
    description?: string;
    privacyStatus?: PrivacyStatus;
    tracks?: TrackSearchSpec[];
    dryRun?: boolean;
    minConfidence?: number;
  }): Promise<PlaylistSummary | PlaylistCreatePreview | PlaylistAddTracksResult> {
    const matches = input.tracks?.length
      ? await this.matchTracks(input.tracks, { minConfidence: input.minConfidence })
      : [];
    const mutationPreview = preview(undefined, matches);
    if (input.dryRun) {
      return {
        dryRun: true,
        operation: "playlist_create",
        playlist: {
          title: input.title,
          description: input.description,
          privacyStatus: input.privacyStatus ?? "private"
        },
        preview: mutationPreview,
        message: "Playlist creation skipped. Call again with dryRun:false to create this playlist."
      };
    }

    const data = await this.getDataClient();
    const playlist = await data.createPlaylist(input);
    const videoIds = selectedVideoIds(matches);
    if (!videoIds.length) {
      return matches.length ? addTracksResult(playlist.id, matches, [], playlist) : playlist;
    }

    const added = await data.addTracks(playlist.id, videoIds);
    return addTracksResult(playlist.id, matches, added, playlist);
  }

  async updatePlaylist(input: {
    playlistId: string;
    title?: string;
    description?: string;
    privacyStatus?: PrivacyStatus;
    dryRun?: boolean;
  }): Promise<PlaylistSummary | PlaylistUpdatePreview> {
    if (input.dryRun) {
      return {
        dryRun: true,
        operation: "playlist_update",
        playlistId: input.playlistId,
        patch: {
          title: input.title,
          description: input.description,
          privacyStatus: input.privacyStatus
        },
        message: "Playlist update skipped. Call again with dryRun:false to apply this metadata change."
      };
    }

    return (await this.getDataClient()).updatePlaylist(input);
  }

  async deletePlaylist(input: {
    playlistId: string;
    confirm?: boolean;
  }): Promise<{ playlistId: string; deleted: true } | { dryRun: true; message: string }> {
    if (!input.confirm) {
      return {
        dryRun: true,
        message: "Deletion skipped. Call again with confirm: true to delete the playlist."
      };
    }

    return (await this.getDataClient()).deletePlaylist(input.playlistId);
  }

  async addTracks(input: {
    playlistId: string;
    tracks: TrackSearchSpec[];
    dryRun?: boolean;
    minConfidence?: number;
  }): Promise<BulkMutationPreview | PlaylistAddTracksResult> {
    const matches = await this.matchTracks(input.tracks, { minConfidence: input.minConfidence });
    if (input.dryRun) {
      return preview(input.playlistId, matches);
    }

    const added = await (await this.getDataClient()).addTracks(input.playlistId, selectedVideoIds(matches));
    return addTracksResult(input.playlistId, matches, added);
  }

  async removeTracks(input: {
    playlistId: string;
    playlistItemIds?: string[];
    videoIds?: string[];
    confirm?: boolean;
  }): Promise<{ removedPlaylistItemIds: string[] } | { dryRun: true; message: string; targetCount: number }> {
    const targetCount = (input.playlistItemIds?.length ?? 0) + (input.videoIds?.length ?? 0);
    if (!input.confirm) {
      return {
        dryRun: true,
        targetCount,
        message: "Removal skipped. Call again with confirm: true to remove tracks."
      };
    }

    return (await this.getDataClient()).removeTracks(input);
  }

  async reorderTrack(input: {
    playlistId: string;
    playlistItemId: string;
    position: number;
  }): Promise<unknown> {
    return (await this.getDataClient()).reorderTrack(input);
  }

  async replaceTracks(input: {
    playlistId: string;
    tracks: TrackSearchSpec[];
    dryRun?: boolean;
    confirm?: boolean;
    minConfidence?: number;
  }): Promise<BulkMutationPreview | PlaylistDetail | { dryRun: true; message: string; preview: BulkMutationPreview }> {
    const matches = await this.matchTracks(input.tracks, { minConfidence: input.minConfidence });
    const mutationPreview = preview(input.playlistId, matches);

    if (input.dryRun || !input.confirm) {
      return input.confirm
        ? mutationPreview
        : {
            dryRun: true,
            message: "Replacement skipped. Call again with confirm: true to replace playlist contents.",
            preview: mutationPreview
          };
    }

    return (await this.getDataClient()).replaceTracks(input.playlistId, selectedVideoIds(matches));
  }

  async generateDraft(input: {
    preselectedTracks?: TrackSearchSpec[];
    prompt?: string;
    seedTracks?: TrackSearchSpec[];
    mood?: string;
    genre?: string;
    era?: string;
    targetLength?: number;
    exclusions?: string[];
    playlistId?: string;
  }): Promise<{
    queries: string[];
    preselectedMatches?: MatchedTrack[];
    candidates: TrackCandidate[];
    notes: string[];
  }> {
    const targetLength = input.targetLength ?? 25;
    const excluded = (input.exclusions ?? []).map((value) => value.toLowerCase());
    const excludeCandidate = (candidate: TrackCandidate) =>
      excluded.some((term) =>
        [candidate.title, ...candidate.artists, candidate.album ?? ""].join(" ").toLowerCase().includes(term)
      );

    // Exclude tracks already in an existing playlist
    const existingVideoIds = new Set<string>();
    if (input.playlistId) {
      const existing = await this.getPlaylist(input.playlistId);
      for (const item of existing.items) {
        existingVideoIds.add(item.videoId);
      }
    }

    let preselectedMatches: MatchedTrack[] | undefined;
    const preselectedVideoIds = new Set<string>();

    if (input.preselectedTracks?.length) {
      preselectedMatches = await this.matchTracks(input.preselectedTracks);
      for (const match of preselectedMatches) {
        if (match.selected?.videoId) {
          preselectedVideoIds.add(match.selected.videoId);
        }
      }
    }

    const queries = buildDraftQueries(input);
    const searchCandidates: TrackCandidate[] = [];

    for (const query of queries) {
      searchCandidates.push(...(await this.searchTracks({ query }, Math.min(10, targetLength))));
    }

    const deduped = dedupeCandidates(searchCandidates)
      .filter((candidate) => !preselectedVideoIds.has(candidate.videoId))
      .filter((candidate) => !existingVideoIds.has(candidate.videoId))
      .filter((candidate) => !excludeCandidate(candidate));

    const notes = [
      "preselectedMatches (if any) are the highest-confidence results for your curated track list.",
      "candidates are supplementary search results.",
      "Review matches and pass chosen videoIds to playlist_create or playlist_add_tracks."
    ];

    return {
      queries,
      preselectedMatches,
      candidates: deduped.slice(0, targetLength),
      notes
    };
  }

  async expandPlaylist(input: {
    playlistId: string;
    targetAdditionalTracks?: number;
    seedLimit?: number;
    exclusions?: string[];
  }): Promise<{ existingCount: number; candidates: TrackCandidate[]; notes: string[] }> {
    const playlist = await this.getPlaylist(input.playlistId);
    const seedLimit = input.seedLimit ?? 8;
    const targetAdditionalTracks = input.targetAdditionalTracks ?? 15;
    const existingVideoIds = new Set(playlist.items.map((item) => item.videoId));
    const existingTitles = playlist.items.map((item) => item.title.toLowerCase());
    const candidates: TrackCandidate[] = [];

    for (const item of playlist.items.slice(0, seedLimit)) {
      const artist = item.artists[0] ?? "";
      candidates.push(
        ...(await this.searchTracks(
          { query: `${item.title} ${artist} similar songs` },
          8,
          "ytmusic"
        ))
      );
    }

    const exclusions = (input.exclusions ?? []).map((value) => value.toLowerCase());
    const filtered = dedupeCandidates(candidates).filter((candidate) => {
      const text = [candidate.title, ...candidate.artists].join(" ").toLowerCase();
      return (
        !existingVideoIds.has(candidate.videoId) &&
        !existingTitles.includes(candidate.title.toLowerCase()) &&
        !exclusions.some((term) => text.includes(term))
      );
    });

    return {
      existingCount: playlist.items.length,
      candidates: filtered.slice(0, targetAdditionalTracks),
      notes: ["Expansion is candidate generation only; call playlist_add_tracks to apply selected tracks."]
    };
  }

  async duplicatePlaylist(input: {
    playlistId: string;
    newTitle?: string;
    newDescription?: string;
    privacyStatus?: PrivacyStatus;
    dryRun?: boolean;
  }): Promise<PlaylistSummary | { dryRun: true; source: PlaylistSummary; newTitle: string; trackCount: number; message: string }> {
    const source = await this.getPlaylist(input.playlistId);
    const newTitle = input.newTitle ?? `${source.title} (copy)`;

    if (input.dryRun !== false) {
      return {
        dryRun: true,
        source: { id: source.id, title: source.title, description: source.description, privacyStatus: source.privacyStatus, itemCount: source.itemCount, url: source.url },
        newTitle,
        trackCount: source.items.length,
        message: "Duplication skipped. Call again with dryRun:false to create the copy."
      };
    }

    const data = await this.getDataClient();
    const newPlaylist = await data.createPlaylist({
      title: newTitle,
      description: input.newDescription ?? source.description,
      privacyStatus: input.privacyStatus ?? (source.privacyStatus as PrivacyStatus | undefined)
    });
    const videoIds = source.items.map((item) => item.videoId);
    if (videoIds.length) {
      await data.addTracks(newPlaylist.id, videoIds);
    }
    return newPlaylist;
  }

  proposePlaylistUpdate(input: {
    currentTracks: Array<{ title: string; artist: string; reason?: string }>;
    addTracks?: Array<{ title: string; artist: string; reason?: string }>;
    removeTracks?: Array<{ title: string; artist: string }>;
    notes?: string;
  }): {
    trackCount: number;
    tracks: Array<{ title: string; artist: string; reason?: string }>;
    added: number;
    removed: number;
    notes?: string;
    nextStep: string;
  } {
    const removeKeys = new Set(
      (input.removeTracks ?? []).map((t) => `${t.title.toLowerCase()}::${t.artist.toLowerCase()}`)
    );
    const filtered = input.currentTracks.filter(
      (t) => !removeKeys.has(`${t.title.toLowerCase()}::${t.artist.toLowerCase()}`)
    );
    const updated = [...filtered, ...(input.addTracks ?? [])];
    return {
      trackCount: updated.length,
      tracks: updated,
      added: input.addTracks?.length ?? 0,
      removed: input.currentTracks.length - filtered.length,
      notes: input.notes,
      nextStep:
        "Review the updated track list. Once approved, call playlist_match_tracks with these tracks to resolve videoIds, then playlist_create or playlist_add_tracks."
    };
  }

  async quotaStatus(): Promise<ReturnType<typeof import("../utils/quota.js").quotaStatus>> {
    const { quotaStatus } = await import("../utils/quota.js");
    return quotaStatus();
  }

  private async getDataClient(): Promise<YTDataClient> {
    if (!this.dataClient) {
      this.dataClient = new YTDataClient(await getAuthorizedOAuth2Client());
    }

    return this.dataClient;
  }
}

function selectedVideoIds(matches: MatchedTrack[]): string[] {
  return matches
    .filter((match) => match.status === "matched" && match.selected)
    .map((match) => match.selected?.videoId)
    .filter((videoId): videoId is string => Boolean(videoId));
}

function preview(playlistId: string | undefined, matches: MatchedTrack[]): BulkMutationPreview {
  const matched = matches.filter((match) => match.status === "matched");
  const durations = matched.map((m) => m.selected?.durationSeconds).filter((d): d is number => d !== undefined);
  const estimatedDurationSeconds = durations.length ? durations.reduce((a, b) => a + b, 0) : undefined;

  return {
    dryRun: true,
    playlistId,
    requestedCount: matches.length,
    matchedCount: matched.length,
    ambiguousCount: matches.filter((match) => match.status === "ambiguous").length,
    missingCount: matches.filter((match) => match.status === "missing").length,
    estimatedDurationSeconds,
    matches
  };
}

function addTracksResult(
  playlistId: string,
  matches: MatchedTrack[],
  added: PlaylistItem[],
  playlist?: PlaylistSummary
): PlaylistAddTracksResult {
  return {
    playlist,
    playlistId,
    requestedCount: matches.length,
    matchedCount: matches.filter((match) => match.status === "matched").length,
    addedCount: added.length,
    added,
    skipped: matches.filter((match) => match.status !== "matched")
  };
}

function buildDraftQueries(input: {
  prompt?: string;
  seedTracks?: TrackSearchSpec[];
  mood?: string;
  genre?: string;
  era?: string;
}): string[] {
  const base = [input.prompt, input.mood, input.genre, input.era].filter(Boolean).join(" ").trim();
  const queries = new Set<string>();

  if (base) {
    queries.add(base);
    queries.add(`${base} playlist songs`);
  }

  for (const seed of input.seedTracks ?? []) {
    const seedQuery = trackSpecToQuery(seed);
    if (seedQuery) {
      queries.add(seedQuery);
      queries.add(`${seedQuery} similar songs`);
    }
  }

  if (!queries.size) {
    queries.add("new music playlist songs");
  }

  return [...queries].slice(0, 12);
}

function dedupeCandidates(candidates: TrackCandidate[]): TrackCandidate[] {
  const seen = new Set<string>();
  const result: TrackCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.videoId)) {
      continue;
    }

    seen.add(candidate.videoId);
    result.push(candidate);
  }

  return result;
}

function trackCacheKey(spec: TrackSearchSpec): string | null {
  if (spec.title && spec.artist) {
    return `${spec.title.toLowerCase().trim()}::${spec.artist.toLowerCase().trim()}`;
  }

  if (spec.query) {
    return `query::${spec.query.toLowerCase().trim()}`;
  }

  return null;
}
