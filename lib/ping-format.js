function buildInactivePingLines(players) {
  return (Array.isArray(players) ? players : []).map((player) => {
    const username = player?.roblox_username ?? "Unknown";
    const discordIds = [...new Set(Array.isArray(player.discordIds) ? player.discordIds : [])].filter(Boolean);
    if (discordIds.length > 0) {
      return `${discordIds.map((id) => `<@${id}>`).join(" ")} ${username}`;
    }
    return `@${username}`;
  });
}

function buildInactivePingMessage(players, title = "Inactive players") {
  const lines = (Array.isArray(players) ? players : []).map((player) => {
    const mentionLine = buildInactivePingLines([player])[0];
    const label = player?.inactiveLabel ? ` (${player.inactiveLabel})` : "";
    return `${mentionLine}${label}`;
  });
  if (lines.length === 0) {
    return `${title}: none`;
  }
  return `${title}:\n${lines.join("\n")}`;
}

function buildAutoPingMessage({ inactivePlayers, title = "Inactive players" }) {
  return buildInactivePingMessage(inactivePlayers, title);
}

module.exports = {
  buildInactivePingLines,
  buildInactivePingMessage,
  buildAutoPingMessage,
};
