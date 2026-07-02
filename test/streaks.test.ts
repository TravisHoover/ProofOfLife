import './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db';
import type { Post } from '../src/db';
import { processStreaksAtReveal, MAX_FREEZES } from '../src/streaks';

function post(userId: string, username: string, late = false): Post {
  return {
    id: 0,
    session_id: 0,
    user_id: userId,
    username,
    image_url: '',
    posted_at: '',
    is_late: late ? 1 : 0,
    caption: null,
    image_path: null,
    reveal_message_id: null,
    votes: 0,
  };
}

test('first on-time post starts a streak at 1', () => {
  processStreaksAtReveal('2026-07-01', [post('a', 'alice'), post('b', 'bob')]);
  assert.equal(db.getStreak('a')!.current_streak, 1);
  assert.equal(db.getStreak('b')!.current_streak, 1);
});

test('consecutive on-time day extends the streak; a missed day without a freeze resets it', () => {
  processStreaksAtReveal('2026-07-02', [post('a', 'alice')]);
  assert.equal(db.getStreak('a')!.current_streak, 2);
  assert.equal(db.getStreak('b')!.current_streak, 0);
});

test('a 7-day run earns a streak freeze', () => {
  for (let d = 3; d <= 7; d++) {
    processStreaksAtReveal(`2026-07-0${d}`, [post('a', 'alice')]);
  }
  assert.equal(db.getStreak('a')!.current_streak, 7);
  assert.equal(db.getStreak('a')!.freezes, 1);
});

test('a missed day consumes a freeze and keeps the streak', () => {
  const frozen = processStreaksAtReveal('2026-07-08', []);
  const row = db.getStreak('a')!;
  assert.equal(row.current_streak, 7);
  assert.equal(row.freezes, 0);
  assert.ok(frozen.includes('alice'));
});

test('the streak continues normally after a freeze save', () => {
  processStreaksAtReveal('2026-07-09', [post('a', 'alice')]);
  assert.equal(db.getStreak('a')!.current_streak, 8);
});

test('a late post without a freeze resets the streak but keeps the longest', () => {
  processStreaksAtReveal('2026-07-10', [post('a', 'alice', true)]);
  const row = db.getStreak('a')!;
  assert.equal(row.current_streak, 0);
  assert.equal(row.longest_streak, 8);
});

test('a late post with a freeze consumes it and keeps the streak', () => {
  for (let d = 11; d <= 17; d++) {
    processStreaksAtReveal(`2026-07-${d}`, [post('d', 'dave')]);
  }
  assert.equal(db.getStreak('d')!.freezes, 1);
  const frozen = processStreaksAtReveal('2026-07-18', [post('d', 'dave', true)]);
  const row = db.getStreak('d')!;
  assert.equal(row.current_streak, 7);
  assert.equal(row.freezes, 0);
  assert.ok(frozen.includes('dave'));
});

test('freezes are capped at MAX_FREEZES', () => {
  for (let d = 1; d <= 28; d++) {
    const date = `2026-08-${String(d).padStart(2, '0')}`;
    processStreaksAtReveal(date, [post('e', 'erin')]);
  }
  assert.equal(db.getStreak('e')!.current_streak, 28);
  assert.equal(db.getStreak('e')!.freezes, MAX_FREEZES);
});

test('vacation preserves the streak across missed days without spending freezes', () => {
  processStreaksAtReveal('2026-09-01', [post('c', 'carol')]);
  processStreaksAtReveal('2026-09-02', [post('c', 'carol')]);
  db.toggleVacation('c', 'carol');
  processStreaksAtReveal('2026-09-03', []);
  processStreaksAtReveal('2026-09-04', []);
  const row = db.getStreak('c')!;
  assert.equal(row.current_streak, 2);
  assert.equal(row.freezes, 0);
  processStreaksAtReveal('2026-09-05', [post('c', 'carol')]);
  assert.equal(db.getStreak('c')!.current_streak, 3);
});

test('reprocessing the same (latest) date is a no-op', () => {
  processStreaksAtReveal('2026-09-05', [post('c', 'carol')]);
  assert.equal(db.getStreak('c')!.current_streak, 3);
});
