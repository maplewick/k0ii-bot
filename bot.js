require("dotenv").config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const BLOXLINK_API_KEY = process.env.BLOXLINK_API_KEY;
const CLAN_NAME = "K0ii";
const OFFICER_ROLES = ["Officer", "Owner"];

const { createBloxlinkClient } = require("./lib/bloxlink");
const { calculateInactiveMs, formatInactiveLabel } = require("./lib/inactivity");
const { buildInactivePingMessage } = require("./lib/ping-format");

const Bloxlink = createBloxlinkClient({ apiKey: BLOXLINK_API_KEY, guildId: GUILD_ID, fetchImpl: fetch });

const PS99_GAMEPASSES = [
  { id: 205379487,  name: "Lucky! 🍀"            },
  { id: 655859720,  name: "+15 Eggs! 🥚"          },
  { id: 257803774,  name: "Ultra Lucky! 🍀✨"      },
  { id: 265324265,  name: "Auto Tap! ☝️"           },
  { id: 690997523,  name: "Super Drops! ⭐"        },
  { id: 264808140,  name: "Huge Hunter! 🔥"        },
  { id: 258567677,  name: "Magic Eggs! ✨"         },
  { id: 975558264,  name: "Super Shiny Hunter!"    },
  { id: 651611000,  name: "Daycare Slots! 💖"      },
  { id: 265320491,  name: "Auto Farm! ♻️"          },
  { id: 259437976,  name: "+15 Pets! 🐾"           },
  { id: 257811346,  name: "VIP! ⭐"               },
  { id: 720275150,  name: "Double Stars! ⭐"      },
];

async function getOwnedGamepasses(robloxId) {
  const owned = [];
  await Promise.all(PS99_GAMEPASSES.map(async (gp) => {
    const res = await fetch(`https://inventory.roblox.com/v1/users/${robloxId}/items/GamePass/${gp.id}`);
    const data = await res.json();
    if (data.data && data.data.length > 0) owned.push(gp.name);
  }));
  return owned;
}
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || ".";
const DB_PATH = `${DATA_DIR}/clan.db.json`;
const SNAPSHOT_PATH = `${DATA_DIR}/points_snapshot.json`;
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_SNAPSHOT_HISTORY = 24;

let pointsSnapshot = {};
let snapshotHistory = [];
if (fs.existsSync(SNAPSHOT_PATH)) {
  const saved = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  if (Array.isArray(saved)) {
    snapshotHistory = saved;
    pointsSnapshot = saved[saved.length - 1] ?? {};
  } else {
    pointsSnapshot = saved;
    snapshotHistory = [saved];
  }
}

function saveSnapshot() {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshotHistory, null, 2));
}

async function fetchAllClanPoints() {
  const res = await fetch(`https://ps99.biggamesapi.io/api/clan/${CLAN_NAME}`);
  const data = await res.json();
  if (data.status !== "ok") return null;
  const battles = data.data?.Battles ?? {};
  const activeBattle = Object.values(battles).find((b) => b.ProcessedAwards === false);
  if (!activeBattle) return null;
  const contributions = activeBattle.PointContributions ?? [];
  const snapshot = { timestamp: Date.now(), battleID: activeBattle.BattleID, points: {} };
  for (const entry of contributions) {
    snapshot.points[String(entry.UserID)] = entry.Points;
  }
  return snapshot;
}

async function runHourlySnapshot() {
  const snapshot = await fetchAllClanPoints();
  if (!snapshot) return;
  if (snapshotHistory.length > 0 && snapshotHistory[0].battleID !== snapshot.battleID) {
    snapshotHistory = [];
  }
  snapshotHistory.push(snapshot);
  if (snapshotHistory.length > MAX_SNAPSHOT_HISTORY) snapshotHistory.shift();
  pointsSnapshot = snapshot;
  saveSnapshot();
  console.log(`[${new Date().toISOString()}] Snapshot saved for battle: ${snapshot.battleID}`);
}

