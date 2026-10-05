/** "5 mins ago", "1 hour ago", "yesterday". `now` is for tests. */
export function fmtAgo(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} mins ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** The clock time, "2:04 PM", or with the day once it isn't today. */
export function fmtClock(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString(undefined, time);
  return d.toLocaleString(undefined, { weekday: 'short', ...time });
}
