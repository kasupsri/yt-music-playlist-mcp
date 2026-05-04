export type PrivacyStatus = "public" | "private" | "unlisted";

export interface TrackSearchSpec {
  query?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  videoId?: string;
}

export interface TrackCandidate {
  videoId: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  source: "youtube-data" | "youtube-music";
  confidence?: number;
  url: string;
}

export interface PlaylistSummary {
  id: string;
  title: string;
  description?: string;
  privacyStatus?: string;
  itemCount?: number;
  url: string;
}

export interface PlaylistItem {
  playlistItemId: string;
  videoId: string;
  title: string;
  artists: string[];
  position: number;
  durationSeconds?: number;
  url: string;
}

export interface PlaylistDetail extends PlaylistSummary {
  items: PlaylistItem[];
}

export interface MatchedTrack {
  input: TrackSearchSpec;
  selected?: TrackCandidate;
  candidates: TrackCandidate[];
  status: "matched" | "ambiguous" | "missing";
}

export interface BulkMutationPreview {
  dryRun: true;
  playlistId?: string;
  requestedCount: number;
  matchedCount: number;
  ambiguousCount: number;
  missingCount: number;
  estimatedDurationSeconds?: number;
  matches: MatchedTrack[];
}
