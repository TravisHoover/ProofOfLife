import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitMilestone, STREAK_MILESTONES, POST_MILESTONES, WIN_MILESTONES } from '../src/milestones';

test('hitMilestone matches exact threshold values only', () => {
  assert.equal(hitMilestone(10, STREAK_MILESTONES), true);
  assert.equal(hitMilestone(30, STREAK_MILESTONES), true);
  assert.equal(hitMilestone(11, STREAK_MILESTONES), false);
  assert.equal(hitMilestone(0, STREAK_MILESTONES), false);
});

test('milestone lists are sorted ascending with no duplicates', () => {
  for (const list of [STREAK_MILESTONES, POST_MILESTONES, WIN_MILESTONES]) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    assert.deepEqual(list, sorted);
  }
});
