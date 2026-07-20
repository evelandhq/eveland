export function formatBytes(value: number | null): string {
  if (value === null) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatCapacityTimelineTick(observedAt: string, hours: number): string {
  const date = new Date(observedAt);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
  if (hours !== 168) return time;

  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
  return `${day} ${time}`;
}

export function capacityTimelineScale(
  observedAt: string[],
  hours: number,
): { domain: [number, number]; ticks: number[] } | null {
  const timestamps = observedAt
    .map(Date.parse)
    .filter((timestamp) => Number.isFinite(timestamp));
  if (timestamps.length === 0) return null;

  const halfHourMs = 30 * 60 * 1000;
  const intervalMs = hours === 168 ? 24 * halfHourMs : halfHourMs;
  const domainStart = Math.floor(Math.min(...timestamps) / intervalMs) * intervalMs;
  let domainEnd = Math.ceil(Math.max(...timestamps) / intervalMs) * intervalMs;
  if (domainEnd === domainStart) domainEnd += intervalMs;

  const ticks: number[] = [];
  for (let timestamp = domainStart; timestamp <= domainEnd; timestamp += intervalMs) {
    ticks.push(timestamp);
  }
  return { domain: [domainStart, domainEnd], ticks };
}

export function formatCapacityTooltipTimestamp(observedAt: string): string {
  const iso = new Date(observedAt).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
