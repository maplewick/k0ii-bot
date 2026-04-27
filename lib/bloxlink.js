const DEFAULT_BASE_URL = "https://api.blox.link/v4";

function createBloxlinkClient({
  apiKey = process.env.BLOXLINK_API_KEY,
  guildId = process.env.GUILD_ID,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = global.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for Bloxlink lookup.");
  }

  async function request(path) {
    if (!apiKey) return [];
    const res = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        Authorization: apiKey,
      },
    });

    if (res.status === 404) return [];
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Bloxlink lookup failed: ${res.status} ${errorText}`.trim());
    }

    return res.json();
  }

  async function lookupDiscordIds(robloxId) {
    if (!guildId || !robloxId) return [];
    const data = await request(`/public/guilds/${guildId}/roblox-to-discord/${robloxId}`);
    return [...new Set(Array.isArray(data?.discordIDs) ? data.discordIDs.map(String) : [])];
  }

  async function lookupRobloxId(discordId) {
    if (!guildId || !discordId) return null;
    const data = await request(`/public/guilds/${guildId}/discord-to-roblox/${discordId}`);
    const robloxId = data?.robloxID ?? null;
    return robloxId ? String(robloxId) : null;
  }

  return {
    lookupDiscordIds,
    lookupRobloxId,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  createBloxlinkClient,
};
