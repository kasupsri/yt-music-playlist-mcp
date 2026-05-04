import type { MatchedTrack, TrackCandidate, TrackSearchSpec } from "../providers/types.js";

const GENERIC_WORDS = new Set(["official", "video", "audio", "lyrics", "lyric", "remaster", "remastered"]);
const VARIANT_WORDS = ["remix", "live", "remaster", "remastered", "cover", "acoustic", "instrumental", "edit", "version", "tour", "session", "variations", "mix", "reimagined", "retake", "demo", "reprise", "alternate", "deluxe"];

export function trackSpecToQuery(spec: TrackSearchSpec): string {
  if (spec.videoId) {
    return spec.videoId;
  }

  if (spec.query?.trim()) {
    return spec.query.trim();
  }

  return [spec.title, spec.artist, spec.album].filter(Boolean).join(" ").trim();
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")  // strip combining diacritical marks (e.g. í -> i)
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !GENERIC_WORDS.has(word))
    .join(" ");
}

export function scoreCandidate(spec: TrackSearchSpec, candidate: TrackCandidate): number {
  if (spec.videoId && spec.videoId === candidate.videoId) {
    return 1;
  }

  const query = normalizeText(trackSpecToQuery(spec));
  const candidateText = normalizeText(
    [candidate.title, ...candidate.artists, candidate.album].filter(Boolean).join(" ")
  );

  if (!query || !candidateText) {
    return 0;
  }

  const queryTokens = new Set(query.split(/\s+/));
  const candidateTokens = new Set(candidateText.split(/\s+/));
  const overlap = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
  const tokenScore = overlap / Math.max(queryTokens.size, 1);

  const normalizedSpecTitle = spec.title ? normalizeText(spec.title) : "";
  const normalizedCandTitle = normalizeText(candidate.title);
  const titleScore = normalizedSpecTitle && normalizedCandTitle.includes(normalizedSpecTitle) ? 0.25 : 0;
  const artistScore =
    spec.artist && candidate.artists.some((artist) => normalizeText(artist).includes(normalizeText(spec.artist ?? "")))
      ? 0.2
      : 0;
  const durationScore = durationConfidence(spec.durationSeconds, candidate.durationSeconds);

  // Penalize remix/live/variant titles when the spec doesn't ask for them
  const specLower = (spec.title ?? spec.query ?? "").toLowerCase();
  const candLower = candidate.title.toLowerCase();
  const variantPenalty =
    VARIANT_WORDS.some((word) => candLower.includes(word)) && !VARIANT_WORDS.some((word) => specLower.includes(word))
      ? 0.2
      : 0;

  // Penalize covers where artist name appears parenthetically in the title (e.g. "Song (Original Artist)")
  const artistInTitlePenalty =
    spec.artist &&
    candLower.includes("(" + spec.artist.toLowerCase() + ")") &&
    !candidate.artists.some((a) => a.toLowerCase().includes(spec.artist!.toLowerCase()))
      ? 0.15
      : 0;

  // Reward title length similarity (prefer shorter/cleaner titles for original tracks)
  const titleLengthPenalty = spec.title
    ? Math.min(0.1, Math.max(0, (candidate.title.length - spec.title.length * 1.5) / 100))
    : 0;

  return clamp(tokenScore * 0.55 + titleScore + artistScore + durationScore * 0.15 - variantPenalty - artistInTitlePenalty - titleLengthPenalty, 0, 1);
}

export function rankCandidates(spec: TrackSearchSpec, candidates: TrackCandidate[]): TrackCandidate[] {
  const byVideoId = new Map<string, TrackCandidate>();
  for (const candidate of candidates) {
    const scored = { ...candidate, confidence: scoreCandidate(spec, candidate) };
    const existing = byVideoId.get(candidate.videoId);
    if (!existing || (scored.confidence ?? 0) > (existing.confidence ?? 0)) {
      byVideoId.set(candidate.videoId, scored);
    }
  }

  return [...byVideoId.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

export function classifyMatch(
  spec: TrackSearchSpec,
  candidates: TrackCandidate[],
  minConfidence = 0.72,
  ambiguityDelta = 0.04
): MatchedTrack {
  const ranked = rankCandidates(spec, candidates);
  const selected = ranked[0];
  if (!selected || (selected.confidence ?? 0) < minConfidence) {
    return { input: spec, candidates: ranked, status: ranked.length ? "ambiguous" : "missing" };
  }

  const second = ranked[1];
  if (second && (selected.confidence ?? 0) - (second.confidence ?? 0) < ambiguityDelta) {
    // If the top two have identical titles, pick the first (most popular result) rather than flagging as ambiguous
    if (second.title.toLowerCase() === selected.title.toLowerCase()) {
      return { input: spec, selected, candidates: ranked, status: "matched" };
    }
    return { input: spec, candidates: ranked, status: "ambiguous" };
  }

  return { input: spec, selected, candidates: ranked, status: "matched" };
}

function durationConfidence(expected?: number, actual?: number): number {
  if (!expected || !actual) {
    return 0.5;
  }

  const delta = Math.abs(expected - actual);
  if (delta <= 3) {
    return 1;
  }

  if (delta <= 10) {
    return 0.75;
  }

  if (delta <= 30) {
    return 0.35;
  }

  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
