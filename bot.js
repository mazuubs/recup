require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const TOKEN                   = process.env.DISCORD_TOKEN;
const GUILD_ID                = process.env.GUILD_ID;
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID;
const VANITY                  = 'paradisia';
const CHECK_INTERVAL_MS       = parseInt(process.env.CHECK_INTERVAL_MS || '500', 10);
const CLAIM_BURST             = parseInt(process.env.CLAIM_BURST || '5', 10);
const REQUEST_TIMEOUT_MS      = 2500;

if (!TOKEN || !GUILD_ID || !NOTIFICATION_CHANNEL_ID) {
  console.error('[ERREUR] Variables manquantes dans .env : DISCORD_TOKEN, GUILD_ID, NOTIFICATION_CHANNEL_ID');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let firing      = false;
let checkLoop   = null;
let checkCount  = 0;
let lastCheckAt = null;
let startedAt   = new Date();
let missionDone = false;

const DISCORD_API = 'https://discord.com/api/v10';
const BOT_HEADERS = {
  Authorization:  `Bot ${TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent':   'DiscordBot (vanity-sniper, 2.0.0)',
};

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function uptimeString() {
  const ms = Date.now() - startedAt.getTime();
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  const s  = Math.floor((ms % 60000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('statut')
      .setDescription('Affiche le statut du bot de surveillance vanity')
      .toJSON(),
  ];
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    log('Commande /statut enregistrée.');
  } catch (err) {
    log(`Erreur enregistrement commande : ${err.message}`);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'statut') return;

  const lastCheckStr = lastCheckAt
    ? `<t:${Math.floor(lastCheckAt.getTime() / 1000)}:R>`
    : 'Pas encore effectuée';

  let statusLine;
  if (missionDone) {
    statusLine = '✅ Mission accomplie — `discord.gg/paradisia` réclamé !';
  } else if (firing) {
    statusLine = '🚀 Tentative de réclamation en cours...';
  } else {
    statusLine = '🔍 Surveillance active — vanity toujours pris';
  }

  const embed = new EmbedBuilder()
    .setTitle('📡 Statut du bot Paradisia Vanity Watcher')
    .setColor(missionDone ? 0x57f287 : 0x5865f2)
    .addFields(
      { name: '🤖 État',             value: statusLine,                             inline: false },
      { name: '🔢 Vérifications',    value: `**${checkCount.toLocaleString()}** effectuées`, inline: true },
      { name: '🕐 Dernière vérif.', value: lastCheckStr,                            inline: true },
      { name: '⏱ Uptime',           value: uptimeString(),                          inline: true },
      { name: '🎯 Vanity surveillé', value: `\`discord.gg/${VANITY}\``,             inline: true },
      { name: '⚡ Intervalle',       value: `${CHECK_INTERVAL_MS}ms`,               inline: true },
      { name: '💥 Rafale claim',     value: `${CLAIM_BURST} requêtes simultanées`,  inline: true },
    )
    .setFooter({ text: `Démarré le ${startedAt.toLocaleString('fr-FR')}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
});

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkVanity() {
  const res = await fetchWithTimeout(`${DISCORD_API}/invites/${VANITY}`, { headers: BOT_HEADERS });
  if (res.status === 200) return false;
  if (res.status === 404) return true;
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get('retry-after') || '1');
    log(`⏳ Rate limit — pause ${retryAfter}s`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return null;
  }
  return null;
}

async function claimVanity() {
  const res = await fetchWithTimeout(`${DISCORD_API}/guilds/${GUILD_ID}/vanity-url`, {
    method:  'PATCH',
    headers: BOT_HEADERS,
    body:    JSON.stringify({ code: VANITY }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function fireBurst() {
  log(`🚀 VANITY LIBRE — Envoi de ${CLAIM_BURST} requêtes simultanées...`);
  const start   = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CLAIM_BURST }, () => claimVanity())
  );
  log(`⚡ Rafale terminée en ${Date.now() - start}ms`);

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.status === 200) return { success: true };
  }

  const errors = results.map(r =>
    r.status === 'rejected'
      ? r.reason?.message || 'Erreur inconnue'
      : `HTTP ${r.value.status} — ${JSON.stringify(r.value.body)}`
  );
  return { success: false, errors };
}

async function sendNotification(message) {
  try {
    const channel = await client.channels.fetch(NOTIFICATION_CHANNEL_ID);
    if (channel?.isTextBased()) await channel.send(message);
  } catch (err) {
    log(`Impossible d'envoyer la notification : ${err.message}`);
  }
}

async function tick() {
  if (firing || missionDone) return;

  checkCount++;
  lastCheckAt = new Date();

  let available;
  try {
    available = await checkVanity();
  } catch {
    return;
  }

  if (available === null || available === false) {
    if (checkCount % 100 === 0) {
      log(`⏱  ${checkCount} vérifications — "${VANITY}" toujours pris`);
    }
    return;
  }

  firing = true;
  if (checkLoop) { clearInterval(checkLoop); checkLoop = null; }

  log(`🎯 DÉTECTION à la vérification #${checkCount} — lancement de la rafale !`);

  const result = await fireBurst();

  if (result.success) {
    missionDone = true;
    log(`✅ discord.gg/${VANITY} appartient maintenant à votre serveur !`);
    await sendNotification(
      `✅ **Succès !** \`discord.gg/${VANITY}\` a été récupéré après **${checkCount.toLocaleString()} vérifications** !`
    );
    log('Bot en veille — mission accomplie. Tapez /statut pour confirmer.');
  } else {
    log(`❌ Toutes les tentatives ont échoué : ${result.errors.join(' | ')}`);
    await sendNotification(
      `❌ **Échec** : \`discord.gg/${VANITY}\` était disponible mais n'a pas pu être réclamé.\n` +
      `Détails : \`\`\`${result.errors.slice(0, 2).join('\n')}\`\`\`\n` +
      `Vérifiez que le bot a la permission **Gérer le serveur** et que votre serveur a le Boost niveau 3.`
    );
    process.exit(1);
  }
}

client.once('ready', async () => {
  log(`✔  Bot connecté : ${client.user.tag}`);
  log(`🔍 Surveillance de "discord.gg/${VANITY}" toutes les ${CHECK_INTERVAL_MS}ms`);
  log(`⚡ Rafale de ${CLAIM_BURST} requêtes simultanées à la détection`);
  log(`🎯 Serveur cible : ${GUILD_ID}`);

  await registerCommands();

  tick();
  checkLoop = setInterval(tick, CHECK_INTERVAL_MS);
});

client.on('error', err => log(`Erreur client : ${err.message}`));
process.on('unhandledRejection', err => log(`Rejet non géré : ${err?.message || err}`));

client.login(TOKEN).catch(err => {
  log(`Connexion impossible : ${err.message}`);
  process.exit(1);
});
