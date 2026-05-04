import { google, youtube_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type {
  PlaylistDetail,
  PlaylistItem,
  PlaylistSummary,
  PrivacyStatus,
  TrackCandidate
} from "./types.js";
import { parseIso8601DurationSeconds } from "../utils/time.js";
import { trackQuota } from "../utils/quota.js";

export class YTDataClient {
  private readonly youtube: youtube_v3.Youtube;

  constructor(auth: OAuth2Client) {
    this.youtube = google.youtube({ version: "v3", auth });
  }

  async searchTracks(query: string, maxResults = 10): Promise<TrackCandidate[]> {
    void trackQuota(100);
    const search = await this.youtube.search.list({
      part: ["snippet"],
      q: query,
      type: ["video"],
      videoCategoryId: "10",
      maxResults
    });

    const ids =
      search.data.items
        ?.map((item) => item.id?.videoId)
        .filter((id): id is string => Boolean(id)) ?? [];

    if (!ids.length) {
      return [];
    }

    const videos = await this.youtube.videos.list({
      part: ["snippet", "contentDetails"],
      id: ids
    });

    return (
      videos.data.items?.map((video) => ({
        videoId: requireId(video.id, "video id"),
        title: video.snippet?.title ?? "Untitled",
        artists: [video.snippet?.channelTitle ?? "Unknown artist"],
        durationSeconds: parseIso8601DurationSeconds(video.contentDetails?.duration),
        source: "youtube-data" as const,
        url: videoUrl(requireId(video.id, "video id"))
      })) ?? []
    );
  }

  async listPlaylists(): Promise<PlaylistSummary[]> {
    const playlists: PlaylistSummary[] = [];
    let pageToken: string | undefined;

    do {
      void trackQuota(1);
      const response = await this.youtube.playlists.list({
        part: ["snippet", "contentDetails", "status"],
        mine: true,
        maxResults: 50,
        pageToken
      });

      for (const playlist of response.data.items ?? []) {
        playlists.push(mapPlaylistSummary(playlist));
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return playlists;
  }

  async getPlaylist(playlistId: string): Promise<PlaylistDetail> {
    void trackQuota(3);
    const playlistResponse = await this.youtube.playlists.list({
      part: ["snippet", "contentDetails", "status"],
      id: [playlistId],
      maxResults: 1
    });

    const playlist = playlistResponse.data.items?.[0];
    if (!playlist) {
      throw new Error(`Playlist not found: ${playlistId}`);
    }

    const items = await this.listPlaylistItems(playlistId);
    const durationMap = await this.fetchVideoDurations(items.map((item) => item.videoId));
    const itemsWithDuration = items.map((item) => ({
      ...item,
      durationSeconds: durationMap.get(item.videoId)
    }));

    return {
      ...mapPlaylistSummary(playlist),
      items: itemsWithDuration
    };
  }

  private async fetchVideoDurations(videoIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const chunkSize = 50;

    for (let i = 0; i < videoIds.length; i += chunkSize) {
      const chunk = videoIds.slice(i, i + chunkSize);
      try {
        const response = await this.youtube.videos.list({
          part: ["contentDetails"],
          id: chunk
        });

        for (const video of response.data.items ?? []) {
          const id = video.id;
          const duration = parseIso8601DurationSeconds(video.contentDetails?.duration);
          if (id && duration !== undefined) {
            map.set(id, duration);
          }
        }
      } catch (error) {
        process.stderr.write(
          `Failed to fetch durations for chunk at offset ${i}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }

    return map;
  }

  async createPlaylist(input: {
    title: string;
    description?: string;
    privacyStatus?: PrivacyStatus;
  }): Promise<PlaylistSummary> {
    void trackQuota(1);
    const response = await this.youtube.playlists.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: input.title,
          description: input.description ?? ""
        },
        status: {
          privacyStatus: input.privacyStatus ?? "private"
        }
      }
    });

    return mapPlaylistSummary(response.data);
  }

  async updatePlaylist(input: {
    playlistId: string;
    title?: string;
    description?: string;
    privacyStatus?: PrivacyStatus;
  }): Promise<PlaylistSummary> {
    const current = await this.getPlaylist(input.playlistId);
    const response = await this.youtube.playlists.update({
      part: ["snippet", "status"],
      requestBody: {
        id: input.playlistId,
        snippet: {
          title: input.title ?? current.title,
          description: input.description ?? current.description ?? ""
        },
        status: {
          privacyStatus: input.privacyStatus ?? current.privacyStatus ?? "private"
        }
      }
    });

    return mapPlaylistSummary(response.data);
  }

  async deletePlaylist(playlistId: string): Promise<{ playlistId: string; deleted: true }> {
    await this.youtube.playlists.delete({ id: playlistId });
    return { playlistId, deleted: true };
  }

  async addTracks(playlistId: string, videoIds: string[]): Promise<PlaylistItem[]> {
    const added: PlaylistItem[] = [];

    for (const videoId of videoIds) {
      void trackQuota(1);
      const response = await this.youtube.playlistItems.insert({
        part: ["snippet", "contentDetails"],
        requestBody: {
          snippet: {
            playlistId,
            resourceId: {
              kind: "youtube#video",
              videoId
            }
          }
        }
      });

      const mapped = mapPlaylistItem(response.data);
      if (mapped) {
        added.push(mapped);
      }
    }

    return added;
  }

  async removeTracks(input: {
    playlistId: string;
    playlistItemIds?: string[];
    videoIds?: string[];
  }): Promise<{ removedPlaylistItemIds: string[] }> {
    const playlistItemIds = new Set(input.playlistItemIds ?? []);

    if (input.videoIds?.length) {
      const items = await this.listPlaylistItems(input.playlistId);
      const videoIds = new Set(input.videoIds);
      for (const item of items) {
        if (videoIds.has(item.videoId)) {
          playlistItemIds.add(item.playlistItemId);
        }
      }
    }

    const removedPlaylistItemIds: string[] = [];
    for (const playlistItemId of playlistItemIds) {
      void trackQuota(1);
      await this.youtube.playlistItems.delete({ id: playlistItemId });
      removedPlaylistItemIds.push(playlistItemId);
    }

    return { removedPlaylistItemIds };
  }

  async reorderTrack(input: {
    playlistId: string;
    playlistItemId: string;
    position: number;
  }): Promise<PlaylistItem> {
    const items = await this.listRawPlaylistItems(input.playlistId);
    const item = items.find((candidate) => candidate.id === input.playlistItemId);
    if (!item) {
      throw new Error(`Playlist item not found: ${input.playlistItemId}`);
    }

    void trackQuota(1);
    const response = await this.youtube.playlistItems.update({
      part: ["snippet", "contentDetails"],
      requestBody: {
        id: input.playlistItemId,
        snippet: {
          playlistId: input.playlistId,
          resourceId: item.snippet?.resourceId,
          position: input.position
        }
      }
    });

    const mapped = mapPlaylistItem(response.data);
    if (!mapped) {
      throw new Error(`Could not map reordered playlist item: ${input.playlistItemId}`);
    }

    return mapped;
  }

  async replaceTracks(playlistId: string, videoIds: string[]): Promise<PlaylistDetail> {
    const current = await this.listPlaylistItems(playlistId);
    await this.removeTracks({
      playlistId,
      playlistItemIds: current.map((item) => item.playlistItemId)
    });
    await this.addTracks(playlistId, videoIds);
    return this.getPlaylist(playlistId);
  }

  private async listPlaylistItems(playlistId: string): Promise<PlaylistItem[]> {
    return (await this.listRawPlaylistItems(playlistId))
      .map(mapPlaylistItem)
      .filter((item): item is PlaylistItem => Boolean(item));
  }

  private async listRawPlaylistItems(playlistId: string): Promise<youtube_v3.Schema$PlaylistItem[]> {
    const items: youtube_v3.Schema$PlaylistItem[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.youtube.playlistItems.list({
        part: ["snippet", "contentDetails"],
        playlistId,
        maxResults: 50,
        pageToken
      });

      items.push(...(response.data.items ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return items;
  }
}

function mapPlaylistSummary(playlist: youtube_v3.Schema$Playlist): PlaylistSummary {
  const id = requireId(playlist.id, "playlist id");
  return {
    id,
    title: playlist.snippet?.title ?? "Untitled playlist",
    description: playlist.snippet?.description ?? undefined,
    privacyStatus: playlist.status?.privacyStatus ?? undefined,
    itemCount: playlist.contentDetails?.itemCount ?? undefined,
    url: playlistUrl(id)
  };
}

function mapPlaylistItem(item: youtube_v3.Schema$PlaylistItem): PlaylistItem | null {
  const playlistItemId = item.id;
  const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
  if (!playlistItemId || !videoId) {
    return null;
  }

  return {
    playlistItemId,
    videoId,
    title: item.snippet?.title ?? "Untitled",
    artists: [item.snippet?.videoOwnerChannelTitle ?? item.snippet?.channelTitle ?? "Unknown artist"],
    position: item.snippet?.position ?? 0,
    url: videoUrl(videoId)
  };
}

function playlistUrl(playlistId: string): string {
  return `https://music.youtube.com/playlist?list=${playlistId}`;
}

function videoUrl(videoId: string): string {
  return `https://music.youtube.com/watch?v=${videoId}`;
}

function requireId(value: string | null | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing ${label} from YouTube API response.`);
  }

  return value;
}
