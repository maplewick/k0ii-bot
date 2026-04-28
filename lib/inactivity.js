function calculateInactiveMs(history, memberId, snapshotIntervalMs) {
  if (!Array.isArray(history) || history.length < 2) return 0;

  let inactiveMs = 0;

  for (let index = history.length - 1; index > 0; index -= 1) {
    const currentSnapshot = history[index] || {};
    const previousSnapshot = history[index - 1] || {};
    const current = Number(currentSnapshot.points?.[memberId]);
    const previous = Number(previousSnapshot.points?.[memberId]);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;

    if (current > previous) {
      break;
    }

    const elapsed = Number(currentSnapshot.timestamp) - Number(previousSnapshot.timestamp);
    if (Number.isFinite(elapsed) && elapsed > 0) {
      inactiveMs += elapsed;
    } else if (Number.isFinite(snapshotIntervalMs) && snapshotIntervalMs > 0) {
      inactiveMs += snapshotIntervalMs;
    }
  }

  return inactiveMs;
}

function formatInactiveLabel(inactiveMs) {
  const totalMs = Number(inactiveMs);
  if (!Number.isFinite(totalMs) || totalMs <= 0) return "0s";

  const totalMinutes = Math.round(totalMs / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const rest = totalMinutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

module.exports = {
  calculateInactiveMs,
  formatInactiveLabel,
};
