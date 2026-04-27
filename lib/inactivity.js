function calculateInactiveMs(history, memberId, snapshotIntervalMs) {
  if (!Array.isArray(history) || history.length < 2) return 0;

  let inactiveIntervals = 0;

  for (let index = history.length - 1; index > 0; index -= 1) {
    const current = Number(history[index].points?.[memberId]);
    const previous = Number(history[index - 1].points?.[memberId]);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;

    if (current > previous) {
      break;
    }

    inactiveIntervals += 1;
  }

  return inactiveIntervals * snapshotIntervalMs;
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
