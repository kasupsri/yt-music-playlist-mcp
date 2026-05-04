import { describe, expect, it } from "vitest";
import { parseMusicSearchResults } from "./ytMusicClient.js";

describe("YouTube Music result parser", () => {
  it("extracts track candidates from musicResponsiveListItemRenderer payloads", () => {
    const payload = {
      contents: {
        sectionListRenderer: {
          contents: [
            {
              musicResponsiveListItemRenderer: {
                playlistItemData: { videoId: "abc123" },
                flexColumns: [
                  {
                    musicResponsiveListItemFlexColumnRenderer: {
                      text: { runs: [{ text: "Song Title" }] }
                    }
                  },
                  {
                    musicResponsiveListItemFlexColumnRenderer: {
                      text: { runs: [{ text: "Song • Artist Name • Album Name • 3:45" }] }
                    }
                  }
                ],
                fixedColumns: [
                  {
                    musicResponsiveListItemFixedColumnRenderer: {
                      text: { runs: [{ text: "3:45" }] }
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    };

    expect(parseMusicSearchResults(payload)).toEqual([
      {
        videoId: "abc123",
        title: "Song Title",
        artists: ["Artist Name", "Album Name"],
        durationSeconds: 225,
        source: "youtube-music",
        url: "https://music.youtube.com/watch?v=abc123"
      }
    ]);
  });
});
