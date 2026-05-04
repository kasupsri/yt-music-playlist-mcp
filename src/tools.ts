import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { YTProvider, type SearchProvider } from "./providers/ytProvider.js";
import { compactError, jsonText } from "./utils/json.js";

const PrivacyStatusSchema = z.enum(["public", "private", "unlisted"]);

const ReadOnlyExternal: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const SafeExternalMutation: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

const DestructiveExternalMutation: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const TrackSpecSchema = z
  .object({
    query: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    artist: z.string().min(1).optional(),
    album: z.string().min(1).optional(),
    durationSeconds: z.number().int().positive().optional(),
    videoId: z.string().min(1).optional()
  })
  .strict();

const MatchOptionsSchema = {
  maxCandidates: z.number().int().min(1).max(25).optional(),
  minConfidence: z.number().min(0).max(1).optional()
};

export function registerPlaylistTools(server: McpServer): void {
  const provider = new YTProvider();

  server.registerTool(
    "auth_status",
    {
      title: "Auth Status",
      description:
        "Check whether Google OAuth is ready before using playlist tools. Use this first when auth state is unknown.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    toolHandler(async () => provider.authStatus())
  );

  server.registerTool(
    "yt_search_tracks",
    {
      title: "Search YouTube Music Tracks",
      description:
        "Search YouTube Music/YouTube for track candidates. Prefer passing title and artist when known; use returned videoId values for exact playlist mutations.",
      inputSchema: {
        ...TrackSpecSchema.shape,
        maxResults: z.number().int().min(1).max(25).optional()
      },
      annotations: ReadOnlyExternal
    },
    toolHandler(async (input) => provider.searchTracks(input, input.maxResults))
  );

  server.registerTool(
    "playlist_list",
    {
      title: "List Playlists",
      description: "List playlists owned by the authenticated YouTube account. Use this to find a playlistId.",
      inputSchema: {},
      annotations: ReadOnlyExternal
    },
    toolHandler(async () => provider.listPlaylists())
  );

  server.registerTool(
    "playlist_get",
    {
      title: "Get Playlist",
      description:
        "Fetch playlist metadata and items, including playlistItemId values required for remove and reorder operations.",
      inputSchema: {
        playlistId: z.string().min(1)
      },
      annotations: ReadOnlyExternal
    },
    toolHandler(async (input) => provider.getPlaylist(input.playlistId))
  );

  server.registerTool(
    "playlist_create",
    {
      title: "Create Playlist",
      description:
        "Preview or create a YouTube playlist, optionally adding matched tracks. Defaults to dryRun:true; set dryRun:false only after the user approves creation.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        privacyStatus: PrivacyStatusSchema.default("private"),
        tracks: z.array(TrackSpecSchema).max(500).optional(),
        dryRun: z.boolean().default(true),
        minConfidence: z.number().min(0).max(1).optional()
      },
      annotations: SafeExternalMutation
    },
    toolHandler(async (input) => provider.createPlaylist(input))
  );

  server.registerTool(
    "playlist_update",
    {
      title: "Update Playlist",
      description:
        "Preview or update playlist title, description, or privacy. Defaults to dryRun:true; set dryRun:false only after the user approves the metadata change.",
      inputSchema: {
        playlistId: z.string().min(1),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        privacyStatus: PrivacyStatusSchema.optional(),
        dryRun: z.boolean().default(true)
      },
      annotations: DestructiveExternalMutation
    },
    toolHandler(async (input) => provider.updatePlaylist(input))
  );

  server.registerTool(
    "playlist_delete",
    {
      title: "Delete Playlist",
      description: "Delete a playlist. Requires confirm: true.",
      inputSchema: {
        playlistId: z.string().min(1),
        confirm: z.boolean().default(false)
      },
      annotations: DestructiveExternalMutation
    },
    toolHandler(async (input) => provider.deletePlaylist(input))
  );

  server.registerTool(
    "playlist_add_tracks",
    {
      title: "Add Tracks",
      description:
        "Preview or add matched tracks to a playlist. Defaults to dryRun:true. For exact additions, pass videoId for each track.",
      inputSchema: {
        playlistId: z.string().min(1),
        tracks: z.array(TrackSpecSchema).min(1).max(500),
        dryRun: z.boolean().default(true),
        minConfidence: z.number().min(0).max(1).optional()
      },
      annotations: SafeExternalMutation
    },
    toolHandler(async (input) => provider.addTracks(input))
  );

  server.registerTool(
    "playlist_remove_tracks",
    {
      title: "Remove Tracks",
      description: "Remove playlist items by playlist item ID or video ID. Requires confirm: true.",
      inputSchema: {
        playlistId: z.string().min(1),
        playlistItemIds: z.array(z.string().min(1)).optional(),
        videoIds: z.array(z.string().min(1)).optional(),
        confirm: z.boolean().default(false)
      },
      annotations: DestructiveExternalMutation
    },
    toolHandler(async (input) => provider.removeTracks(input))
  );

  server.registerTool(
    "playlist_reorder_tracks",
    {
      title: "Reorder Tracks",
      description:
        "Preview or move playlist items to target positions. Requires playlistItemId from playlist_get. Defaults to dryRun:true; set dryRun:false to apply. Prefer small batches.",
      inputSchema: {
        playlistId: z.string().min(1),
        moves: z
          .array(
            z.object({
              playlistItemId: z.string().min(1),
              position: z.number().int().min(-1).describe("Target 0-based position. Use -1 to move to end.")
            })
          )
          .min(1)
          .max(25),
        dryRun: z.boolean().default(true)
      },
      annotations: DestructiveExternalMutation
    },
    toolHandler(async (input) => {
      // Resolve -1 (move-to-end) to the actual last position
      let resolvedMoves = input.moves;
      if (input.moves.some((m) => m.position === -1)) {
        const playlist = await provider.getPlaylist(input.playlistId);
        const lastPosition = Math.max(0, playlist.items.length - 1);
        resolvedMoves = input.moves.map((m) => (m.position === -1 ? { ...m, position: lastPosition } : m));
      }

      if (input.dryRun) {
        return {
          dryRun: true,
          playlistId: input.playlistId,
          moveCount: resolvedMoves.length,
          moves: resolvedMoves,
          message: "Reorder skipped. Call again with dryRun:false to apply these moves."
        };
      }

      const results = [];
      const errors = [];
      for (const move of resolvedMoves) {
        try {
          results.push(
            await provider.reorderTrack({
              playlistId: input.playlistId,
              playlistItemId: move.playlistItemId,
              position: move.position
            })
          );
        } catch (error) {
          errors.push({
            playlistItemId: move.playlistItemId,
            position: move.position,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return { results, errors: errors.length ? errors : undefined };
    })
  );

  server.registerTool(
    "playlist_replace_tracks",
    {
      title: "Replace Tracks",
      description:
        "Replace all playlist contents with matched tracks. Destructive. Defaults to dryRun:true and also requires confirm:true before applying.",
      inputSchema: {
        playlistId: z.string().min(1),
        tracks: z.array(TrackSpecSchema).min(1).max(500),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        minConfidence: z.number().min(0).max(1).optional()
      },
      annotations: DestructiveExternalMutation
    },
    toolHandler(async (input) => provider.replaceTracks(input))
  );

  server.registerTool(
    "playlist_match_tracks",
    {
      title: "Match Tracks",
      description:
        "Resolve requested songs to ranked YouTube candidates with confidence scores. Use this before playlist mutations when you do not already have exact videoId values. " +
        "Defaults to searchProvider:ytmusic which uses the unofficial YouTube Music API (no quota cost). " +
        "Use searchProvider:auto to also fall back to YouTube Data API when Music returns nothing. " +
        "Resolved videoIds are cached locally (30-day TTL) to speed up repeated calls. " +
        "Result includes a top-level summary of matched/ambiguous/missing counts.",
      inputSchema: {
        tracks: z.array(TrackSpecSchema).min(1).max(500),
        ...MatchOptionsSchema,
        searchProvider: z
          .enum(["auto", "ytmusic", "youtube-data"])
          .default("ytmusic")
          .optional()
          .describe("Which search backend to use. ytmusic (default) costs no API quota.")
      },
      annotations: ReadOnlyExternal
    },
    toolHandler(async (input) => {
      const matches = await provider.matchTracks(input.tracks, {
        maxCandidates: input.maxCandidates,
        minConfidence: input.minConfidence,
        searchProvider: input.searchProvider as SearchProvider | undefined
      });
      const matched = matches.filter((m) => m.status === "matched").length;
      const ambiguous = matches.filter((m) => m.status === "ambiguous").length;
      const missing = matches.filter((m) => m.status === "missing").length;
      return {
        summary: { total: matches.length, matched, ambiguous, missing },
        attention: ambiguous + missing > 0
          ? `${ambiguous + missing} track(s) need review before proceeding.`
          : undefined,
        matches
      };
    })
  );

  server.registerTool(
    "playlist_propose",
    {
      title: "Propose Playlist",
      description:
        "Present your curated track list for user review before touching any YouTube API. " +
        "Call this first when you know which tracks you want — pass title+artist pairs from your own knowledge, " +
        "optionally with a reason per track. Zero API calls. " +
        "After the user approves, call playlist_match_tracks to resolve to videoIds, then playlist_create.",
      inputSchema: {
        title: z.string().min(1).describe("Proposed playlist name"),
        description: z.string().optional(),
        tracks: z
          .array(
            z.object({
              title: z.string().min(1),
              artist: z.string().min(1),
              reason: z.string().optional().describe("Why this track fits the playlist")
            })
          )
          .min(1)
          .max(200),
        mood: z.string().optional(),
        genre: z.string().optional(),
        notes: z.string().optional().describe("Overall curation notes or rationale")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    toolHandler(async (input) => provider.proposePlaylist(input))
  );

  server.registerTool(
    "playlist_propose_update",
    {
      title: "Update Proposed Playlist",
      description:
        "Add or remove tracks from a pending proposal without re-stating the full list. " +
        "Pass the current track list from a previous playlist_propose result, then addTracks and/or removeTracks. " +
        "Returns an updated proposal ready for another round of user review. Zero API calls.",
      inputSchema: {
        currentTracks: z
          .array(z.object({ title: z.string().min(1), artist: z.string().min(1), reason: z.string().optional() }))
          .min(1)
          .max(200),
        addTracks: z
          .array(z.object({ title: z.string().min(1), artist: z.string().min(1), reason: z.string().optional() }))
          .max(100)
          .optional(),
        removeTracks: z
          .array(z.object({ title: z.string().min(1), artist: z.string().min(1) }))
          .max(100)
          .optional(),
        notes: z.string().optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    toolHandler(async (input) => provider.proposePlaylistUpdate(input))
  );

  server.registerTool(
    "playlist_generate_draft",
    {
      title: "Generate Playlist Draft",
      description:
        "Build a candidate pool by matching your own curated track list and/or searching YouTube by prompt/mood/genre/era. " +
        "Pass preselectedTracks with the specific title+artist pairs you want — these are matched first and take priority over search results. " +
        "Use prompt/mood/genre/era/seedTracks to supplement with discovered candidates. " +
        "Pass playlistId to automatically exclude tracks already in that playlist. " +
        "This never writes to YouTube. Review candidates and then call playlist_create or playlist_add_tracks.",
      inputSchema: {
        preselectedTracks: z
          .array(TrackSpecSchema)
          .max(200)
          .optional()
          .describe(
            "Specific tracks you want in the playlist (title+artist pairs). These are matched against YouTube and ranked by confidence."
          ),
        prompt: z.string().min(1).optional(),
        seedTracks: z.array(TrackSpecSchema).max(50).optional(),
        mood: z.string().min(1).optional(),
        genre: z.string().min(1).optional(),
        era: z.string().min(1).optional(),
        targetLength: z.number().int().min(1).max(250).optional(),
        exclusions: z.array(z.string().min(1)).max(100).optional(),
        playlistId: z.string().min(1).optional().describe("Exclude tracks already in this playlist.")
      },
      annotations: ReadOnlyExternal
    },
    toolHandler(async (input) => provider.generateDraft(input))
  );

  server.registerTool(
    "playlist_expand",
    {
      title: "Expand Playlist",
      description:
        "Generate candidate tracks similar to an existing playlist without adding them. " +
        "Uses YouTube Music search (no quota cost). " +
        "Use playlist_add_tracks with selected candidates to apply.",
      inputSchema: {
        playlistId: z.string().min(1),
        targetAdditionalTracks: z.number().int().min(1).max(250).optional(),
        seedLimit: z.number().int().min(1).max(50).optional(),
        exclusions: z.array(z.string().min(1)).max(100).optional()
      },
      annotations: ReadOnlyExternal
    },
    toolHandler(async (input) => provider.expandPlaylist(input))
  );

  server.registerTool(
    "playlist_duplicate",
    {
      title: "Duplicate Playlist",
      description:
        "Copy an existing playlist (metadata + all tracks) into a new playlist. " +
        "Defaults to dryRun:true. Set dryRun:false after the user approves. " +
        "Useful before restructuring a playlist.",
      inputSchema: {
        playlistId: z.string().min(1),
        newTitle: z.string().min(1).optional().describe("Title for the copy. Defaults to '<original> (copy)'."),
        newDescription: z.string().optional(),
        privacyStatus: PrivacyStatusSchema.optional(),
        dryRun: z.boolean().default(true)
      },
      annotations: SafeExternalMutation
    },
    toolHandler(async (input) => provider.duplicatePlaylist(input))
  );

  server.registerTool(
    "playlist_audit",
    {
      title: "Audit Playlist",
      description:
        "Analyze a playlist and flag tracks that may not fit a focused coding vibe: " +
        "too long (default >10 min), too short (default <1 min), or titles that hint at vocals/live recordings. " +
        "Returns flagged tracks with reasons and a clean list. Zero mutations. " +
        "Use this before playlist_batch_edit to decide what to remove.",
      inputSchema: {
        playlistId: z.string().min(1),
        maxDurationSeconds: z
          .number().int().positive().optional()
          .describe("Flag tracks longer than this. Default 600s (10 min)."),
        minDurationSeconds: z
          .number().int().positive().optional()
          .describe("Flag tracks shorter than this. Default 60s."),
        flagVocalKeywords: z
          .boolean().optional()
          .describe("Check title for vocal/live keywords (feat, live, acoustic, choir…). Default true."),
        customFlagTerms: z
          .array(z.string().min(1)).max(50).optional()
          .describe("Extra terms to flag in track title or artist name.")
      },
      annotations: ReadOnlyExternal
    },
    toolHandler(async (input) => provider.auditPlaylist(input))
  );

  server.registerTool(
    "playlist_batch_edit",
    {
      title: "Batch Edit Playlist",
      description:
        "Remove specific tracks and add new ones in a single confirmed operation. " +
        "Shows a quota cost estimate in dry-run mode before touching the API. " +
        "Defaults to dryRun:true; set dryRun:false and confirm:true to apply. " +
        "Pass videoIds to remove and track specs (title+artist or videoId) to add. " +
        "Prefer this over separate remove + add calls to save quota.",
      inputSchema: {
        playlistId: z.string().min(1),
        removeVideoIds: z.array(z.string().min(1)).max(500).optional()
          .describe("Video IDs to remove from the playlist."),
        addTracks: z.array(TrackSpecSchema).max(500).optional()
          .describe("Tracks to add. Pass videoId for exact adds; title+artist to search."),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        minConfidence: z.number().min(0).max(1).optional()
      },
      annotations: DestructiveExternalMutation
    },
    toolHandler(async (input) => provider.batchEdit(input))
  );

  server.registerTool(
    "playlist_quota_status",
    {
      title: "Quota Status",
      description:
        "Show estimated YouTube Data API quota usage for today. " +
        "Tracked locally by this MCP server — approximate, resets at midnight UTC. " +
        "Use this before choosing a search strategy to avoid exhausting the 10,000 unit daily limit.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    toolHandler(async () => provider.quotaStatus())
  );
}

function toolHandler<TInput extends Record<string, any>>(
  handler: (input: TInput) => Promise<unknown>
): (input: TInput) => Promise<CallToolResult> {
  return async (input: TInput) => {
    try {
      const value = await handler(input);
      const structuredContent = asStructuredContent(value);
      return {
        content: [{ type: "text", text: jsonText(value) }],
        structuredContent
      };
    } catch (error) {
      const structuredContent = {
        error: compactError(error)
      };
      return {
        isError: true,
        content: [{ type: "text", text: jsonText(structuredContent.error) }],
        structuredContent
      };
    }
  };
}

function asStructuredContent(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { result: value };
}
