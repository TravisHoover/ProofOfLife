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
  INSERT INTO sessions (date, ping_time, deadline) VALUES ('2026-06-30', 'p', 'd');
  INSERT INTO posts (session_id, user_id, username, image_url, posted_at, is_late)
    VALUES (1, 'u1', 'alice', 'http://legacy', 't', 0);
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

test('a pre-multi-image post is backfilled into post_images', () => {
  const post = db.getPost(1, 'u1')!;
  assert.equal(post.image_url, 'http://legacy');
  const images = db.getImagesForPost(post.id);
  assert.equal(images.length, 1);
  assert.equal(images[0].image_url, 'http://legacy');
  assert.equal(images[0].position, 0);
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
  const postId = db.addPost(id, 'u1', 'alice', [{ url: 'http://x', path: '/tmp/a.png' }], 't1', false, 'my caption');
  assert.notEqual(postId, null);
  assert.equal(db.addPost(id, 'u1', 'alice', [{ url: 'http://x2', path: null }], 't2', true, null), null);
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

test('addPost stores every image in order and getImagesForPost returns them all', () => {
  const id = db.createSession('2026-05-01', 'ping', 'deadline');
  const postId = db.addPost(
    id,
    'u2',
    'bob',
    [
      { url: 'http://a', path: '/tmp/a.png' },
      { url: 'http://b', path: null },
      { url: 'http://c', path: '/tmp/c.png' },
    ],
    't1',
    false,
    null,
  )!;

  const images = db.getImagesForPost(postId);
  assert.equal(images.length, 3);
  assert.deepEqual(images.map((i) => i.image_url), ['http://a', 'http://b', 'http://c']);
  assert.deepEqual(images.map((i) => i.image_path), ['/tmp/a.png', null, '/tmp/c.png']);
  assert.deepEqual(images.map((i) => i.position), [0, 1, 2]);

  // The posts row itself carries the first image as the "primary" one.
  const post = db.getPost(id, 'u2')!;
  assert.equal(post.image_url, 'http://a');
  assert.equal(post.image_path, '/tmp/a.png');

  assert.equal(db.getImagesForPost(-1).length, 0);
});

test('getSessionsSince and getPostsForSessionIds cover the recap window', () => {
  const old = db.createSession('2026-06-20', 'ping', 'deadline');
  db.addPost(old, 'u1', 'alice', [{ url: 'http://old', path: null }], 't', false, null);
  const recent = db.getSessionsSince('2026-07-01');
  assert.deepEqual(recent.map((s) => s.date), ['2026-07-01', '2026-07-02']);

  const posts = db.getPostsForSessionIds(recent.map((s) => s.id));
  assert.equal(posts.length, 1);
  assert.equal(db.getPostsForSessionIds([]).length, 0);
});

test('getPostCount and getUserPostHistory report per-user activity', () => {
  // u1 posted in the legacy-backfill 2026-06-30 session, the 2026-06-20
  // session, and the 2026-07-02 session.
  assert.equal(db.getPostCount('u1'), 3);
  assert.equal(db.getPostCount('ghost'), 0);

  const history = db.getUserPostHistory('u1');
  assert.deepEqual(history.map((h) => h.date), ['2026-06-20', '2026-06-30', '2026-07-02']);
  assert.equal(db.getUserPostHistory('ghost').length, 0);
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
