import { quotaUsagePath } from "../config/paths.js";
import { readJsonFile, writeJsonFile } from "../auth/authState.js";

const DAILY_QUOTA_LIMIT = 10_000;

// Resets midnight Pacific time (UTC-7/UTC-8); we approximate with UTC date for simplicity.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface QuotaUsageState {
  date: string;
  used: number;
}

async function loadState(): Promise<QuotaUsageState> {
  const stored = await readJsonFile<QuotaUsageState>(quotaUsagePath());
  if (!stored || stored.date !== todayUtc()) {
    return { date: todayUtc(), used: 0 };
  }
  return stored;
}

export async function trackQuota(units: number): Promise<void> {
  const state = await loadState();
  state.used += units;
  await writeJsonFile(quotaUsagePath(), state);
}

export async function quotaStatus(): Promise<{
  date: string;
  used: number;
  remaining: number;
  limit: number;
  note: string;
}> {
  const state = await loadState();
  const remaining = Math.max(0, DAILY_QUOTA_LIMIT - state.used);
  return {
    date: state.date,
    used: state.used,
    remaining,
    limit: DAILY_QUOTA_LIMIT,
    note: "Tracked locally from this MCP server. Resets at midnight UTC (real quota resets midnight Pacific). Search costs 100 units/call; playlist reads ~3; writes ~1 per track."
  };
}
