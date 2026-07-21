function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatCompactDateTime(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return sameDay
    ? time
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}