let members = {};
if (fs.existsSync(DB_PATH)) {
  members = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(members, null, 2));
}

const TIMEZONES = [
  { label: "PST — UTC-8 (Pacific)",         value: "PST",  region: "NA",  utc: "UTC-8"   },
  { label: "MST — UTC-7 (Mountain)",         value: "MST",  region: "NA",  utc: "UTC-7"   },
  { label: "CST — UTC-6 (Central)",          value: "CST",  region: "NA",  utc: "UTC-6"   },
  { label: "EST — UTC-5 (Eastern)",          value: "EST",  region: "NA",  utc: "UTC-5"   },
  { label: "BRT — UTC-3 (Brazil)",           value: "BRT",  region: "SA",  utc: "UTC-3"   },
  { label: "GMT — UTC+0 (UK/Ireland)",       value: "GMT",  region: "EU",  utc: "UTC+0"   },
  { label: "CET — UTC+1 (Central Europe)",   value: "CET",  region: "EU",  utc: "UTC+1"   },
  { label: "EET — UTC+2 (Eastern Europe)",   value: "EET",  region: "EU",  utc: "UTC+2"   },
  { label: "MSK — UTC+3 (Moscow)",           value: "MSK",  region: "EU",  utc: "UTC+3"   },
  { label: "GST — UTC+4 (Gulf)",             value: "GST",  region: "ME",  utc: "UTC+4"   },
  { label: "IST — UTC+5:30 (India)",         value: "IST",  region: "AS",  utc: "UTC+5:30" },
  { label: "ICT — UTC+7 (SE Asia)",          value: "ICT",  region: "AS",  utc: "UTC+7"   },
  { label: "CST8 — UTC+8 (China/PH/SG)",    value: "CST8", region: "AS",  utc: "UTC+8"   },
  { label: "JST — UTC+9 (Japan/Korea)",      value: "JST",  region: "AS",  utc: "UTC+9"   },
  { label: "AEST — UTC+10 (Australia East)", value: "AEST", region: "OCE", utc: "UTC+10"  },
  { label: "NZST — UTC+12 (New Zealand)",    value: "NZST", region: "OCE", utc: "UTC+12"  },
];

const REGION_LABELS = {
  NA: "🌎 NA", SA: "🌎 SA", EU: "🌍 EU",
  ME: "🌍 ME", AS: "🌏 AS", OCE: "🌏 OCE",
};

async function getRobloxUser(username) {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;
  return data.data[0];
}

async function getRobloxAvatar(userId) {
  const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`);
  const data = await res.json();
  return data.data?.[0]?.imageUrl ?? null;
}

async function getRobloxProfile(userId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
  return await res.json();
}

async function getClanMemberStats(robloxId) {
  const res = await fetch(`https://ps99.biggamesapi.io/api/clan/${CLAN_NAME}`);
  const data = await res.json();
  if (data.status !== "ok") return null;
  const memberEntry = (data.data?.Members ?? []).find((m) => String(m.UserID) === String(robloxId));
  if (!memberEntry) return null;
  const isOwner = String(data.data?.Owner) === String(robloxId);
  const role = isOwner ? "Owner" : memberEntry.PermissionLevel >= 90 ? "Officer" : "Member";

  const battles = data.data?.Battles ?? {};
  const activeBattle = Object.values(battles).find((b) => b.ProcessedAwards === false);
  const contributions = activeBattle?.PointContributions ?? [];
  const sorted = [...contributions].sort((a, b) => b.Points - a.Points);
  const userIndex = sorted.findIndex((m) => String(m.UserID) === String(robloxId));
  const battlePoints = userIndex >= 0 ? sorted[userIndex].Points : 0;
  const placement = userIndex >= 0 ? `#${userIndex + 1} / ${sorted.length}` : null;
  const activeBattleName = activeBattle ? activeBattle.BattleID : null;

  return { Points: battlePoints, Role: role, BattleName: activeBattleName, Placement: placement };
}

