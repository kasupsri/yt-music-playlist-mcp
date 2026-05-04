import { describe, expect, it } from "vitest";
import { classifyMatch, normalizeText, rankCandidates, trackSpecToQuery } from "./match.js";
import type { TrackCandidate } from "../providers/types.js";

const candidates: TrackCandidate[] = [
  {
    videoId: "a",
    title: "Midnight City",
    artists: ["M83"],
    source: "youtube-music",
    url: "https://music.youtube.com/watch?v=a",
    durationSeconds: 244
  },
  {
    videoId: "b",
    title: "Midnight City Official Video",
    artists: ["Random Channel"],
    source: "youtube-data",
    url: "https://music.youtube.com/watch?v=b",
    durationSeconds: 301
  }
];

describe("match utilities", () => {
  it("builds a query from structured track fields", () => {
    expect(trackSpecToQuery({ title: "Midnight City", artist: "M83" })).toBe("Midnight City M83");
  });

  it("normalizes generic YouTube title words", () => {
    expect(normalizeText("Midnight City (Official Video)")).toBe("midnight city");
  });

  it("ranks the best candidate first", () => {
    const ranked = rankCandidates({ title: "Midnight City", artist: "M83", durationSeconds: 244 }, candidates);
    expect(ranked[0].videoId).toBe("a");
    expect(ranked[0].confidence).toBeGreaterThan(0.8);
  });

  it("classifies low-confidence results as ambiguous", () => {
    const match = classifyMatch({ title: "Completely Different Song" }, candidates);
    expect(match.status).toBe("ambiguous");
    expect(match.selected).toBeUndefined();
  });
});
