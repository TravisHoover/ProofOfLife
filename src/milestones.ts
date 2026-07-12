export const STREAK_MILESTONES = [10, 30, 50, 100, 200, 365];
export const POST_MILESTONES = [10, 50, 100, 250, 500, 1000];
export const WIN_MILESTONES = [5, 10, 25, 50, 100];

// Values only ever advance one step at a time (one post/win per day), so an
// exact match is enough to detect a crossing.
export function hitMilestone(value: number, milestones: number[]): boolean {
  return milestones.includes(value);
}
