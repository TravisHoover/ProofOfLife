import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// DATA_DIR overrides where the database and photos live (tests point it at a
// temp directory; deployments can point it at a mounted volume).
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const photosDir = path.join(dataDir, 'photos');
if (!fs.existsSync(photosDir)) {
  fs.mkdirSync(photosDir, { recursive: true });
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

  CREATE TABLE IF NOT EXISTS post_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    image_url TEXT NOT NULL,
    image_path TEXT,
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );
`);

// Additive migrations so existing databases (e.g. on a Railway volume) upgrade in place.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('sessions', 'reminder_sent', 'reminder_sent INTEGER NOT NULL DEFAULT 0');
ensureColumn('sessions', 'revealed_at', 'revealed_at TEXT');
ensureColumn('sessions', 'voting_closed', 'voting_closed INTEGER NOT NULL DEFAULT 0');
ensureColumn('posts', 'caption', 'caption TEXT');
ensureColumn('posts', 'image_path', 'image_path TEXT');
ensureColumn('posts', 'reveal_message_id', 'reveal_message_id TEXT');
ensureColumn('posts', 'votes', 'votes INTEGER NOT NULL DEFAULT 0');
ensureColumn('streaks', 'freezes', 'freezes INTEGER NOT NULL DEFAULT 0');
ensureColumn('streaks', 'vacation', 'vacation INTEGER NOT NULL DEFAULT 0');
ensureColumn('streaks', 'wins', 'wins INTEGER NOT NULL DEFAULT 0');

// Posts predating multi-image support only have their image on the posts row
// itself. Backfill a post_images row for any post that doesn't have one yet
// (idempotent — safe to run on every startup).
db.exec(`
  INSERT INTO post_images (post_id, position, image_url, image_path)
  SELECT id, 0, image_url, image_path FROM posts
  WHERE id NOT IN (SELECT post_id FROM post_images)
`);

export interface Session {
  id: number;
  date: string;
  ping_time: string;
  deadline: string;
  message_id: string | null;
  revealed: number;
  reminder_sent: number;
  revealed_at: string | null;
  voting_closed: number;
}

export interface Post {
  id: number;
  session_id: number;
  user_id: string;
  username: string;
  image_url: string;
  posted_at: string;
  is_late: number;
  caption: string | null;
  image_path: string | null;
  reveal_message_id: string | null;
  votes: number;
}

export interface PostImage {
  id: number;
  post_id: number;
  position: number;
  image_url: string;
  image_path: string | null;
}

export interface Streak {
  user_id: string;
  username: string;
  current_streak: number;
  longest_streak: number;
  last_post_date: string | null;
  freezes: number;
  vacation: number;
  wins: number;
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

export function getSessionById(id: number): Session | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Session | undefined;
}

export function getLatestSession(): Session | undefined {
  return db.prepare(`SELECT * FROM sessions ORDER BY id DESC LIMIT 1`).get() as Session | undefined;
}

export function getSessionsSince(date: string): Session[] {
  return db.prepare(`SELECT * FROM sessions WHERE date >= ? ORDER BY date ASC`).all(date) as Session[];
}

export function markRevealed(sessionId: number, revealedAt: string): void {
  db.prepare(`UPDATE sessions SET revealed = 1, revealed_at = ? WHERE id = ?`).run(revealedAt, sessionId);
}

export function markReminderSent(sessionId: number): void {
  db.prepare(`UPDATE sessions SET reminder_sent = 1 WHERE id = ?`).run(sessionId);
}

export function markVotingClosed(sessionId: number): void {
  db.prepare(`UPDATE sessions SET voting_closed = 1 WHERE id = ?`).run(sessionId);
}

// images must be non-empty; the first is stored on the posts row itself too
// (kept as a "primary" image for simple single-image consumers), and all of
// them are stored in post_images for consumers that need the full set.
// Returns the new post's id, or null if this user already posted this
// session (the UNIQUE(session_id, user_id) constraint rejected the insert).
export function addPost(
  sessionId: number,
  userId: string,
  username: string,
  images: { url: string; path: string | null }[],
  postedAt: string,
  isLate: boolean,
  caption: string | null,
): number | null {
  const primary = images[0];
  const stmt = db.prepare(`
    INSERT INTO posts (session_id, user_id, username, image_url, posted_at, is_late, caption, image_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, user_id) DO NOTHING
  `);
  const result = stmt.run(
    sessionId,
    userId,
    username,
    primary.url,
    postedAt,
    isLate ? 1 : 0,
    caption,
    primary.path,
  );
  if (result.changes === 0) return null;

  const postId = result.lastInsertRowid as number;
  const imgStmt = db.prepare(
    `INSERT INTO post_images (post_id, position, image_url, image_path) VALUES (?, ?, ?, ?)`,
  );
  images.forEach((img, i) => imgStmt.run(postId, i, img.url, img.path));
  return postId;
}

export function getImagesForPost(postId: number): PostImage[] {
  return db
    .prepare(`SELECT * FROM post_images WHERE post_id = ? ORDER BY position ASC`)
    .all(postId) as PostImage[];
}

export function getPostCount(userId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE user_id = ?`).get(userId) as { n: number };
  return row.n;
}

