export function parseIso8601DurationSeconds(duration?: string | null): number | undefined {
  if (!duration) {
    return undefined;
  }

  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match) {
    return undefined;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseClockDurationSeconds(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value
    .trim()
    .split(":")
    .map((part) => Number(part));

  if (parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return undefined;
}
