require("dotenv").config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");
const { calculateInactiveMs, formatInactiveLabel } = require("./lib/inactivity");
const { buildInactivePingMessage } = require("./lib/ping-format");
const { createBloxlinkClient } = require("./lib/bloxlink");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const BLOXLINK_API_KEY = process.env.BLOXLINK_API_KEY;
const CLAN_NAME = "K0ii";
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
const BOT_STATE_PATH = `${DATA_DIR}/bot_state.json`;
const SNAPSHOT_PATH = `${DATA_DIR}/points_snapshot.json`;
const HISTORY_PATH = `${DATA_DIR}/clan_history.json`;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_PING_INTERVAL_MS = 60 * 60 * 1000;
const HISTORY_LIMIT = 12 * 24; // 24 hours at 5 minute intervals

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`Failed to load ${filePath}: ${error.message}`);
    return fallback;
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

let pointsSnapshot = {};
if (fs.existsSync(SNAPSHOT_PATH)) {
  pointsSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
}

function saveSnapshot() {
  saveJson(SNAPSHOT_PATH, pointsSnapshot);
}

let clanHistory = loadJson(HISTORY_PATH, []);
if (!Array.isArray(clanHistory)) {
  clanHistory = [];
}
if (pointsSnapshot?.timestamp && clanHistory.length === 0) {
  clanHistory.push(pointsSnapshot);
}
if (pointsSnapshot?.timestamp && clanHistory.length > 0) {
  const lastHistory = clanHistory[clanHistory.length - 1];
  const sameSnapshot = lastHistory
    && lastHistory.timestamp === pointsSnapshot.timestamp
    && lastHistory.battleID === pointsSnapshot.battleID;
  if (!sameSnapshot) {
    clanHistory.push(pointsSnapshot);
  }
}
if (clanHistory.length > HISTORY_LIMIT) {
  clanHistory = clanHistory.slice(-HISTORY_LIMIT);
}

function saveHistory() {
  saveJson(HISTORY_PATH, clanHistory);
}

let botState = loadJson(BOT_STATE_PATH, {});
if (!botState || typeof botState !== "object") {
  botState = {};
}

function saveBotState() {
  saveJson(BOT_STATE_PATH, botState);
}

function getCurrentBattleHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const latest = history[history.length - 1];
  const latestBattleId = latest?.battleID;
  if (!latestBattleId) return history.slice();

  let startIndex = history.length - 1;
  while (startIndex > 0 && history[startIndex - 1]?.battleID === latestBattleId) {
    startIndex -= 1;
  }

  return history.slice(startIndex);
}

async function fetchAllClanPoints() {
  const res = await fetch(`https://ps99.biggamesapi.io/api/clan/${CLAN_NAME}`);
  const data = await res.json();
  if (data.status !== "ok") return null;
  const battles = data.data?.Battles ?? {};
  const activeBattle = Object.values(battles).find((b) => b.ProcessedAwards === false);
  if (!activeBattle) return null;
  const clanMembers = data.data?.Members ?? [];
  const contributions = activeBattle.PointContributions ?? [];
  const memberIds = [...new Set(clanMembers.map((m) => String(m.UserID ?? "")).filter(Boolean))];
  const contributionMap = Object.fromEntries(contributions.map((entry) => [String(entry.UserID), Number(entry.Points) || 0]));

  const previousSnapshot = pointsSnapshot?.battleID === activeBattle.BattleID ? pointsSnapshot : null;
  const points = previousSnapshot?.points ? { ...previousSnapshot.points } : {};
  const [profileMap, avatarMap] = await Promise.all([
    fetchRobloxProfileMap(memberIds),
    fetchRobloxAvatarMap(memberIds),
  ]);

  const roster = await Promise.all(memberIds.map(async (id) => {
    const member = clanMembers.find((entry) => String(entry.UserID) === id) ?? {};
    if (contributionMap[id] !== undefined) {
      points[id] = contributionMap[id];
    } else if (points[id] === undefined) {
      points[id] = 0;
    }

    const profile = profileMap[id] ?? {
      roblox_id: id,
      roblox_username: `User ${id}`,
      displayName: `User ${id}`,
    };

    return {
      roblox_id: id,
      roblox_username: profile.roblox_username,
      displayName: profile.displayName,
      avatarUrl: avatarMap[id] ?? null,
      permissionLevel: Number(member.PermissionLevel) || 0,
      role: String(data.data?.Owner) === id ? "Owner" : Number(member.PermissionLevel) >= 90 ? "Officer" : "Member",
      timezone: null,
      region: null,
      discordId: null,
      battlePoints: Number(points[id] ?? 0),
    };
  }));

  return {
    timestamp: Date.now(),
    battleID: activeBattle.BattleID,
    battlePoints: Number(activeBattle.Points) || 0,
    memberCount: clanMembers.length,
    contributorCount: contributions.filter((entry) => Number(entry.Points) > 0).length,
    points,
    roster,
  };
}

