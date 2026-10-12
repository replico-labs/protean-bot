export function short(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const STATE_EMOJI = {
  Pending: "⏳",
  Active: "🗳️",
  Succeeded: "✅",
  Queued: "⏱️",
  Defeated: "❌",
  Executed: "🏁",
  Cancelled: "🚫",
  Expired: "💀",
};

export function stateLine(stateLabel) {
  return `${STATE_EMOJI[stateLabel] ?? ""} ${stateLabel}`;
}

export function formatDate(unixSeconds) {
  if (!unixSeconds || Number(unixSeconds) === 0) return "—";
  return new Date(Number(unixSeconds) * 1000).toLocaleString();
}
