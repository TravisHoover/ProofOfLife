import * as db from './db';
import type { Post } from './db';
import { dateStringDaysBefore } from './time';

export const MAX_FREEZES = 2;

// Streaks are settled once per day at reveal time: on-time posts extend them,
// late posts and missed days consume a freeze (earned every 7 days, capped)
// or reset the streak; vacation mode keeps it intact. Returns the names of
// users whose streak was saved by a freeze.
export function processStreaksAtReveal(date: string, posts: Post[]): string[] {
  const yesterday = dateStringDaysBefore(1, date);
  const frozen: string[] = [];
  const rows = new Map(db.getAllStreaks().map((r) => [r.user_id, r]));
  const postedIds = new Set(posts.map((p) => p.user_id));

  for (const p of posts) {
    const row = rows.get(p.user_id);
    if (row && row.last_post_date === date) continue;

    let freezes = row?.freezes ?? 0;
    let current: number;
    if (!p.is_late) {
      current = row && row.last_post_date === yesterday ? row.current_streak + 1 : 1;
      if (current % 7 === 0 && freezes < MAX_FREEZES) freezes += 1;
    } else if (freezes > 0) {
      freezes -= 1;
      current = row?.current_streak ?? 0;
      frozen.push(p.username);
    } else {
      current = 0;
    }

    db.upsertStreak({
      user_id: p.user_id,
      username: p.username,
      current_streak: current,
      longest_streak: Math.max(row?.longest_streak ?? 0, current),
      last_post_date: date,
      freezes,
      vacation: row?.vacation ?? 0,
      wins: row?.wins ?? 0,
    });
  }

  for (const row of rows.values()) {
    if (postedIds.has(row.user_id)) continue;
    if (row.current_streak <= 0 || row.last_post_date === date) continue;

    if (row.vacation) {
      // Keep the chain intact so the streak continues when they return.
      db.upsertStreak({ ...row, last_post_date: date });
    } else if (row.freezes > 0) {
      db.upsertStreak({ ...row, freezes: row.freezes - 1, last_post_date: date });
      frozen.push(row.username);
    } else {
      db.upsertStreak({ ...row, current_streak: 0 });
    }
  }

  return frozen;
}
