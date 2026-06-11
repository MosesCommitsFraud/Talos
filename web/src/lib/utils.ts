import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(value: number | string | null | undefined): string {
  const epochSeconds = typeof value === 'string'
    ? Date.parse(value) / 1000
    : typeof value === 'number'
      ? value
      : 0;
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return '';
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}
