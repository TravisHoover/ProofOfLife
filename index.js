require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');
const cron = require('node-cron');
const db = require('./db');

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  PING_WINDOW_START_HOUR = 11,
  PING_WINDOW_END_HOUR = 21,
  POST_TIME_LIMIT_MINUTES = 120,
  TIMEZONE = 'America/Chicago',
} = process.env;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Tracks the currently active session's deadline timer so we can cancel/reschedule if needed
let activeDeadlineTimeout = null;

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function sendPing() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) {
    console.error('Could not find CHANNEL_ID channel.');
    return;
  }

  const date = todayDateString();

  // Don't double-ping if a session already exists for today (e.g. bot restarted)
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
      `Just attach an image to a message right here — no command needed.\n\n` +
      `Posts will stay hidden until everyone's in (or time runs out).`
    )
    .setColor(0xfffb00)
    .setTimestamp();

  const message = await channel.send({ content: '@everyone', embeds: [embed] });
  db.setSessionMessageId(sessionId, message.id);

  console.log(`Ping sent for ${date}, deadline at ${deadline.toISOString()}`);

  scheduleDeadline(sessionId, channel, deadline);
}

function scheduleDeadline(sessionId, channel, deadline) {
  const msUntilDeadline = deadline.getTime() - Date.now();
  if (activeDeadlineTimeout) clearTimeout(activeDeadlineTimeout);

  activeDeadlineTimeout = setTimeout(async () => {
    await revealSession(sessionId, channel);
  }, Math.max(msUntilDeadline, 0));
}

async function revealSession(sessionId, channel) {
  const posts = db.getPostsForSession(sessionId);
  db.markRevealed(sessionId);

  if (posts.length === 0) {
    await channel.send("⏰ Time's up! Nobody posted today. Rough day for the group chat.");
    return;
  }

  const onTime = posts.filter((p) => !p.is_late);
  const late = posts.filter((p) => p.is_late);

  const summary = new EmbedBuilder()
    .setTitle("⏰ Today's BeReal Reveal")
    .setDescription(
      `**On time (${onTime.length}):** ${onTime.map((p) => p.username).join(', ') || 'none'}\n` +
      `**Late (${late.length}):** ${late.map((p) => p.username).join(', ') || 'none'}`
    )
    .setColor(0x00d166);

  await channel.send({ embeds: [summary] });

  for (const post of posts) {
    const tag = post.is_late ? ' (late)' : '';
    await channel.send({
      content: `**${post.username}${tag}**`,
      files: [post.image_url],
    });
  }
}

function scheduleNextRandomPing() {
  // Runs once a minute, checks if "now" matches today's randomly chosen ping time
  const startHour = Number(PING_WINDOW_START_HOUR);
  const endHour = Number(PING_WINDOW_END_HOUR);

  let scheduledHour = null;
  let scheduledMinute = null;
  let scheduledDate = null;

  function rollNewTime() {
    scheduledHour = startHour + Math.floor(Math.random() * (endHour - startHour));
    scheduledMinute = Math.floor(Math.random() * 60);
    scheduledDate = todayDateString();
    console.log(`Next ping rolled for ${scheduledDate} at ${scheduledHour}:${String(scheduledMinute).padStart(2, '0')} (${TIMEZONE})`);
  }

  rollNewTime();

  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const currentDate = todayDateString();

    // New day -> roll a new random time
    if (currentDate !== scheduledDate) {
      rollNewTime();
    }

    if (now.getHours() === scheduledHour && now.getMinutes() === scheduledMinute) {
      await sendPing();
    }
  }, { timezone: TIMEZONE });
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== CHANNEL_ID) return;
  if (message.attachments.size === 0) return;

  const session = db.getTodaySession();
  if (!session || session.revealed) return; // no active session, or already revealed

  const attachment = message.attachments.first();
  if (!attachment.contentType || !attachment.contentType.startsWith('image/')) return;

  if (db.hasPosted(session.id, message.author.id)) {
    await message.react('✅'); // already counted, just acknowledge
    return;
  }

  const now = new Date();
  const deadline = new Date(session.deadline);
  const isLate = now > deadline;

  db.addPost(session.id, message.author.id, message.author.username, attachment.url, now.toISOString(), isLate);
  db.updateStreak(message.author.id, message.author.username, todayDateString(), isLate);

  await message.react(isLate ? '🐢' : '📸');

  // If everyone who's ever posted before has posted today, you could auto-reveal early.
  // Kept simple here: reveal happens at the deadline via scheduleDeadline.
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'bereal' || interaction.commandName === 'proofoflife') {
    await interaction.reply({ content: 'Triggering BeReal ping now...', ephemeral: true });
    await sendPing();
  }

  if (interaction.commandName === 'status') {
    const session = db.getTodaySession();
    if (!session) {
      await interaction.reply("No BeReal session today yet — it hasn't pinged.");
      return;
    }
    const posts = db.getPostsForSession(session.id);
    const names = posts.map((p) => `${p.username}${p.is_late ? ' (late)' : ''}`).join(', ') || 'nobody yet';
    await interaction.reply(`Posted so far: ${names}`);
  }

  if (interaction.commandName === 'streaks') {
    const board = db.getLeaderboard();
    if (board.length === 0) {
      await interaction.reply('No streaks yet — post your first BeReal!');
      return;
    }
    const lines = board
      .slice(0, 10)
      .map((row, i) => `${i + 1}. **${row.username}** — 🔥 ${row.current_streak} (best: ${row.longest_streak})`)
      .join('\n');
    await interaction.reply(`**Streak Leaderboard**\n${lines}`);
  }
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  // On startup, if today's session exists but hasn't been revealed, re-arm its deadline timer
  const session = db.getTodaySession();
  if (session && !session.revealed) {
    client.channels.fetch(CHANNEL_ID).then((channel) => {
      scheduleDeadline(session.id, channel, new Date(session.deadline));
    });
  }

  scheduleNextRandomPing();
});

client.login(DISCORD_TOKEN);