function upsertHistory(snapshot) {
  if (!snapshot) return;
  pointsSnapshot = snapshot;
  saveSnapshot();
  clanHistory.push(snapshot);
  if (clanHistory.length > HISTORY_LIMIT) {
    clanHistory = clanHistory.slice(-HISTORY_LIMIT);
  }
  saveHistory();
  console.log(`[${new Date().toISOString()}] Snapshot saved for battle: ${snapshot.battleID}`);
}

async function fetchClanRankingWindow() {
  const pageSize = 1000;
  const maxPages = 20;
  const clanKey = CLAN_NAME.toLowerCase();

  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetch(`https://ps99.biggamesapi.io/api/clans?page=${page}&pageSize=${pageSize}&sort=Points&sortOrder=desc`);
    const data = await res.json();
    if (data.status !== "ok") return { rank: null, window: [] };
    const clans = data.data ?? [];
    const index = clans.findIndex((clan) => String(clan.Name ?? "").toLowerCase() === clanKey);
    if (index === -1) {
      if (clans.length < pageSize) break;
      continue;
    }

    const absoluteIndex = (page - 1) * pageSize + index;
    const window = [];
    for (let offset = -5; offset <= 5; offset += 1) {
      const cloneIndex = index + offset;
      if (cloneIndex < 0 || cloneIndex >= clans.length) continue;
      const clan = clans[cloneIndex];
      window.push({
        rank: absoluteIndex + offset + 1,
        name: clan.Name,
        points: Number(clan.Points) || 0,
        members: Number(clan.Members) || 0,
        countryCode: clan.CountryCode ?? null,
        icon: clan.Icon ?? null,
      });
    }

    return {
      rank: absoluteIndex + 1,
      window,
    };
  }

  return { rank: null, window: [] };
}

async function runSnapshot() {
  const snapshot = await fetchAllClanPoints();
  if (!snapshot) return;
  const ranking = await fetchClanRankingWindow().catch(() => ({ rank: null, window: [] }));
  snapshot.ranking = ranking;
  upsertHistory(snapshot);
}

function getLatestHistory() {
  return clanHistory[clanHistory.length - 1] ?? pointsSnapshot ?? null;
}

function pointsAtTimestamp(history, keyFn, timestamp) {
  let result = null;
  for (const snapshot of history) {
    if (snapshot.timestamp > timestamp) break;
    const value = keyFn(snapshot);
    if (value !== null && value !== undefined) {
      result = value;
    }
  }
  return result;
}

function extractClanPoints(snapshot, clanName) {
  const entry = snapshot?.ranking?.window?.find((item) => item.name === clanName);
  if (entry && Number.isFinite(Number(entry.points))) {
    return Number(entry.points);
  }
  if (String(clanName).toLowerCase() === CLAN_NAME.toLowerCase() && Number.isFinite(Number(snapshot?.battlePoints))) {
    return Number(snapshot.battlePoints);
  }
  return null;
}

function findSnapshotAtOrBefore(history, valueFn, targetTimestamp) {
  let result = null;
  for (const snapshot of history) {
    const value = valueFn(snapshot);
    if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
    const normalized = Number(value);
    if (snapshot.timestamp <= targetTimestamp) {
      result = { timestamp: snapshot.timestamp, value: normalized };
    } else {
      break;
    }
  }
  return result;
}

