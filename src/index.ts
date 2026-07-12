import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  TextChannel,
  Guild,
  MessageFlags,
  REST,
  Routes,
} from 'discord.js';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import * as db from './db';
import type { Session, Post } from './db';
import { commands } from './commands';
import { tzNow as tzNowIn, dateStringDaysBefore, weekdayOf } from './time';
import { processStreaksAtReveal } from './streaks';
import { hitMilestone, STREAK_MILESTONES, POST_MILESTONES, WIN_MILESTONES } from './milestones';
import { buildCollage, pickCollagePhotos } from './collage';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  CHANNEL_ID,
  BEREAL_ROLE_ID,
  PING_WINDOW_START_HOUR = '11',
  PING_WINDOW_END_HOUR = '21',
  POST_TIME_LIMIT_MINUTES = '120',
  REMINDER_MINUTES_BEFORE = '15',
  VOTING_MINUTES,
  TIMEZONE = 'America/Chicago',
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');

const VOTE_EMOJI = '🔥';
// Photo-of-the-day voting is opt-in: it only runs when VOTING_MINUTES is set.
const votingMinutes = Number(VOTING_MINUTES) > 0 ? Number(VOTING_MINUTES) : 0;

// GuildMembers is a privileged intent, so only request it when a roster role is
// configured (it must also be enabled in the Discord Developer Portal).
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];
if (BEREAL_ROLE_ID) intents.push(GatewayIntentBits.GuildMembers);

const client = new Client({
  intents,
  partials: [Partials.Channel, Partials.Message],
});

let activeDeadlineTimeout: ReturnType<typeof setTimeout> | null = null;
let activeReminderTimeout: ReturnType<typeof setTimeout> | null = null;
let activeVotingTimeout: ReturnType<typeof setTimeout> | null = null;

function tzNow(): { date: string; hour: number; minute: number } {
  return tzNowIn(TIMEZONE);
}

function todayDateString(): string {
  return tzNow().date;
}

// --- Discord helpers -----------------------------------------------------

async function fetchChannel(): Promise<TextChannel | null> {
  try {
    return (await client.channels.fetch(CHANNEL_ID as string)) as TextChannel;
  } catch (err) {
    console.error('Could not fetch CHANNEL_ID channel:', err);
    return null;
  }
}

// Returns the user IDs expected to post today (non-bot members of the roster
// role, minus anyone on vacation), or null when no roster role is configured.
async function getActiveParticipantIds(guild: Guild): Promise<string[] | null> {
  if (!BEREAL_ROLE_ID) return null;
  await guild.members.fetch();
  const role = guild.roles.cache.get(BEREAL_ROLE_ID);
  if (!role) {
    console.warn(`BEREAL_ROLE_ID ${BEREAL_ROLE_ID} not found in guild ${guild.id}.`);
    return null;
  }
  const ids = [...role.members.filter((m) => !m.user.bot).keys()];
  return ids.filter((id) => !db.getStreak(id)?.vacation);
}

// --- Daily ping -----------------------------------------------------------

async function sendPing(): Promise<void> {
  const channel = await fetchChannel();
  if (!channel) return;

  const date = todayDateString();

  const existing = db.getSessionByDate(date);
  if (existing) {
    console.log(`Session for ${date} already exists, skipping ping.`);
    return;
  }

  const now = new Date();
  const deadline = new Date(now.getTime() + Number(POST_TIME_LIMIT_MINUTES) * 60000);

  const sessionId = db.createSession(date, now.toISOString(), deadline.toISOString());

  const embed = new EmbedBuilder()
    .setTitle('📸 Time to post your BeReal!')
    .setDescription(
      `Post a photo in this channel within **${POST_TIME_LIMIT_MINUTES} minutes** to be on time.\n` +
      `Just attach an image to a message right here — no command needed. Add text with your photo to caption it.\n\n` +
      `Posts stay hidden until everyone's in (or time runs out), then they all reveal at once.`
    )
    .setColor(0xfffb00)
    .setTimestamp();

  const mention = BEREAL_ROLE_ID ? `<@&${BEREAL_ROLE_ID}>` : '@everyone';
  const message = await channel.send({ content: mention, embeds: [embed] });
  db.setSessionMessageId(sessionId, message.id);

  console.log(`Ping sent for ${date}, deadline at ${deadline.toISOString()}`);

  const session = db.getSessionById(sessionId)!;
  scheduleDeadline(sessionId, channel, deadline);
  scheduleReminder(session, channel);
}

