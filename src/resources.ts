import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YTProvider } from "./providers/ytProvider.js";
import { jsonText } from "./utils/json.js";

const WORKFLOW_GUIDE = `YouTube Music Playlist MCP workflow guide

Purpose
- Manage YouTube playlists through MCP tools, not through direct API calls from the LLM client.
- Playback is intentionally out of scope.

Recommended workflow — fastest and lowest quota cost
1. Call auth_status if authentication is unknown.
2. Call playlist_propose with your curated {title, artist, reason?}[] list from your own knowledge.
   This is zero API calls — shows the user the proposed track list for approval before any search.
3. After user approval, call playlist_match_tracks (searchProvider:ytmusic) to resolve to videoIds.
   ytmusic uses the unofficial YouTube Music API — no quota cost. Resolved videoIds are cached locally.
4. Call playlist_create with dryRun:true and the matched tracks to preview (includes estimated duration).
5. Set dryRun:false after user approval. Playlist creation only costs ~1 + N quota units (no search).

Recommended workflow — discovery-based (exploring genres/moods)
1. Call auth_status if authentication is unknown.
2. Call playlist_generate_draft with preselectedTracks (your picks) and/or prompt/mood/genre/era.
   preselectedTracks are matched first; search results supplement them.
3. Review and curate the returned candidates with the user.
4. Pass chosen candidates to playlist_create with dryRun:true to preview.
5. Set dryRun:false after user approval.

API quota guidance (YouTube Data API: 10,000 units/day, resets midnight Pacific)
- playlist_propose: 0 units
- playlist_match_tracks (searchProvider:ytmusic): 0 units (YouTube Music API, unofficial, no quota)
- playlist_match_tracks (searchProvider:auto): 100 units per track with no Music result (last resort)
- playlist_create / playlist_add_tracks: ~1 + N units (playlist insert + N track inserts)
- playlist_get: ~3 units; playlist_list: ~1 unit; yt_search_tracks: 100 units/call
- If quota is exhausted: use searchProvider:ytmusic for matching; CRUD still works until quota resets.

Track caching
- Successful title+artist → videoId resolutions are cached in .local/track-cache.json.
- Re-running playlist_match_tracks for the same tracks skips YouTube entirely and returns cached videoIds.
- Cache persists across sessions. Clear it by deleting .local/track-cache.json if results go stale.

Mutation safety
- Additive writes: playlist_create, playlist_add_tracks.
- Mutating writes: playlist_update, playlist_reorder_tracks.
- Destructive writes: playlist_remove_tracks, playlist_replace_tracks, playlist_delete.
- Preview mutations first (dryRun:true is the default for all mutating tools).
- Apply writes only when the user has approved the change.
- Do not set confirm:true unless the user explicitly requested that destructive operation.

Track matching guidance
- title + artist is better than query-only matching.
- videoId is best when already known — bypasses all search, zero quota, always matched.
- Ambiguous or missing matches must be shown to the user — never silently skip them.
- estimatedDurationSeconds in preview results shows the total playlist length.

Reorder operations
- Call playlist_get first to get playlistItemId values.
- Keep reorder batches small (max 25 at a time).
`;

export function registerPlaylistResources(server: McpServer): void {
  server.registerResource(
    "playlist_workflow_guide",
    "ytmusic-mcp://guide/workflows",
    {
      title: "Playlist Workflow Guide",
      description: "Operational guidance for LLMs using this YouTube Music playlist MCP server.",
      mimeType: "text/plain"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: WORKFLOW_GUIDE
        }
      ]
    })
  );

  const provider = new YTProvider();
  server.registerResource(
    "playlist_snapshot",
    new ResourceTemplate("ytmusic-mcp://playlists/{playlistId}", {
      list: undefined
    }),
    {
      title: "Playlist Snapshot",
      description:
        "Read a playlist as JSON by URI. Example: ytmusic-mcp://playlists/PLxxxxxxxxxxxxxxxx",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const playlistId = String(variables.playlistId ?? "");
      const playlist = await provider.getPlaylist(playlistId);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: jsonText(playlist)
          }
        ]
      };
    }
  );
}