function sampleValueAt(history, valueFn, targetTimestamp) {
  if (!Array.isArray(history) || history.length === 0) return null;

  let previous = null;
  for (const snapshot of history) {
    const raw = valueFn(snapshot);
    if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) {
      continue;
    }

    const current = { timestamp: snapshot.timestamp, value: Number(raw) };

    if (current.timestamp === targetTimestamp) {
      return current;
    }

    if (current.timestamp > targetTimestamp) {
      if (!previous) {
        return current;
      }
      const span = current.timestamp - previous.timestamp;
      if (span <= 0) {
        return previous;
      }
      const ratio = (targetTimestamp - previous.timestamp) / span;
      return {
        timestamp: targetTimestamp,
        value: previous.value + (current.value - previous.value) * Math.min(1, Math.max(0, ratio)),
      };
    }

    previous = current;
  }

  return previous;
}

function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  return hourRemainder ? `${days}d ${hourRemainder}h` : `${days}d`;
}

function estimateRate(currentPoints, pastPoints, deltaMs) {
  if (currentPoints === null || pastPoints === null) return null;
  if (!deltaMs || deltaMs <= 0) return null;
  return (currentPoints - pastPoints) / (deltaMs / 3600000);
}

async function fetchRobloxAvatarMap(userIds) {
  const uniqueIds = [...new Set(userIds.map((id) => String(id)).filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${uniqueIds.join(",")}&size=150x150&format=Png&isCircular=true`
    );
    const data = await res.json();
    if (!Array.isArray(data?.data)) return {};

    return Object.fromEntries(
      data.data
        .map((entry) => [String(entry.targetId ?? entry.userId ?? ""), entry.imageUrl ?? null])
        .filter(([id]) => Boolean(id))
    );
  } catch (error) {
    console.warn(`Failed to fetch avatar map: ${error.message}`);
    return {};
  }
}

async function fetchRobloxProfileMap(userIds) {
  const uniqueIds = [...new Set(userIds.map((id) => String(id)).filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const entries = await Promise.all(uniqueIds.map(async (id) => {
    try {
      const res = await fetch(`https://users.roblox.com/v1/users/${id}`);
      if (!res.ok) return [id, null];
      const data = await res.json();
      return [id, {
        roblox_id: id,
        roblox_username: data.name ?? `User ${id}`,
        displayName: data.displayName ?? data.name ?? `User ${id}`,
      }];
    } catch (error) {
      console.warn(`Failed to fetch Roblox profile for ${id}: ${error.message}`);
      return [id, null];
    }
  }));

  return Object.fromEntries(entries.filter(([, value]) => value));
}

function extractAssetId(icon) {
  const match = String(icon ?? "").match(/(\d{5,})/);
  return match ? match[1] : null;
}