async function getOrCreateRole(guild, name, color) {
  let role = guild.roles.cache.find((r) => r.name === name);
  if (!role) {
    role = await guild.roles.create({ name, color: color ?? null, reason: "Auto-created by clan bot" });
  }
  return role;
}

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Roblox account to your Discord profile")
    .addStringOption((o) => o.setName("username").setDescription("Your Roblox username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("View a clan member's linked Roblox profile")
    .addUserOption((o) => o.setName("user").setDescription("Discord user to check").setRequired(true)),

  new SlashCommandBuilder()
    .setName("linkalt")
    .setDescription("Link a Roblox alt account to your profile")
    .addStringOption((o) => o.setName("username").setDescription("Alt account Roblox username").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unlinkalt")
    .setDescription("Remove a Roblox alt account from your profile")
    .addStringOption((o) => o.setName("username").setDescription("Alt account Roblox username to remove").setRequired(true)),

  new SlashCommandBuilder()
    .setName("importmembers")
    .setDescription("Auto-link all clan members via Bloxlink (Officers only)"),

  new SlashCommandBuilder()
    .setName("inactive")
    .setDescription("Show inactive members based on point history (Officers only)")
    .addIntegerOption((o) => o.setName("hours").setDescription("Hours of inactivity threshold (default: 3)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("setzone")
    .setDescription("Set your timezone and get region roles")
    .addStringOption((o) =>
      o.setName("timezone")
        .setDescription("Select your timezone")
        .setRequired(true)
        .addChoices(...TIMEZONES.map((tz) => ({ name: tz.label, value: tz.value })))
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  console.log("Registering slash commands...");
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("Commands registered.");
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
  runHourlySnapshot();
  setInterval(runHourlySnapshot, SNAPSHOT_INTERVAL_MS);
});

const REQUIRED_ROLE = "K0ii Clan Member";

function isOfficer(member) {
  return member.roles.cache.some((r) => ["Officer", "Owner"].includes(r.name));
}
const ALLOWED_CHANNELS = ["🛠┃dev-tests", "🤖┃k0ii-bot"];

function hasClanRole(member) {
  return member.roles.cache.some((r) => r.name === REQUIRED_ROLE);
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (!hasClanRole(interaction.member)) {
    return interaction.reply({
      content: `You need the **${REQUIRED_ROLE}** role to use this bot.`,
      flags: 64,
    });
  }

  if (!ALLOWED_CHANNELS.includes(interaction.channel.name)) {
    const channelMentions = ALLOWED_CHANNELS
      .map(name => {
        const ch = interaction.guild.channels.cache.find(c => c.name === name);
        return ch ? `<#${ch.id}>` : `#${name}`;
      })
      .join(" or ");
    return interaction.reply({
      content: `This bot can only be used in ${channelMentions}.`,
      flags: 64,
    });
  }

  if (commandName === "link") {
    await interaction.deferReply({ ephemeral: true });
    const username = interaction.options.getString("username");
    const robloxUser = await getRobloxUser(username);

    if (!robloxUser) {
      return interaction.editReply({ content: `Could not find a Roblox account with the username **${username}**. Double-check the spelling and try again.` });
    }

    const existingOwner = Object.entries(members).find(
      ([id, m]) => String(m.roblox_id) === String(robloxUser.id) && id !== interaction.user.id
    );

    if (existingOwner) {
      return interaction.editReply({ content: `**${robloxUser.name}** is already linked to another Discord account.` });
    }

    members[interaction.user.id] = {
      ...members[interaction.user.id],
      roblox_id: String(robloxUser.id),
      roblox_username: robloxUser.name,
    };
    saveDb();

    return interaction.editReply({ content: `Your Discord account is now linked to the Roblox account **${robloxUser.name}**.` });
  }

  if (commandName === "check") {
    await interaction.deferReply();
    const target = interaction.options.getUser("user");
    const row = members[target.id];

    if (!row) {
      return interaction.editReply({ content: `**${target.username}** hasn't linked their Roblox account yet. They can do so with \`/link\`.` });
    }

    const [profile, avatar, clanStats, ownedPasses] = await Promise.all([
      getRobloxProfile(row.roblox_id),
      getRobloxAvatar(row.roblox_id),
      getClanMemberStats(row.roblox_id),
      getOwnedGamepasses(row.roblox_id),
    ]);

    const displayName = profile.displayName !== row.roblox_username
      ? `${profile.displayName} (@${row.roblox_username})`
      : row.roblox_username;

    const embed = new EmbedBuilder()
      .setTitle(displayName)
      .setURL(`https://www.roblox.com/users/${row.roblox_id}/profile`)
      .setThumbnail(avatar)
      .addFields(
        { name: "Roblox Username", value: row.roblox_username, inline: true },
        { name: "Discord", value: `<@${target.id}>`, inline: true }
      )
      .setColor(0x5865f2)
      .setFooter({ text: "Clan Member Profile • K0ii" });

    if (clanStats) {
      const battleLabel = clanStats.BattleName ? `Battle Points (${clanStats.BattleName})` : "Battle Points";
      embed.addFields(
        { name: battleLabel, value: clanStats.Points.toLocaleString(), inline: true },
        { name: "Clan Role", value: clanStats.Role, inline: true },
        { name: "Clan Placement", value: clanStats.Placement ?? "Not contributing", inline: true }
      );

      const snapshotPoints = pointsSnapshot?.points?.[String(row.roblox_id)];
      const snapshotBattle = pointsSnapshot?.battleID;
      if (snapshotPoints !== undefined && snapshotBattle === clanStats.BattleName) {
        const gain = clanStats.Points - snapshotPoints;
        const gainStr = gain >= 0 ? `+${gain.toLocaleString()}` : gain.toLocaleString();
        const snapshotAge = pointsSnapshot.timestamp
          ? Math.round((Date.now() - pointsSnapshot.timestamp) / 60000)
          : null;
        const ageLabel = snapshotAge !== null ? ` (last ${snapshotAge}m ago)` : "";
        embed.addFields({ name: `Pts Gained${ageLabel}`, value: gainStr, inline: true });
      }
    } else {
      embed.addFields({ name: "Clan Stats", value: "Not found in K0ii roster", inline: false });
    }

    if (row.timezone) {
      const tz = TIMEZONES.find((t) => t.value === row.timezone);
      if (tz) embed.addFields({ name: "Timezone", value: `${tz.utc} (${tz.value})`, inline: true });
    }

    if (profile.description && profile.description.length > 0) {
      embed.setDescription(profile.description.slice(0, 200));
    }

    const alts = row.alts ?? [];
    if (alts.length > 0) {
      embed.addFields({ name: "Alt Accounts", value: alts.map((a) => a.roblox_username).join(", "), inline: false });
    }

    if (ownedPasses.length > 0) {
      embed.addFields({ name: "Gamepasses", value: ownedPasses.join(", "), inline: false });

    } else {
      embed.addFields({ name: "Gamepasses", value: "None", inline: false });
    }

    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === "linkalt") {
    await interaction.deferReply({ ephemeral: true });
    const username = interaction.options.getString("username");
    const robloxUser = await getRobloxUser(username);

    if (!robloxUser) {
      return interaction.editReply({ content: `Could not find a Roblox account with the username **${username}**.` });
    }

    const userId = interaction.user.id;
    const alts = members[userId]?.alts ?? [];

    if (alts.some((a) => String(a.roblox_id) === String(robloxUser.id))) {
      return interaction.editReply({ content: `**${robloxUser.name}** is already linked as an alt.` });
    }

    if (members[userId]?.roblox_id === String(robloxUser.id)) {
      return interaction.editReply({ content: `**${robloxUser.name}** is already your main linked account.` });
    }

    alts.push({ roblox_id: String(robloxUser.id), roblox_username: robloxUser.name });
    members[userId] = { ...members[userId], alts };
    saveDb();

    return interaction.editReply({ content: `Alt account **${robloxUser.name}** has been linked to your profile.` });
  }

  if (commandName === "unlinkalt") {
    await interaction.deferReply({ ephemeral: true });
    const username = interaction.options.getString("username").toLowerCase();
    const userId = interaction.user.id;
    const alts = members[userId]?.alts ?? [];
    const newAlts = alts.filter((a) => a.roblox_username.toLowerCase() !== username);

    if (newAlts.length === alts.length) {
      return interaction.editReply({ content: `No alt account with username **${username}** found on your profile.` });
    }

    members[userId] = { ...members[userId], alts: newAlts };
    saveDb();
    return interaction.editReply({ content: `Alt account **${username}** has been removed from your profile.` });
  }

  if (commandName === "importmembers") {
    if (!isOfficer(interaction.member)) {
      return interaction.reply({ content: "You need the Officer role to use this command.", flags: 64 });
    }
    await interaction.deferReply({ ephemeral: true });

    if (!BLOXLINK_API_KEY) {
      return interaction.editReply({ content: "Bloxlink API key is not configured." });
    }

    const guild = interaction.guild;
    await guild.members.fetch();
    const clanRole = guild.roles.cache.find((r) => r.name === REQUIRED_ROLE);
    if (!clanRole) return interaction.editReply({ content: `Could not find the "${REQUIRED_ROLE}" role.` });

    const eligibleMembers = guild.members.cache.filter((m) => m.roles.cache.has(clanRole.id) && !m.user.bot);
    let imported = 0, skipped = 0, failed = 0;

    for (const [discordId, member] of eligibleMembers) {
      if (members[discordId]?.roblox_id) { skipped++; continue; }
      try {
        const robloxId = await Bloxlink.lookupRobloxId(discordId);
        if (!robloxId) { failed++; continue; }
        const robloxUser = await fetch(`https://users.roblox.com/v1/users/${robloxId}`).then(r => r.json());
        if (!robloxUser?.name) { failed++; continue; }
        members[discordId] = { ...members[discordId], roblox_id: robloxId, roblox_username: robloxUser.name };
        imported++;
      } catch { failed++; }
    }

    saveDb();
    return interaction.editReply({
      content: `Import complete.
✅ Imported: **${imported}**
⏭️ Already linked: **${skipped}**
❌ Failed: **${failed}**`
    });
  }

  if (commandName === "inactive") {
    if (!isOfficer(interaction.member)) {
      return interaction.reply({ content: "You need the Officer role to use this command.", flags: 64 });
    }
    await interaction.deferReply({ ephemeral: true });

    const hours = interaction.options.getInteger("hours") ?? 3;
    const thresholdMs = hours * 60 * 60 * 1000;

    if (snapshotHistory.length < 2) {
      return interaction.editReply({ content: "Not enough snapshot history yet. Try again after a few hours." });
    }

    const inactivePlayers = [];
    for (const [discordId, m] of Object.entries(members)) {
      if (!m.roblox_id) continue;
      const inactiveMs = calculateInactiveMs(snapshotHistory, String(m.roblox_id), SNAPSHOT_INTERVAL_MS);
      if (inactiveMs >= thresholdMs) {
        const discordIds = await Bloxlink.lookupDiscordIds(m.roblox_id).catch(() => [discordId]);
        inactivePlayers.push({
          roblox_username: m.roblox_username,
          discordIds: discordIds.length > 0 ? discordIds : [discordId],
          inactiveLabel: formatInactiveLabel(inactiveMs),
        });
      }
    }

    const message = buildInactivePingMessage(inactivePlayers, `Members inactive for ${hours}h+`);
    return interaction.editReply({ content: message.slice(0, 2000) });
  }

  if (commandName === "setzone") {
    await interaction.deferReply({ ephemeral: true });
    const tzValue = interaction.options.getString("timezone");
    const tz = TIMEZONES.find((t) => t.value === tzValue);
    if (!tz) return interaction.editReply({ content: "Invalid timezone selection." });

    const guild = interaction.guild;
    const member = interaction.member;

    const allTimezoneRoleNames = TIMEZONES.map((t) => `🕐 ${t.value}`);
    const allRegionRoleNames = Object.values(REGION_LABELS);

    for (const roleName of allTimezoneRoleNames) {
      const existing = guild.roles.cache.find((r) => r.name === roleName);
      if (existing && member.roles.cache.has(existing.id)) await member.roles.remove(existing);
    }
    for (const roleName of allRegionRoleNames) {
      const existing = guild.roles.cache.find((r) => r.name === roleName);
      if (existing && member.roles.cache.has(existing.id)) await member.roles.remove(existing);
    }

    const tzRole = await getOrCreateRole(guild, `🕐 ${tz.value}`, 0x5865f2);
    const regionRole = await getOrCreateRole(guild, REGION_LABELS[tz.region], 0x57f287);

    await member.roles.add(tzRole);
    await member.roles.add(regionRole);

    members[interaction.user.id] = {
      ...members[interaction.user.id],
      timezone: tz.value,
      region: tz.region,
    };
    saveDb();

    return interaction.editReply({
      content: `Your timezone has been set to **${tz.utc} (${tz.value})**.\nRoles assigned: **${tzRole.name}** and **${regionRole.name}**.`,
    });
  }
});

client.login(TOKEN);

// ── Express API ──────────────────────────────────────────────────────────────
const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/members", async (req, res) => {
  try {
    const clanRes = await fetch(`https://ps99.biggamesapi.io/api/clan/${CLAN_NAME}`);
    const clanData = await clanRes.json();
    const battles = clanData.data?.Battles ?? {};
    const activeBattle = Object.values(battles).find((b) => b.ProcessedAwards === false);
    const contributions = activeBattle?.PointContributions ?? [];
    const clanMembers = clanData.data?.Members ?? [];

    const result = await Promise.all(
      Object.entries(members)
        .filter(([, m]) => m.roblox_id)
        .map(async ([discordId, m]) => {
          const sortedContribs = [...contributions].sort((a, b) => b.Points - a.Points);
          const battleIndex = sortedContribs.findIndex((c) => String(c.UserID) === String(m.roblox_id));
          const battleEntry = battleIndex >= 0 ? sortedContribs[battleIndex] : null;
          const clanEntry = clanMembers.find((c) => String(c.UserID) === String(m.roblox_id));
          const isOwner = String(clanData.data?.Owner) === String(m.roblox_id);
          const role = clanEntry
            ? isOwner ? "Owner"
            : clanEntry.PermissionLevel >= 90 ? "Officer" : "Member"
            : "Member";
          const snapshotPts = pointsSnapshot?.points?.[String(m.roblox_id)];
          const currentPts = battleEntry?.Points ?? 0;
          const gain = snapshotPts !== undefined ? currentPts - snapshotPts : null;
          const placement = battleIndex >= 0 ? `#${battleIndex + 1} / ${sortedContribs.length}` : null;
          const avatar = await getRobloxAvatar(m.roblox_id).catch(() => null);
          return {
            discordId,
            roblox_id: m.roblox_id,
            roblox_username: m.roblox_username,
            alts: m.alts ?? [],
            timezone: m.timezone ?? null,
            region: m.region ?? null,
            role,
            battlePoints: currentPts,
            battleName: activeBattle?.BattleID ?? null,
            hourlyGain: gain,
            placement,
            avatar,
          };
        })
    );

    result.sort((a, b) => b.battlePoints - a.battlePoints);
    res.json({ status: "ok", clan: CLAN_NAME, battle: activeBattle?.BattleID ?? null, members: result });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
