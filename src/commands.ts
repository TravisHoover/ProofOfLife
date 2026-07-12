import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('bereal')
    .setDescription("Manually trigger today's BeReal ping right now"),
  new SlashCommandBuilder()
    .setName('proofoflife')
    .setDescription("Manually trigger today's BeReal ping right now"),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription("See who's posted today and who hasn't"),
  new SlashCommandBuilder()
    .setName('streaks')
    .setDescription('Show the streak leaderboard'),
  new SlashCommandBuilder()
    .setName('wins')
    .setDescription('Show the photo-of-the-day win leaderboard'),
  new SlashCommandBuilder()
    .setName('vacation')
    .setDescription('Toggle vacation mode — pauses your streak while you are away'),
  new SlashCommandBuilder()
    .setName('me')
    .setDescription('Your personal BeReal stats: streak, wins, on-time rate, and this month at a glance'),
].map((c) => c.toJSON());
