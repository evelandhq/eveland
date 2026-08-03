type DateTimeParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
};

type DateTimeValue = string | number | Date;

function asDate(value: DateTimeValue): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatWithOptions(
  value: DateTimeValue,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = asDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone,
  }).format(date);
}

export function formatDateTime(
  value: DateTimeValue,
  timeZone?: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return formatWithOptions(value, timeZone, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...options,
  });
}

export function formatDate(
  value: DateTimeValue,
  timeZone?: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return formatWithOptions(value, timeZone, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...options,
  });
}

export function formatTime(
  value: DateTimeValue,
  timeZone?: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return formatWithOptions(value, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...options,
  });
}

function dateTimeParts(value: Date, timeZone?: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

export function formatCompactDateTime(value: string, now: Date, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const formatted = dateTimeParts(date, timeZone);
  const current = dateTimeParts(now, timeZone);
  const time = `${formatted.hour}:${formatted.minute}`;
  const sameDay =
    formatted.year === current.year &&
    formatted.month === current.month &&
    formatted.day === current.day;

  return sameDay ? time : `${formatted.month}-${formatted.day} ${time}`;
}
