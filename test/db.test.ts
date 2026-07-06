import { testDataDir } from './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import Database from 'better-sqlite3';

// Build a database with the original v1 schema (pre-captions/voting/freezes)
// BEFORE the db module loads, to prove existing data migrates in place. The
// db module runs its migrations at import time, so it must be required lazily
// after this block.
const legacy = new Database(path.join(testDataDir, 'bereal.db'));
legacy.exec(`
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    ping_time TEXT NOT NULL,
    deadline TEXT NOT NULL,
    message_id TEXT,
    revealed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    image_url TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    is_late INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, user_id)
  );
  CREATE TABLE streaks (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    last_post_date TEXT
  );
  INSERT INTO streaks VALUES ('u1', 'alice', 5, 9, '2026-06-30');
`);
legacy.close();

const db = require('../src/db') as typeof import('../src/db');

test('a v1 database migrates in place and keeps existing rows', () => {
  const row = db.getStreak('u1')!;
  assert.equal(row.current_streak, 5);
  assert.equal(row.longest_streak, 9);
  assert.equal(row.last_post_date, '2026-06-30');
  // New columns exist with their defaults.
  assert.equal(row.freezes, 0);
  assert.equal(row.vacation, 0);
  assert.equal(row.wins, 0);
});

test('sessions round-trip through the new columns', () => {
  const id = db.createSession('2026-07-01', 'ping', 'deadline');
  const fresh = db.getSessionById(id)!;
  assert.equal(fresh.revealed, 0);
  assert.equal(fresh.reminder_sent, 0);
  assert.equal(fresh.voting_closed, 0);

  db.markReminderSent(id);
  db.markRevealed(id, '2026-07-01T20:00:00Z');
  db.markVotingClosed(id);
  const updated = db.getSessionById(id)!;
  assert.equal(updated.reminder_sent, 1);
  assert.equal(updated.revealed, 1);
  assert.equal(updated.revealed_at, '2026-07-01T20:00:00Z');
  assert.equal(updated.voting_closed, 1);
});

test('posts store captions and image paths, and duplicates are ignored', () => {
  const id = db.createSession('2026-07-02', 'ping', 'deadline');
  assert.equal(db.addPost(id, 'u1', 'alice', 'http://x', 't1', false, 'my caption', '/tmp/a.png'), true);
  assert.equal(db.addPost(id, 'u1', 'alice', 'http://x2', 't2', true, null, null), false);
  assert.equal(db.hasPosted(id, 'u1'), true);
  assert.equal(db.hasPosted(id, 'u2'), false);

  const posts = db.getPostsForSession(id);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].caption, 'my caption');
  assert.equal(posts[0].image_path, '/tmp/a.png');
  assert.equal(posts[0].votes, 0);

  db.setRevealMessageId(posts[0].id, 'msg123');
  db.setPostVotes(posts[0].id, 4);
  const updated = db.getPostsForSession(id)[0];
  assert.equal(updated.reveal_message_id, 'msg123');
  assert.equal(updated.votes, 4);

  assert.equal(db.getPost(id, 'u1')!.id, posts[0].id);
  assert.equal(db.getPost(id, 'nobody'), undefined);
});

test('getSessionsSince and getPostsForSessionIds cover the recap window', () => {
  const old = db.createSession('2026-06-20', 'ping', 'deadline');
  db.addPost(old, 'u1', 'alice', 'http://old', 't', false, null, null);
  const recent = db.getSessionsSince('2026-07-01');
  assert.deepEqual(recent.map((s) => s.date), ['2026-07-01', '2026-07-02']);

  const posts = db.getPostsForSessionIds(recent.map((s) => s.id));
  assert.equal(posts.length, 1);
  assert.equal(db.getPostsForSessionIds([]).length, 0);
});

test('toggleVacation flips state and creates a row for unseen users', () => {
  assert.equal(db.toggleVacation('u9', 'zoe'), true);
  assert.equal(db.getStreak('u9')!.vacation, 1);
  assert.equal(db.toggleVacation('u9', 'zoe'), false);
  assert.equal(db.getStreak('u9')!.vacation, 0);
});

test('addWin increments and getWinsLeaderboard only lists winners', () => {
  db.addWin('u1', 'alice');
  db.addWin('u1', 'alice');
  db.addWin('u9', 'zoe');
  const board = db.getWinsLeaderboard();
  assert.deepEqual(board.map((r) => [r.username, r.wins]), [['alice', 2], ['zoe', 1]]);
});
