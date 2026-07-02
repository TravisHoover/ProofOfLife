const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'bereal.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,         -- YYYY-MM-DD
    ping_time TEXT NOT NULL,           -- ISO timestamp the ping fired
    deadline TEXT NOT NULL,            -- ISO timestamp posts are due by
    message_id TEXT,                   -- the ping message, so we can reply/thread
    revealed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    image_url TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    is_late INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    UNIQUE(session_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS streaks (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    last_post_date TEXT
  );
`);

function createSession(date, pingTime, deadline) {
  const stmt = db.prepare(`INSERT INTO sessions (date, ping_time, deadline) VALUES (?, ?, ?)`);
  const result = stmt.run(date, pingTime, deadline);
  return result.lastInsertRowid;
}

function setSessionMessageId(sessionId, messageId) {
  db.prepare(`UPDATE sessions SET message_id = ? WHERE id = ?`).run(messageId, sessionId);
}

function getSessionByDate(date) {
  return db.prepare(`SELECT * FROM sessions WHERE date = ?`).get(date);
}

function getTodaySession() {
  const today = new Date().toISOString().slice(0, 10);
  return getSessionByDate(today);
}

function getLatestSession() {
  return db.prepare(`SELECT * FROM sessions ORDER BY id DESC LIMIT 1`).get();
}

function markRevealed(sessionId) {
  db.prepare(`UPDATE sessions SET revealed = 1 WHERE id = ?`).run(sessionId);
}

function addPost(sessionId, userId, username, imageUrl, postedAt, isLate) {
  const stmt = db.prepare(`
    INSERT INTO posts (session_id, user_id, username, image_url, posted_at, is_late)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, user_id) DO NOTHING
  `);
  const result = stmt.run(sessionId, userId, username, imageUrl, postedAt, isLate ? 1 : 0);
  return result.changes > 0;
}

function hasPosted(sessionId, userId) {
  return !!db.prepare(`SELECT 1 FROM posts WHERE session_id = ? AND user_id = ?`).get(sessionId, userId);
}

function getPostsForSession(sessionId) {
  return db.prepare(`SELECT * FROM posts WHERE session_id = ? ORDER BY posted_at ASC`).all(sessionId);
}

function updateStreak(userId, username, date, isLate) {
  const row = db.prepare(`SELECT * FROM streaks WHERE user_id = ?`).get(userId);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let current = 1;
  if (row && row.last_post_date === yesterday && !isLate) {
    current = row.current_streak + 1;
  } else if (isLate) {
    current = 0; // late posts break the streak, mirrors BeReal
  }

  const longest = row ? Math.max(row.longest_streak, current) : current;

  db.prepare(`
    INSERT INTO streaks (user_id, username, current_streak, longest_streak, last_post_date)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      current_streak = excluded.current_streak,
      longest_streak = excluded.longest_streak,
      last_post_date = excluded.last_post_date
  `).run(userId, username, current, longest, date);
}

function getLeaderboard() {
  return db.prepare(`SELECT * FROM streaks ORDER BY current_streak DESC, longest_streak DESC`).all();
}

module.exports = {
  createSession,
  setSessionMessageId,
  getSessionByDate,
  getTodaySession,
  getLatestSession,
  markRevealed,
  addPost,
  hasPosted,
  getPostsForSession,
  updateStreak,
  getLeaderboard,
};
