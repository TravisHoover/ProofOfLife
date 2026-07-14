// Session dates and the ping window must be computed in the configured
// timezone, not in the server's local time (Railway runs in UTC, which shifts
// the day boundary to the early evening in US timezones).

export function tzNow(timezone: string, d: Date = new Date()): { date: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function dateStringDaysBefore(days: number, from: string): string {
  const d = new Date(`${from}T12:00:00Z`);
  return new Date(d.getTime() - days * 86400000).toISOString().slice(0, 10);
}

// Day of week for a YYYY-MM-DD date string: 0 = Sunday … 6 = Saturday.
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}