function scheduleDeadline(sessionId: number, channel: TextChannel, deadline: Date): void {
  const msUntilDeadline = deadline.getTime() - Date.now();
  if (activeDeadlineTimeout) clearTimeout(activeDeadlineTimeout);

  activeDeadlineTimeout = setTimeout(async () => {
    try {
      await revealSession(sessionId, channel);
    } catch (err) {
      console.error('Reveal failed:', err);
    }
  }, Math.max(msUntilDeadline, 0));
}

// --- Deadline reminder ----------------------------------------------------

function scheduleReminder(session: Session, channel: TextChannel): void {
  if (session.reminder_sent) return;
  const remindAt = new Date(session.deadline).getTime() - Number(REMINDER_MINUTES_BEFORE) * 60000;
  const ms = remindAt - Date.now();
  if (ms <= 0) return;

  if (activeReminderTimeout) clearTimeout(activeReminderTimeout);
  activeReminderTimeout = setTimeout(async () => {
    try {
      const fresh = db.getSessionById(session.id);
      if (!fresh || fresh.revealed || fresh.reminder_sent) return;

      const postedIds = new Set(db.getPostsForSession(session.id).map((p) => p.user_id));
      let mentions = '';
      if (channel.guild) {
        const participants = await getActiveParticipantIds(channel.guild);
        if (participants) {
          const missing = participants.filter((id) => !postedIds.has(id));
          if (missing.length === 0) return;
          mentions = ' ' + missing.map((id) => `<@${id}>`).join(' ');
        }
      }

      db.markReminderSent(session.id);
      await channel.send(
        `⏳ **${REMINDER_MINUTES_BEFORE} minutes left** to post your BeReal on time!${mentions}`
      );
    } catch (err) {
      console.error('Reminder failed:', err);
    }
  }, ms);
}

// --- Reveal ----------------------------------------------------------------

