const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

export function formatRelativeRunTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const diffMs = date.getTime() - now.getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, 'second');

  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');

  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatAbsoluteRunTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}
