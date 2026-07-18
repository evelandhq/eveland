export function trendPoints(values: number[], width: number, height: number): string {
  if (values.length < 2) return "";
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum;
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = range === 0 ? height / 2 : height - ((value - minimum) / range) * height;
    return `${round(x)},${round(y)}`;
  }).join(" ");
}

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

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