async function revealSession(sessionId: number, channel: TextChannel): Promise<void> {
  const session = db.getSessionById(sessionId);
  if (!session || session.revealed) return;

  if (activeDeadlineTimeout) clearTimeout(activeDeadlineTimeout);
  if (activeReminderTimeout) clearTimeout(activeReminderTimeout);

  const posts: Post[] = db.getPostsForSession(sessionId);
  db.markRevealed(sessionId, new Date().toISOString());

  const frozen = processStreaksAtReveal(session.date, posts);

  if (posts.length === 0) {
    db.markVotingClosed(sessionId);
    await channel.send("⏰ Time's up! Nobody posted today. Rough day for the group chat.");
    return;
  }

  const onTime = posts.filter((p) => !p.is_late);
  const late = posts.filter((p) => p.is_late);

  let description =
    `**On time (${onTime.length}):** ${onTime.map((p) => p.username).join(', ') || 'none'}\n` +
    `**Late (${late.length}):** ${late.map((p) => p.username).join(', ') || 'none'}`;
  if (frozen.length > 0) {
    description += `\n**🧊 Saved by a streak freeze:** ${frozen.join(', ')}`;
  }

  const summary = new EmbedBuilder()
    .setTitle("⏰ Today's BeReal Reveal")
    .setDescription(description)
    .setColor(0x00d166);

  await channel.send({ embeds: [summary] });

  for (const post of posts) {
    const tag = post.is_late ? ' (late)' : '';
    const caption = post.caption ? `\n> ${post.caption.slice(0, 1500)}` : '';
    const file = post.image_path && fs.existsSync(post.image_path) ? post.image_path : post.image_url;
    try {
      const msg = await channel.send({
        content: `**${post.username}${tag}**${caption}`,
        files: [file],
        // Captions are user text — never let them ping anyone.
        allowedMentions: { parse: [] },
      });
      db.setRevealMessageId(post.id, msg.id);
    } catch (err) {
      console.error(`Failed to post ${post.username}'s photo:`, err);
    }
  }

  const celebrations: string[] = [];
  for (const post of posts) {
    const streak = db.getStreak(post.user_id);
    if (streak && !post.is_late && hitMilestone(streak.current_streak, STREAK_MILESTONES)) {
      celebrations.push(`🔥 **${post.username}** hit a **${streak.current_streak}-day streak**!`);
    }
    const count = db.getPostCount(post.user_id);
    if (hitMilestone(count, POST_MILESTONES)) {
      celebrations.push(`📸 **${post.username}** just posted their **${count}th BeReal**!`);
    }
  }
  if (celebrations.length > 0) {
    await channel.send(`🎉 ${celebrations.join('\n')}`);
  }

  if (votingMinutes > 0 && posts.length >= 2) {
    const revealed = db.getPostsForSession(sessionId).filter((p) => p.reveal_message_id);
    for (const post of revealed) {
      try {
        const msg = await channel.messages.fetch(post.reveal_message_id!);
        await msg.react(VOTE_EMOJI);
      } catch (err) {
        console.error('Failed to add vote reaction:', err);
      }
    }
    await channel.send(
      `🗳️ Vote for the photo of the day by reacting ${VOTE_EMOJI} — voting closes in **${votingMinutes} minutes**!`
    );
    scheduleVotingClose(sessionId, channel, Date.now() + votingMinutes * 60000);
  } else {
    db.markVotingClosed(sessionId);
  }

  try {
    await maybeSendThrowback(channel, session.date);
  } catch (err) {
    console.error('Throwback failed:', err);
  }
}

// --- Throwback Thursday --------------------------------------------------------

