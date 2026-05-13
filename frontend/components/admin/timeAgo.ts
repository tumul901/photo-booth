export function timeAgo(isoOrTimestamp: string | number): string {
  const date = typeof isoOrTimestamp === 'number'
    ? new Date(isoOrTimestamp * 1000)
    : new Date(isoOrTimestamp);
  const diff = (Date.now() - date.getTime()) / 1000;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 172800) return 'yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
