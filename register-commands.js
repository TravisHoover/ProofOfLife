require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('bereal')
    .setDescription("Manually trigger today's BeReal ping right now"),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription("See who's posted today and who hasn't"),
  new SlashCommandBuilder()
    .setName('streaks')
    .setDescription('Show the streak leaderboard'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered successfully.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();
