/**
 * Timezone plumbing.
 *
 * Everything time-of-day in this server — quiet hours, streak day boundaries,
 * the local-hour cron buckets — reads `User.timezone`. It used to default to
 * 'UTC' and be written *only* by updateProfile, which meant essentially every
 * user was 'UTC' and every timezone-aware feature silently behaved as if the
 * world lived on Railway's clock. The helpers below are the single sanctioned
 * way to accept and normalise a zone so that can't quietly regress:
 * an invalid zone is rejected at the door rather than swallowed by an
 * Intl try/catch three layers down.
 */

/** True if `tz` is a zone `Intl` actually understands (i.e. safe to store). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A storable zone, or `undefined` if the caller gave us nothing usable.
 * `undefined` means "don't write the field" — never overwrite a good stored
 * zone with a fallback.
 */
export function normalizeTimeZone(tz: unknown): string | undefined {
  return isValidTimeZone(tz) ? tz : undefined;
}

/** The zone assumed when a user has none stored. */
export const DEFAULT_TIME_ZONE = 'UTC';

/**
 * "HH:mm" right now in `timezone`. Falls back to UTC for an unparseable zone.
 */
export const currentTimeInZone = (timezone?: string): string => {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || DEFAULT_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${hh}:${mm}`;
  } catch {
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
};

/** The hour (0–23) it currently is in `timezone`. */
export const localHour = (timezone?: string): number => {
  try {
    return parseInt(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone || DEFAULT_TIME_ZONE,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date()),
      10
    );
  } catch {
    return new Date().getUTCHours();
  }
};

/**
 * `YYYY-MM-DD` for `date` as seen from `timezone`.
 *
 * This is the unit of "a day" everywhere in the server — streak boundaries,
 * campaign cooldowns, notification idempotency keys. Never use
 * `setHours(0,0,0,0)` for day identity: that is midnight on the server's clock
 * (UTC in production), not the user's.
 */
export const dateKeyInZone = (date: Date, timezone?: string): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || DEFAULT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

/** Whether "HH:mm" `current` falls inside the (possibly overnight) window. */
export const isWithinWindow = (start: string, end: string, current: string): boolean =>
  start <= end ? current >= start && current < end : current >= start || current < end;