// On Thursdays, resurface the photos from four weeks ago after the reveal.
async function maybeSendThrowback(channel: TextChannel, date: string): Promise<void> {
  if (weekdayOf(date) !== 4) return;

  const oldDate = dateStringDaysBefore(28, date);
  const oldSession = db.getSessionByDate(oldDate);
  if (!oldSession) return;

  const oldPosts = db
    .getPostsForSession(oldSession.id)
    .filter((p) => p.image_path && fs.existsSync(p.image_path));
  if (oldPosts.length === 0) return;

  await channel.send(`🕰️ **Throwback Thursday** — your BeReals from four weeks ago (${oldDate}):`);
  for (const post of oldPosts) {
    const caption = post.caption ? `\n> ${post.caption.slice(0, 1500)}` : '';
    try {
      await channel.send({
        content: `**${post.username}**${caption}`,
        files: [post.image_path!],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error(`Failed to post ${post.username}'s throwback:`, err);
    }
  }
}

// --- Photo-of-the-day voting -------------------------------------------------

function scheduleVotingClose(sessionId: number, channel: TextChannel, closeAtMs: number): void {
  if (activeVotingTimeout) clearTimeout(activeVotingTimeout);
  activeVotingTimeout = setTimeout(async () => {
    try {
      await closeVoting(sessionId, channel);
    } catch (err) {
      console.error('Closing the vote failed:', err);
    }
  }, Math.max(closeAtMs - Date.now(), 0));
}

async function closeVoting(sessionId: number, channel: TextChannel): Promise<void> {
  const session = db.getSessionById(sessionId);
  if (!session || session.voting_closed) return;
  db.markVotingClosed(sessionId);

  const posts = db.getPostsForSession(sessionId).filter((p) => p.reveal_message_id);
  const results: { post: Post; count: number }[] = [];

  for (const post of posts) {
    try {
      const msg = await channel.messages.fetch(post.reveal_message_id!);
      const reaction = msg.reactions.cache.get(VOTE_EMOJI);
      let count = 0;
      if (reaction) {
        const users = await reaction.users.fetch();
        count = users.filter((u) => !u.bot).size;
      }
      db.setPostVotes(post.id, count);
      results.push({ post, count });
    } catch (err) {
      console.error(`Could not count votes for ${post.username}:`, err);
    }
  }

  const max = Math.max(0, ...results.map((r) => r.count));
  if (max === 0) {
    await channel.send('🗳️ Voting closed — no votes today, so no photo of the day.');
    return;
  }

  const winners = results.filter((r) => r.count === max);
  for (const w of winners) db.addWin(w.post.user_id, w.post.username);
  const names = winners.map((w) => `**${w.post.username}**`).join(' & ');
  await channel.send(
    `🏆 Photo of the day goes to ${names} with ${max} vote${max === 1 ? '' : 's'}! See /wins for the leaderboard.`
  );

  for (const w of winners) {
    const wins = db.getStreak(w.post.user_id)?.wins ?? 0;
    if (hitMilestone(wins, WIN_MILESTONES)) {
      await channel.send(`🎉 That's **${w.post.username}**'s **${wins}th photo-of-the-day win**!`);
    }
  }
}

// --- Weekly recap -------------------------------------------------------------

async function sendWeeklyRecap(): Promise<void> {
  const channel = await fetchChannel();
  if (!channel) return;

  const since = dateStringDaysBefore(6, todayDateString());
  const sessions = db.getSessionsSince(since);
  if (sessions.length === 0) return;
  const posts = db.getPostsForSessionIds(sessions.map((s) => s.id));
  if (posts.length === 0) return;

  const stats = new Map<string, { username: string; onTime: number; late: number }>();
  for (const p of posts) {
    const s = stats.get(p.user_id) ?? { username: p.username, onTime: 0, late: 0 };
    if (p.is_late) s.late += 1;
    else s.onTime += 1;
    s.username = p.username;
    stats.set(p.user_id, s);
  }

  const perfect = [...stats.values()]
    .filter((s) => s.onTime === sessions.length)
    .map((s) => s.username);
  const mostLate = [...stats.values()].sort((a, b) => b.late - a.late)[0];
  const topStreak = db.getLeaderboard()[0];
  const topPost = [...posts].sort((a, b) => b.votes - a.votes)[0];

  const lines = [
    `**Days played:** ${sessions.length}`,
    `**Perfect week (on time every day):** ${perfect.join(', ') || 'nobody 😬'}`,
  ];
  if (mostLate && mostLate.late > 0) {
    lines.push(`**Fashionably late award:** ${mostLate.username} (${mostLate.late}× late)`);
  }
  if (topStreak && topStreak.current_streak > 0) {
    lines.push(`**Hottest streak:** ${topStreak.username} — 🔥 ${topStreak.current_streak}`);
  }

  const embed = new EmbedBuilder()
    .setTitle('📅 Weekly BeReal Recap')
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2)
    .setTimestamp();

  await channel.send({ embeds: [embed] });

  try {
    // Rank the week's photos by how many emoji reactions (any emoji, from
    // anyone but the bot) their reveal messages collected.
    const candidates: { path: string; score: number }[] = [];
    for (const post of posts) {
      if (!post.image_path || !fs.existsSync(post.image_path)) continue;
      let score = 0;
      if (post.reveal_message_id) {
        try {
          const msg = await channel.messages.fetch(post.reveal_message_id);
          score = msg.reactions.cache.reduce((sum, r) => sum + r.count - (r.me ? 1 : 0), 0);
        } catch {
          // Message gone or unreachable — keep the photo with a zero score.
        }
      }
      candidates.push({ path: post.image_path, score });
    }
    const imagePaths = pickCollagePhotos(candidates);
    const collagePath = path.join(db.photosDir, `collage-${sessions[sessions.length - 1].date}.jpg`);
    if (await buildCollage(imagePaths, collagePath)) {
      await channel.send({ content: '🖼️ **This week in BeReals:**', files: [collagePath] });
    }
  } catch (err) {
    console.error('Failed to build the weekly collage:', err);
  }

  if (topPost && topPost.votes > 0) {
    const file = topPost.image_path && fs.existsSync(topPost.image_path) ? topPost.image_path : topPost.image_url;
    try {
      await channel.send({
        content: `🖼️ **Photo of the week:** ${topPost.username} (${topPost.votes} vote${topPost.votes === 1 ? '' : 's'})`,
        files: [file],
      });
    } catch (err) {
      console.error('Failed to post photo of the week:', err);
    }
  }
}

// --- Scheduling -----------------------------------------------------------------

function scheduleNextRandomPing(): void {
  const startHour = Number(PING_WINDOW_START_HOUR);
  const endHour = Number(PING_WINDOW_END_HOUR);

  let scheduledHour: number;
  let scheduledMinute: number;
  let scheduledDate: string;

  function rollNewTime(): void {
    scheduledHour = startHour + Math.floor(Math.random() * (endHour - startHour));
    scheduledMinute = Math.floor(Math.random() * 60);
    scheduledDate = todayDateString();
    console.log(`Next ping rolled for ${scheduledDate} at ${scheduledHour}:${String(scheduledMinute).padStart(2, '0')} (${TIMEZONE})`);
  }

  rollNewTime();

  cron.schedule('* * * * *', async () => {
    const { date, hour, minute } = tzNow();

    if (date !== scheduledDate!) {
      rollNewTime();
    }

    if (hour === scheduledHour! && minute === scheduledMinute!) {
      await sendPing();
    }
  }, { timezone: TIMEZONE });
}

function scheduleWeeklyRecap(): void {
  // Sunday 8pm in the configured timezone.
  cron.schedule('0 20 * * 0', async () => {
    try {
      await sendWeeklyRecap();
    } catch (err) {
      console.error('Weekly recap failed:', err);
    }
  }, { timezone: TIMEZONE });
}

function cleanupOldPhotos(): void {
  // Keep photos long enough for Throwback Thursday (4 weeks back).
  const cutoff = Date.now() - 60 * 86400000;
  try {
    for (const name of fs.readdirSync(db.photosDir)) {
      const p = path.join(db.photosDir, name);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch (err) {
    console.error('Photo cleanup failed:', err);
  }
}

// --- Photo intake ------------------------------------------------------------------

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== CHANNEL_ID) return;
  if (message.attachments.size === 0) return;

  const session: Session | undefined = db.getSessionByDate(todayDateString());
  if (!session) return;

  const attachment = message.attachments.first();
  if (!attachment || !attachment.contentType?.startsWith('image/')) return;

  if (db.hasPosted(session.id, message.author.id)) {
    await message.react('✅');
    return;
  }

  const now = new Date();
  // Anything after the reveal is late by definition; before it, compare
  // against the deadline (they can differ when the reveal fires early).
  const isLate = session.revealed ? true : now > new Date(session.deadline);
  const caption = message.content.trim() || null;

  // Download the image so it can stay hidden (the original message gets
  // deleted, which kills its CDN link) and be re-uploaded at reveal time.
  let imagePath: string | null = null;
  try {
    const ext = EXT_BY_TYPE[attachment.contentType] ?? '.jpg';
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    imagePath = path.join(db.photosDir, `${session.id}-${message.author.id}${ext}`);
    fs.writeFileSync(imagePath, buf);
  } catch (err) {
    console.error('Photo download failed, will fall back to the CDN URL:', err);
    imagePath = null;
  }

  db.addPost(
    session.id,
    message.author.id,
    message.author.username,
    attachment.url,
    now.toISOString(),
    isLate,
    caption,
    imagePath,
  );

  const channel = message.channel as TextChannel;

  // After the reveal there's nothing to hide: repost the photo immediately,
  // flagged as late. Streaks were already settled at reveal time (a missed
  // day and a late post cost the same), so they're left untouched here.
  if (session.revealed) {
    let reposted = false;
    if (imagePath) {
      try {
        await message.delete();
        const capLine = caption ? `\n> ${caption.slice(0, 1500)}` : '';
        const msg = await channel.send({
          content: `**${message.author.username} (late)**${capLine}`,
          files: [imagePath],
          allowedMentions: { parse: [] },
        });
        const saved = db.getPost(session.id, message.author.id);
        if (saved) db.setRevealMessageId(saved.id, msg.id);
        if (votingMinutes > 0 && !session.voting_closed) {
          await msg.react(VOTE_EMOJI);
        }
        const count = db.getPostCount(message.author.id);
        if (hitMilestone(count, POST_MILESTONES)) {
          await channel.send(`🎉 📸 **${message.author.username}** just posted their **${count}th BeReal**!`);
        }
        reposted = true;
      } catch (err) {
        console.warn('Could not repost the late photo, leaving the original message:', err);
      }
    }
    if (!reposted) await message.react('🐢');
    return;
  }

  // Hide the photo until the reveal. Only delete if we have our own copy.
  let hidden = false;
  if (imagePath) {
    try {
      await message.delete();
      hidden = true;
    } catch (err) {
      console.warn('Could not delete the photo message — grant the bot Manage Messages to keep posts hidden:', err);
    }
  }

  if (hidden) {
    await channel.send(
      `📸 **${message.author.username}** just posted their BeReal${isLate ? ' (late)' : ''} — hidden until the reveal!`
    );
  } else {
    await message.react(isLate ? '🐢' : '📸');
  }

  // Early reveal: if everyone on the roster (minus vacationers) has posted,
  // don't make people wait out the timer.
  if (message.guild) {
    try {
      const participants = await getActiveParticipantIds(message.guild);
      if (participants && participants.length > 0) {
        const postedIds = new Set(db.getPostsForSession(session.id).map((p) => p.user_id));
        if (participants.every((id) => postedIds.has(id))) {
          await channel.send('🎉 Everyone posted — revealing early!');
          await revealSession(session.id, channel);
        }
      }
    } catch (err) {
      console.error('Early-reveal check failed:', err);
    }
  }
});

