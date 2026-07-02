import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'bereal.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    ping_time TEXT NOT NULL,
    deadline TEXT NOT NULL,
    message_id TEXT,
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

export interface Session {
  id: number;
  date: string;
  ping_time: string;
  deadline: string;
  message_id: string | null;
  revealed: number;
}

export interface Post {
  id: number;
  session_id: number;
  user_id: string;
  username: string;
  image_url: string;
  posted_at: string;
  is_late: number;
}

export interface Streak {
  user_id: string;
  username: string;
  current_streak: number;
  longest_streak: number;
  last_post_date: string | null;
}

export function createSession(date: string, pingTime: string, deadline: string): number {
  const stmt = db.prepare(`INSERT INTO sessions (date, ping_time, deadline) VALUES (?, ?, ?)`);
  const result = stmt.run(date, pingTime, deadline);
  return result.lastInsertRowid as number;
}

export function setSessionMessageId(sessionId: number, messageId: string): void {
  db.prepare(`UPDATE sessions SET message_id = ? WHERE id = ?`).run(messageId, sessionId);
}

export function getSessionByDate(date: string): Session | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE date = ?`).get(date) as Session | undefined;
}

export function getTodaySession(): Session | undefined {
  const today = new Date().toISOString().slice(0, 10);
  return getSessionByDate(today);
}

export function getLatestSession(): Session | undefined {
  return db.prepare(`SELECT * FROM sessions ORDER BY id DESC LIMIT 1`).get() as Session | undefined;
}

export function markRevealed(sessionId: number): void {
  db.prepare(`UPDATE sessions SET revealed = 1 WHERE id = ?`).run(sessionId);
}

export function addPost(
  sessionId: number,
  userId: string,
  username: string,
  imageUrl: string,
  postedAt: string,
  isLate: boolean,
): boolean {
  const stmt = db.prepare(`
    INSERT INTO posts (session_id, user_id, username, image_url, posted_at, is_late)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, user_id) DO NOTHING
  `);
  const result = stmt.run(sessionId, userId, username, imageUrl, postedAt, isLate ? 1 : 0);
  return result.changes > 0;
}

export function hasPosted(sessionId: number, userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM posts WHERE session_id = ? AND user_id = ?`).get(sessionId, userId);
}

export function getPostsForSession(sessionId: number): Post[] {
  return db.prepare(`SELECT * FROM posts WHERE session_id = ? ORDER BY posted_at ASC`).all(sessionId) as Post[];
}

export function updateStreak(userId: string, username: string, date: string, isLate: boolean): void {
  const row = db.prepare(`SELECT * FROM streaks WHERE user_id = ?`).get(userId) as Streak | undefined;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let current = 1;
  if (row && row.last_post_date === yesterday && !isLate) {
    current = row.current_streak + 1;
  } else if (isLate) {
    current = 0;
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

export function getLeaderboard(): Streak[] {
  return db.prepare(`SELECT * FROM streaks ORDER BY current_streak DESC, longest_streak DESC`).all() as Streak[];
}