async function fetchRobloxAssetThumbnailMap(assetIds) {
  const uniqueIds = [...new Set(assetIds.map((id) => extractAssetId(id)).filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${uniqueIds.join(",")}&size=150x150&format=Png&isCircular=false`
    );
    const data = await res.json();
    if (!Array.isArray(data?.data)) return {};

    return Object.fromEntries(
      data.data
        .map((entry) => [String(entry.targetId ?? ""), entry.imageUrl ?? null])
        .filter(([id]) => Boolean(id))
    );
  } catch (error) {
    console.warn(`Failed to fetch clan asset thumbnails: ${error.message}`);
    return {};
  }
}

function calculateWindowDelta(history, memberId, windowMs) {
  const latest = history[history.length - 1] ?? null;
  if (!latest || !windowMs || windowMs <= 0) return null;

  const targetTimestamp = latest.timestamp - windowMs;
  const base = sampleValueAt(
    history,
    (snapshot) => {
      const value = Number(snapshot.points?.[memberId]);
      return Number.isFinite(value) ? value : null;
    },
    targetTimestamp
  );

  const current = Number(latest.points?.[memberId]);
  if (!base || !Number.isFinite(current)) return null;

  return {
    points: current - base.value,
    pace: estimateRate(current, base.value, latest.timestamp - base.timestamp),
    baseTimestamp: base.timestamp,
  };
}

function getInactiveInfo(history, memberId) {
  const inactiveMs = calculateInactiveMs(history, memberId, SNAPSHOT_INTERVAL_MS);
  return {
    inactiveMs,
    inactiveLabel: formatInactiveLabel(inactiveMs),
  };
}

function buildHistorySeries(history, key) {
  const series = [];
  let last = 0;
  for (const snapshot of history) {
    const value = snapshot[key];
    if (typeof value === "number") {
      last = value;
    }
    series.push({ timestamp: snapshot.timestamp, value: last });
  }
  return series;
}

function buildMemberSeries(history, memberId) {
  const series = [];
  let last = 0;
  for (const snapshot of history) {
    const value = Number(snapshot.points?.[memberId]);
    if (Number.isFinite(value)) {
      last = value;
    }
    series.push({ timestamp: snapshot.timestamp, value: last });
  }
  return series;
}

function buildClanPointsSeries(history, clanName) {
  const series = [];
  let last = 0;
  for (const snapshot of history) {
    const entry = snapshot.ranking?.window?.find((item) => item.name === clanName);
    if (entry && typeof entry.points === "number") {
      last = entry.points;
    } else if (snapshot.clanName === clanName && typeof snapshot.battlePoints === "number") {
      last = snapshot.battlePoints;
    }
    series.push({ timestamp: snapshot.timestamp, value: last });
  }
  return series;
}

function findClanPointsAt(history, clanName, targetTimestamp) {
  let result = null;
  for (const snapshot of history) {
    if (snapshot.timestamp > targetTimestamp) break;
    const points = extractClanPoints(snapshot, clanName);
    if (points !== null) {
      result = points;
    }
  }
  return result;
}

async function buildSitePayload() {
  const rawHistory = clanHistory.length > 0 ? clanHistory : (pointsSnapshot?.timestamp ? [pointsSnapshot] : []);
  const history = getCurrentBattleHistory(rawHistory);
  const latest = history[history.length - 1] ?? null;
  const prev5m = history.length > 1 ? history[history.length - 2] : null;
  const hourAgoTimestamp = latest ? latest.timestamp - 60 * 60 * 1000 : null;
  const comparisonWindow = latest?.ranking?.window ?? [];
  const currentIndex = comparisonWindow.findIndex((entry) => entry.name === CLAN_NAME);
  const above = currentIndex > 0 ? comparisonWindow[currentIndex - 1] : null;
  const below = currentIndex >= 0 && currentIndex < comparisonWindow.length - 1 ? comparisonWindow[currentIndex + 1] : null;
  const currentClanBase = latest && hourAgoTimestamp !== null
    ? sampleValueAt(history, (snapshot) => extractClanPoints(snapshot, CLAN_NAME), hourAgoTimestamp)
    : null;
  const currentClanEntry = comparisonWindow.find((entry) => entry.name === CLAN_NAME) ?? null;
  const currentClanPPH = latest && currentClanBase
    ? estimateRate(
      latest.battlePoints ?? 0,
      currentClanBase.value,
      latest.timestamp - currentClanBase.timestamp
      )
    : null;

  const enrichClan = (clan) => {
    if (!clan || !latest) return null;
    const currentClanPoints = findClanPointsAt(history, clan.name, latest.timestamp);
    const clanBase = hourAgoTimestamp !== null
      ? sampleValueAt(history, (snapshot) => extractClanPoints(snapshot, clan.name), hourAgoTimestamp)
      : null;
    const pph = estimateRate(
      currentClanPoints,
      clanBase?.value ?? null,
      clanBase ? latest.timestamp - clanBase.timestamp : 0
    );
    return {
      ...clan,
      pph,
    };
  };

  const currentPoints = Number(latest?.battlePoints ?? pointsSnapshot?.battlePoints ?? 0);
  const aboveClan = enrichClan(above);
  const belowClan = enrichClan(below);
  const ourPPH = currentClanPPH;
  const aboveGap = aboveClan ? Math.max(0, Number(aboveClan.points) - currentPoints + 1) : null;
  const belowGap = belowClan ? Math.max(0, currentPoints - Number(belowClan.points) + 1) : null;
  const aboveRelative = aboveClan && Number.isFinite(ourPPH) ? ourPPH - (aboveClan.pph ?? 0) : null;
  const belowRelative = belowClan && Number.isFinite(ourPPH) ? (belowClan.pph ?? 0) - ourPPH : null;
  const aboveEta = aboveGap !== null && aboveRelative && aboveRelative > 0 ? (aboveGap / aboveRelative) * 3600 : null;
  const belowEta = belowGap !== null && belowRelative && belowRelative > 0 ? (belowGap / belowRelative) * 3600 : null;
  const rosterMembers = Array.isArray(latest?.roster) ? latest.roster : [];
  const rosterIds = rosterMembers.map((member) => String(member.roblox_id)).filter(Boolean);
  const clanAssetMap = await fetchRobloxAssetThumbnailMap([
    currentClanEntry?.icon,
    above?.icon,
    below?.icon,
  ]);

  const clanLogoUrl = (icon) => {
    const assetId = extractAssetId(icon);
    return assetId ? clanAssetMap[assetId] ?? null : null;
  };

  const membersPayload = rosterMembers.map((member) => {
    const robloxId = String(member.roblox_id);
    const current = Number(latest?.points?.[robloxId] ?? member.battlePoints ?? 0);
    const previous = prev5m ? Number(prev5m.points?.[robloxId] ?? 0) : 0;
    const memberBase = hourAgoTimestamp !== null
      ? sampleValueAt(
        history,
        (snapshot) => {
          const value = Number(snapshot.points?.[robloxId]);
          return Number.isFinite(value) ? value : null;
        },
        hourAgoTimestamp
      )
      : null;
    const pph = latest && memberBase
      ? estimateRate(current, memberBase.value, latest.timestamp - memberBase.timestamp)
      : null;
    const avg24h = calculateWindowDelta(history, robloxId, 24 * 60 * 60 * 1000);
    const delta30m = calculateWindowDelta(history, robloxId, 30 * 60 * 1000);
    const delta60m = calculateWindowDelta(history, robloxId, 60 * 60 * 1000);
    const delta12h = calculateWindowDelta(history, robloxId, 12 * 60 * 60 * 1000);
    const delta24h = avg24h;
    const inactive = getInactiveInfo(history, robloxId);
    const ppd = pph === null ? null : pph * 24;
    const delta5m = current - previous;
    const series = buildMemberSeries(history, robloxId);
    return {
      discordId: null,
      roblox_id: robloxId,
      roblox_username: member.roblox_username ?? `User ${robloxId}`,
      displayName: member.displayName ?? `User ${robloxId}`,
      avatarUrl: member.avatarUrl ?? null,
      timezone: member.timezone ?? null,
      region: member.region ?? null,
      role: member.role ?? "Member",
      currentPoints: current,
      battlePoints: current,
      pph,
      ppd,
      avg24h: delta24h?.pace ?? null,
      delta5m,
      delta30m: delta30m?.points ?? null,
      delta60m: delta60m?.points ?? null,
      delta12h: delta12h?.points ?? null,
      delta24h: delta24h?.points ?? null,
      inactiveMs: inactive.inactiveMs,
      inactiveLabel: inactive.inactiveLabel,
      gaining: delta5m > 0,
      series,
      alts: [],
    };
  });

  membersPayload.sort((a, b) => (b.pph ?? -Infinity) - (a.pph ?? -Infinity) || b.currentPoints - a.currentPoints);

  const rankedMembers = membersPayload.map((member, index) => ({
    ...member,
    rank: index + 1,
    rankBucket: membersPayload.length > 0 ? Math.min(4, Math.floor((index / membersPayload.length) * 5)) : 0,
  }));

  return {
    status: "ok",
    clan: CLAN_NAME,
    generatedAt: latest?.timestamp ?? Date.now(),
    battle: {
      id: latest?.battleID ?? null,
      points: currentPoints,
      memberCount: latest?.memberCount ?? null,
      contributorCount: latest?.contributorCount ?? null,
      currentPPH: ourPPH,
      currentPPD: ourPPH === null ? null : ourPPH * 24,
      icon: currentClanEntry?.icon ?? null,
      logoUrl: clanLogoUrl(currentClanEntry?.icon),
    },
    comparison: {
      rank: latest?.ranking?.rank ?? null,
      above: aboveClan ? {
        ...aboveClan,
        pointsNeeded: aboveGap,
        relativePPH: aboveRelative,
        etaSeconds: aboveEta,
        logoUrl: clanLogoUrl(aboveClan.icon),
      } : null,
      below: belowClan ? {
        ...belowClan,
        pointsNeeded: belowGap,
        relativePPH: belowRelative,
        etaSeconds: belowEta,
        logoUrl: clanLogoUrl(belowClan.icon),
      } : null,
    },
    history: history.slice(-HISTORY_LIMIT).map((snapshot) => ({
      timestamp: snapshot.timestamp,
      battleID: snapshot.battleID,
      battlePoints: snapshot.battlePoints ?? 0,
      ranking: snapshot.ranking ?? null,
    })),
    members: rankedMembers,
    trackedMemberIds: rosterIds,
  };
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

function getAutoPingChannelIds() {
  return Array.isArray(botState.autoPingInactiveChannelIds) ? botState.autoPingInactiveChannelIds : [];
}

function setAutoPingChannel(channelId, enabled) {
  const channels = new Set(getAutoPingChannelIds());
  if (enabled) {
    channels.add(channelId);
  } else {
    channels.delete(channelId);
  }
  botState.autoPingInactiveChannelIds = [...channels];
  saveBotState();
}

function splitMessageChunks(text, maxLength = 1900) {
  const lines = String(text ?? "").split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength) {
      if (current) {
        chunks.push(current);
      }
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [""];
}

async function getInactivePlayersForPing() {
  const payload = await buildSitePayload();
  const inactivePlayers = (payload.members ?? [])
    .filter((member) => Number(member.inactiveMs) >= SNAPSHOT_INTERVAL_MS)
    .sort((a, b) => (b.inactiveMs ?? 0) - (a.inactiveMs ?? 0) || (b.currentPoints ?? 0) - (a.currentPoints ?? 0));

  const withDiscordMentions = await Promise.all(inactivePlayers.map(async (member) => {
    let discordIds = [];
    try {
      discordIds = await Bloxlink.lookupDiscordIds(member.roblox_id);
    } catch (error) {
      console.warn(`Bloxlink lookup failed for ${member.roblox_id}: ${error.message}`);
    }

    return {
      ...member,
      discordIds,
    };
  }));

  return withDiscordMentions;
}

async function sendInactivePing(channel, title) {
  const inactivePlayers = await getInactivePlayersForPing();
  const message = buildInactivePingMessage(inactivePlayers, title);
  const chunks = splitMessageChunks(message);
  for (const chunk of chunks) {
    await channel.send({ content: chunk });
  }
  return inactivePlayers;
}

async function runAutoPingInactiveReports() {
  const channelIds = getAutoPingChannelIds();
  if (channelIds.length === 0) return;

  for (const channelId of channelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== "function") continue;
    try {
      await sendInactivePing(channel, "Hourly inactive check");
    } catch (error) {
      console.warn(`Auto ping failed for channel ${channelId}: ${error.message}`);
    }
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("List the available bot commands and how to use them"),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("View a Discord user's Bloxlink-linked Roblox profile")
    .addUserOption((o) => o.setName("user").setDescription("Discord user to check").setRequired(true)),

  new SlashCommandBuilder()
    .setName("pinginactive")
    .setDescription("Ping clan members who have not gained points since the last snapshot"),

  new SlashCommandBuilder()
    .setName("autopinginactive")
    .setDescription("Enable or disable hourly inactive pings in this channel")
    .addStringOption((o) =>
      o.setName("enabled")
        .setDescription("Turn hourly inactive pings on or off")
        .setRequired(true)
        .addChoices(
          { name: "Yes", value: "yes" },
          { name: "No", value: "no" }
        )
    ),

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

const COMMAND_HELP = [
  { usage: "/help", description: "Show this command list." },
  { usage: "/check <user>", description: "Show a Discord user's Roblox and clan details through Bloxlink." },
  { usage: "/pinginactive", description: "Ping clan members who have not gained points since the last snapshot." },
  { usage: "/autopinginactive yes|no", description: "Toggle hourly inactive pings for this channel." },
  { usage: "/setzone <timezone>", description: "Set your timezone and assign the matching roles." },
];

const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  console.log("Registering slash commands...");
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("Commands registered.");
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  runSnapshot().catch((error) => console.error("Initial snapshot failed:", error));
  setInterval(() => {
    runSnapshot().catch((error) => console.error("Snapshot failed:", error));
  }, SNAPSHOT_INTERVAL_MS);
  setInterval(() => {
    runAutoPingInactiveReports().catch((error) => console.error("Auto inactive ping failed:", error));
  }, AUTO_PING_INTERVAL_MS);
});

const REQUIRED_ROLE = "K0ii Clan Member";
const ALLOWED_CHANNELS = ["🛠┃dev-tests", "🤖┃k0ii-bot"];

function hasClanRole(member) {
  return member.roles.cache.some((r) => r.name === REQUIRED_ROLE);
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === "help") {
    const embed = new EmbedBuilder()
      .setTitle("K0ii Bot Commands")
      .setDescription("Use these commands inside the clan bot channels.")
      .setColor(0xd97706)
      .addFields(
        COMMAND_HELP.map((entry) => ({
          name: entry.usage,
          value: entry.description,
          inline: false,
        }))
      )
      .setFooter({ text: "K0ii Clan Bot" });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

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

  if (commandName === "pinginactive") {
    await interaction.deferReply();
    const inactivePlayers = await getInactivePlayersForPing();
    if (inactivePlayers.length === 0) {
      return interaction.editReply({ content: "No inactive members found right now." });
    }

    const message = buildInactivePingMessage(inactivePlayers, `Inactive players (${inactivePlayers.length})`);
    const chunks = splitMessageChunks(message);
    await interaction.editReply({ content: chunks.shift() });
    for (const chunk of chunks) {
      await interaction.followUp({ content: chunk });
    }
    return;
  }

  if (commandName === "autopinginactive") {
    const enabledValue = interaction.options.getString("enabled");
    const enabled = enabledValue === "yes";
    setAutoPingChannel(interaction.channel.id, enabled);
    return interaction.reply({
      content: `Hourly inactive pings are now **${enabled ? "enabled" : "disabled"}** in <#${interaction.channel.id}>.`,
    });
  }

  if (commandName === "check") {
    await interaction.deferReply();
    const target = interaction.options.getUser("user");
    const robloxId = await Bloxlink.lookupRobloxId(target.id).catch((error) => {
      console.warn(`Bloxlink lookup failed for ${target.id}: ${error.message}`);
      return null;
    });

    if (!robloxId) {
      return interaction.editReply({ content: `**${target.username}** does not appear to have a Roblox account linked in Bloxlink.` });
    }

    const [profile, avatar, clanStats, ownedPasses] = await Promise.all([
      getRobloxProfile(robloxId),
      getRobloxAvatar(robloxId),
      getClanMemberStats(robloxId),
      getOwnedGamepasses(robloxId),
    ]);

    const displayName = profile.displayName !== profile.name
      ? `${profile.displayName} (@${profile.name})`
      : profile.name;

    const embed = new EmbedBuilder()
      .setTitle(displayName)
      .setURL(`https://www.roblox.com/users/${robloxId}/profile`)
      .setThumbnail(avatar)
      .addFields(
        { name: "Roblox Username", value: profile.name ?? `User ${robloxId}`, inline: true },
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

      const snapshotPoints = pointsSnapshot?.points?.[String(robloxId)];
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

    const row = members[target.id];
    if (row?.timezone) {
      const tz = TIMEZONES.find((t) => t.value === row.timezone);
      if (tz) embed.addFields({ name: "Timezone", value: `${tz.utc} (${tz.value})`, inline: true });
    }

    if (profile.description && profile.description.length > 0) {
      embed.setDescription(profile.description.slice(0, 200));
    }

    if (ownedPasses.length > 0) {
      embed.addFields({ name: "Gamepasses", value: ownedPasses.join(", "), inline: false });

    } else {
      embed.addFields({ name: "Gamepasses", value: "None", inline: false });
    }

    return interaction.editReply({ embeds: [embed] });
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

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

const WEBSITE_DIR = path.join(__dirname, "website");
if (fs.existsSync(WEBSITE_DIR)) {
  app.use(express.static(WEBSITE_DIR));
}
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/site", async (req, res) => {
  try {
    res.json(await buildSitePayload());
  } catch (error) {
    res.status(500).json({ status: "error", error: error.message });
  }
});

app.get("/api/members", async (req, res) => {
  try {
    const payload = await buildSitePayload();
    res.json({
      status: payload.status,
      clan: payload.clan,
      battle: payload.battle.id,
      generatedAt: payload.generatedAt,
      members: payload.members,
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
