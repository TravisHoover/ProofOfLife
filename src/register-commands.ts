import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID');
if (!GUILD_ID) throw new Error('Missing GUILD_ID');

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered successfully.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();