// --- Slash commands ------------------------------------------------------------------

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'bereal' || interaction.commandName === 'proofoflife') {
    await interaction.reply({ content: 'Triggering BeReal ping now...', flags: MessageFlags.Ephemeral });
    await sendPing();
  }

  if (interaction.commandName === 'status') {
    const session = db.getSessionByDate(todayDateString());
    if (!session) {
      await interaction.reply("No BeReal session today yet — it hasn't pinged.");
      return;
    }
    const posts = db.getPostsForSession(session.id);
    const names = posts.map((p) => `${p.username}${p.is_late ? ' (late)' : ''}`).join(', ') || 'nobody yet';
    const deadline = Math.floor(new Date(session.deadline).getTime() / 1000);
    const timing = session.revealed ? 'Revealed!' : `On-time deadline: <t:${deadline}:R>`;
    await interaction.reply(`Posted so far: ${names}\n${timing}`);
  }

  if (interaction.commandName === 'streaks') {
    const board = db.getLeaderboard();
    if (board.length === 0) {
      await interaction.reply('No streaks yet — post your first BeReal!');
      return;
    }
    const lines = board
      .slice(0, 10)
      .map((row, i) => {
        const extras = [
          row.freezes > 0 ? `🧊×${row.freezes}` : '',
          row.vacation ? '🏖️' : '',
        ].filter(Boolean).join(' ');
        return `${i + 1}. **${row.username}** — 🔥 ${row.current_streak} (best: ${row.longest_streak})${extras ? ` ${extras}` : ''}`;
      })
      .join('\n');
    await interaction.reply(`**Streak Leaderboard**\n${lines}`);
  }

  if (interaction.commandName === 'wins') {
    const board = db.getWinsLeaderboard();
    if (board.length === 0) {
      await interaction.reply(
        votingMinutes > 0
          ? 'No photo-of-the-day wins yet — vote with 🔥 after a reveal!'
          : 'Photo-of-the-day voting is turned off — set VOTING_MINUTES to enable it.'
      );
      return;
    }
    const lines = board
      .slice(0, 10)
      .map((row, i) => `${i + 1}. **${row.username}** — 🏆 ${row.wins}`)
      .join('\n');
    await interaction.reply(`**Photo of the Day Wins**\n${lines}`);
  }

  if (interaction.commandName === 'me') {
    const userId = interaction.user.id;
    const row = db.getStreak(userId);
    const history = db.getUserPostHistory(userId);
    if (!row && history.length === 0) {
      await interaction.reply({
        content: "No stats yet — post your first BeReal and come back!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const total = history.length;
    const onTime = history.filter((h) => !h.is_late).length;
    const pct = total > 0 ? Math.round((onTime / total) * 100) : 0;

    // This month at a glance: one symbol per day that had a session.
    const today = todayDateString();
    const month = today.slice(0, 7);
    const dayOfMonth = Number(today.slice(8, 10));
    const sessionDates = new Set(db.getSessionsSince(`${month}-01`).map((s) => s.date));
    const lateByDate = new Map(history.map((h) => [h.date, h.is_late]));
    let calendar = '';
    for (let d = 1; d <= dayOfMonth; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      if (!sessionDates.has(date)) calendar += '·';
      else if (!lateByDate.has(date)) calendar += '❌';
      else calendar += lateByDate.get(date) ? '🐢' : '✅';
    }

    const lines = [
      `🔥 **Streak:** ${row?.current_streak ?? 0} (best: ${row?.longest_streak ?? 0})`,
      `🧊 **Freezes banked:** ${row?.freezes ?? 0}`,
      `🏆 **Photo-of-the-day wins:** ${row?.wins ?? 0}`,
      `📸 **Posts:** ${total} total, ${pct}% on time`,
      `📅 **This month:** ${calendar || '—'}`,
    ];
    if (row?.vacation) lines.push('🏖️ Vacation mode is on');

    const embed = new EmbedBuilder()
      .setTitle(`${interaction.user.username}'s BeReal stats`)
      .setDescription(lines.join('\n'))
      .setColor(0xfffb00);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === 'vacation') {
    const on = db.toggleVacation(interaction.user.id, interaction.user.username);
    await interaction.reply({
      content: on
        ? "🏖️ Vacation mode is **on** — your streak is paused and you won't be pinged in reminders or counted for early reveals."
        : '🔥 Vacation mode is **off** — welcome back! Your streak picks up where it left off.',
      flags: MessageFlags.Ephemeral,
    });
  }
});

// --- Startup ------------------------------------------------------------------------

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN as string);
  const appId = client.application!.id;
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
    console.log(`Slash commands registered for guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('Slash commands registered globally (GUILD_ID not set — may take up to an hour to appear).');
  }
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user!.tag}`);

  registerCommands().catch((err) => console.error('Failed to register slash commands:', err));

  // Re-arm timers after a restart. Use the latest session (not strictly
  // today's) so a session left unrevealed across midnight still resolves.
  const session = db.getLatestSession();
  if (session) {
    fetchChannel().then((channel) => {
      if (!channel) return;
      if (!session.revealed) {
        scheduleDeadline(session.id, channel, new Date(session.deadline));
        scheduleReminder(session, channel);
      } else if (!session.voting_closed && votingMinutes > 0) {
        const revealedAt = session.revealed_at ? new Date(session.revealed_at).getTime() : Date.now();
        scheduleVotingClose(session.id, channel, revealedAt + votingMinutes * 60000);
      }
    });
  }

  cleanupOldPhotos();
  scheduleNextRandomPing();
  scheduleWeeklyRecap();
});

client.login(DISCORD_TOKEN);
