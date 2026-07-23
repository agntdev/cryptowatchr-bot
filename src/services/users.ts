import { now } from "../lib/clock.js";
import {
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  keys,
  type GlobalStats,
  type UserProfile,
} from "../lib/models.js";
import { storeGet, storeSet } from "../lib/store.js";

export async function getStats(): Promise<GlobalStats> {
  return (
    (await storeGet<GlobalStats>(keys.stats())) ?? {
      total_users: 0,
      user_ids: [],
      alert_counts: {},
      alert_type_counts: {},
    }
  );
}

export async function saveStats(stats: GlobalStats): Promise<void> {
  await storeSet(keys.stats(), stats);
}

export async function getProfile(uid: number): Promise<UserProfile | undefined> {
  return storeGet<UserProfile>(keys.profile(uid));
}

/**
 * Ensure a user profile exists (onboarding). Creates defaults and bumps
 * global user count on first sight.
 */
export async function ensureProfile(
  uid: number,
  displayName: string,
): Promise<UserProfile> {
  const existing = await getProfile(uid);
  if (existing) {
    if (displayName && existing.display_name !== displayName) {
      existing.display_name = displayName;
      await storeSet(keys.profile(uid), existing);
    }
    return existing;
  }

  const profile: UserProfile = {
    telegram_id: uid,
    display_name: displayName || "User",
    timezone: "UTC",
    quiet_hours_start: DEFAULT_QUIET_START,
    quiet_hours_end: DEFAULT_QUIET_END,
    summary_time: null,
    summary_enabled: false,
    created_at: now(),
  };
  await storeSet(keys.profile(uid), profile);

  const stats = await getStats();
  if (!stats.user_ids.includes(uid)) {
    stats.user_ids.push(uid);
    stats.total_users = stats.user_ids.length;
    await saveStats(stats);
  }
  return profile;
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await storeSet(keys.profile(profile.telegram_id), profile);
}

export function isOwner(uid: number | undefined): boolean {
  if (uid == null) return false;
  const raw =
    typeof process !== "undefined" ? process.env.OWNER_TELEGRAM_ID : undefined;
  if (!raw) return false;
  const id = Number(raw);
  return Number.isFinite(id) && id === uid;
}
