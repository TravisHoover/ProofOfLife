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
].map((c) => c.toJSON());