// Every post by a user with the session date it belongs to, oldest first.
export function getUserPostHistory(userId: string): { date: string; is_late: number }[] {
  return db
    .prepare(`
      SELECT s.date AS date, p.is_late AS is_late
      FROM posts p JOIN sessions s ON s.id = p.session_id
      WHERE p.user_id = ?
      ORDER BY s.date ASC
    `)
    .all(userId) as { date: string; is_late: number }[];
}

export function getPost(sessionId: number, userId: string): Post | undefined {
  return db
    .prepare(`SELECT * FROM posts WHERE session_id = ? AND user_id = ?`)
    .get(sessionId, userId) as Post | undefined;
}

export function hasPosted(sessionId: number, userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM posts WHERE session_id = ? AND user_id = ?`).get(sessionId, userId);
}

export function getPostsForSession(sessionId: number): Post[] {
  return db.prepare(`SELECT * FROM posts WHERE session_id = ? ORDER BY posted_at ASC`).all(sessionId) as Post[];
}

export function getPostsForSessionIds(sessionIds: number[]): Post[] {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM posts WHERE session_id IN (${placeholders}) ORDER BY posted_at ASC`)
    .all(...sessionIds) as Post[];
}

export function setRevealMessageId(postId: number, messageId: string): void {
  db.prepare(`UPDATE posts SET reveal_message_id = ? WHERE id = ?`).run(messageId, postId);
}

export function setPostVotes(postId: number, votes: number): void {
  db.prepare(`UPDATE posts SET votes = ? WHERE id = ?`).run(votes, postId);
}

export function getStreak(userId: string): Streak | undefined {
  return db.prepare(`SELECT * FROM streaks WHERE user_id = ?`).get(userId) as Streak | undefined;
}

export function getAllStreaks(): Streak[] {
  return db.prepare(`SELECT * FROM streaks`).all() as Streak[];
}

export function upsertStreak(row: Streak): void {
  db.prepare(`
    INSERT INTO streaks (user_id, username, current_streak, longest_streak, last_post_date, freezes, vacation, wins)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      current_streak = excluded.current_streak,
      longest_streak = excluded.longest_streak,
      last_post_date = excluded.last_post_date,
      freezes = excluded.freezes,
      vacation = excluded.vacation,
      wins = excluded.wins
  `).run(
    row.user_id,
    row.username,
    row.current_streak,
    row.longest_streak,
    row.last_post_date,
    row.freezes,
    row.vacation,
    row.wins,
  );
}

export function toggleVacation(userId: string, username: string): boolean {
  const row = getStreak(userId);
  const next = row ? (row.vacation ? 0 : 1) : 1;
  upsertStreak({
    user_id: userId,
    username,
    current_streak: row?.current_streak ?? 0,
    longest_streak: row?.longest_streak ?? 0,
    last_post_date: row?.last_post_date ?? null,
    freezes: row?.freezes ?? 0,
    vacation: next,
    wins: row?.wins ?? 0,
  });
  return next === 1;
}

export function addWin(userId: string, username: string): void {
  const row = getStreak(userId);
  upsertStreak({
    user_id: userId,
    username,
    current_streak: row?.current_streak ?? 0,
    longest_streak: row?.longest_streak ?? 0,
    last_post_date: row?.last_post_date ?? null,
    freezes: row?.freezes ?? 0,
    vacation: row?.vacation ?? 0,
    wins: (row?.wins ?? 0) + 1,
  });
}

export function getLeaderboard(): Streak[] {
  return db.prepare(`SELECT * FROM streaks ORDER BY current_streak DESC, longest_streak DESC`).all() as Streak[];
}

export function getWinsLeaderboard(): Streak[] {
  return db.prepare(`SELECT * FROM streaks WHERE wins > 0 ORDER BY wins DESC`).all() as Streak[];
}
