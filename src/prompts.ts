import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPlaylistPrompts(server: McpServer): void {
  server.registerPrompt(
    "curate_playlist",
    {
      title: "Curate Playlist",
      description:
        "Plan a safe MCP-first playlist creation, expansion, or cleanup workflow from a user goal.",
      argsSchema: {
        goal: z.string().describe("The user's playlist goal or requested change."),
        playlistId: z
          .string()
          .optional()
          .describe("Existing YouTube playlist ID if the user wants to update a playlist."),
        writeMode: z
          .enum(["preview-only", "ask-before-writing", "apply-after-user-confirms"])
          .optional()
          .describe("How aggressively the assistant should write changes. Default: ask-before-writing.")
      }
    },
    async ({ goal, playlistId, writeMode }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use the YouTube Music Playlist MCP server to satisfy this playlist goal.",
              "",
              `Goal: ${goal}`,
              playlistId ? `Existing playlistId: ${playlistId}` : "Existing playlistId: not provided",
              `Write mode: ${writeMode ?? "ask-before-writing"}`,
              "",
              "Rules:",
              "- Use MCP tools only; do not call YouTube APIs directly from the client.",
              "- Call auth_status first if authentication state is unknown.",
              "- Use playlist_list or playlist_get to inspect existing playlists before updating.",
              "- Use playlist_match_tracks or yt_search_tracks to resolve tracks before writing.",
              "- Prefer exact videoId values after candidate selection.",
              "- Preview mutations with dryRun:true before applying.",
              "- Set dryRun:false only after the user approves the exact change.",
              "- Set confirm:true only for explicitly requested destructive operations.",
              "- For reorder operations, obtain playlistItemId values from playlist_get and use small batches.",
              "- Report ambiguous or missing matches instead of silently skipping them."
            ].join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "research_focus_playlist",
    {
      title: "Research Focus Playlist",
      description:
        "Guide an LLM through building a research-backed focus playlist while using MCP tools safely.",
      argsSchema: {
        goal: z.string().describe("The kind of focus playlist the user wants."),
        targetLength: z
          .string()
          .optional()
          .describe("Approximate number of tracks or listening duration requested by the user.")
      }
    },
    async ({ goal, targetLength }) => {
      const goalLower = goal.toLowerCase();
      const isHighEnergy = /gym|workout|energy|intense|hype|pump/.test(goalLower);
      const isCoding = /cod|debug|program|develop|engineer|hack/.test(goalLower);
      const isReading = /read|study|focus|concentrat|essay|writ/.test(goalLower);
      const isMeditation = /meditat|relax|calm|sleep|wind/.test(goalLower);

      const genreGuide = isHighEnergy
        ? "Energetic genres: drum and bass, electronic rock, metal, psytrance, high-BPM electronic."
        : isMeditation
          ? "Calm genres: drone, dark ambient, binaural, slow classical, minimal piano."
          : isCoding
            ? "Recommended genres for coding: lo-fi hip-hop, ambient electronic, minimal techno, post-rock, neoclassical."
            : isReading
              ? "Recommended genres for reading/study: classical, ambient, neoclassical, acoustic instrumental, jazz."
              : "Adapt genres to the goal. Default safe choices: ambient, lo-fi, neoclassical, minimal electronic.";

      const lyricGuide = isHighEnergy
        ? "Lyrics are acceptable for high-energy work; heavy vocals are fine."
        : "Prefer lyric-light or instrumental tracks to avoid interfering with verbal working memory.";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Build a research-backed focus playlist using the YouTube Music Playlist MCP server.",
                "",
                `Goal: ${goal}`,
                `Target length: ${targetLength ?? "not specified"}`,
                "",
                "Curation criteria:",
                `- ${lyricGuide}`,
                `- ${genreGuide}`,
                "- Prefer stable dynamics and low novelty during deep work phases.",
                "- Structure: start with slightly more rhythmic tracks for warm-up, then transition to lower-distraction material.",
                "- Add a reason per track explaining why it fits (tempo, mood, lyric content, BPM, etc.).",
                "",
                "Workflow:",
                "1. Call auth_status first.",
                "2. From your own knowledge, compose a {title, artist, reason}[] list matching the curation criteria above.",
                "3. Call playlist_propose with your curated list for the user to review BEFORE any YouTube search.",
                "   The user may ask for changes — if so, call playlist_propose_update with the edits.",
                "4. After approval, call playlist_match_tracks (searchProvider:ytmusic) to resolve to videoIds.",
                "   ytmusic uses no API quota. Resolved videoIds are cached for future runs.",
                "5. Call playlist_create with dryRun:true and the matched tracks to show a preview with estimated duration.",
                "6. Set dryRun:false only after the user explicitly approves."
              ].join("\n")
            }
          }
        ]
      };
    }
  );
}
