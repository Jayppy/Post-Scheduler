import type {
  DestinationPublishState,
  PublishingLifecycleStatus,
  SocialPlatform,
} from '../types/studio';

export const DEFAULT_PUBLISHING_TIMEZONE = 'Africa/Lagos';

export const SUPPORTED_TIMEZONES = [
  'Africa/Lagos',
  'UTC',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
] as const;

export function getUserLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_PUBLISHING_TIMEZONE;
  } catch {
    return DEFAULT_PUBLISHING_TIMEZONE;
  }
}

/**
 * Formats a UTC Date / ISO timestamp into YYYY-MM-DD in a target IANA timezone.
 */
export function formatDateInTimeZone(
  input: Date | string,
  timeZone: string = DEFAULT_PUBLISHING_TIMEZONE
): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // fallback below
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

/**
 * Formats a UTC Date / ISO timestamp into HH:mm (24h) in a target IANA timezone.
 */
export function formatTimeInTimeZone(
  input: Date | string,
  timeZone: string = DEFAULT_PUBLISHING_TIMEZONE
): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '18:00';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const h = parts.find((p) => p.type === 'hour')?.value || '00';
    const min = parts.find((p) => p.type === 'minute')?.value || '00';
    return `${h === '24' ? '00' : h}:${min}`;
  } catch {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
}

/**
 * Converts a YYYY-MM-DD and HH:mm in a specified IANA timezone (default Africa/Lagos)
 * into a canonical UTC ISO-8601 string.
 */
export function zonedDateTimeToUtcIso(
  dateStr: string,
  timeStr: string = '18:00',
  timeZone: string = DEFAULT_PUBLISHING_TIMEZONE
): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '18:00').split(':').map(Number);
  if (!y || !m || !d) return new Date().toISOString();

  // Start with a UTC guess at those calendar numbers, then adjust by the timezone's offset at that instant
  const utcGuess = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0));
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcGuess);

  const gy = Number(tzParts.find((p) => p.type === 'year')?.value || y);
  const gm = Number(tzParts.find((p) => p.type === 'month')?.value || m);
  const gd = Number(tzParts.find((p) => p.type === 'day')?.value || d);
  const ghRaw = Number(tzParts.find((p) => p.type === 'hour')?.value || 0);
  const gh = ghRaw === 24 ? 0 : ghRaw;
  const gmin = Number(tzParts.find((p) => p.type === 'minute')?.value || 0);
  const gsec = Number(tzParts.find((p) => p.type === 'second')?.value || 0);

  const renderedAsUtcMs = Date.UTC(gy, gm - 1, gd, gh, gmin, gsec);
  const offsetMs = renderedAsUtcMs - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs).toISOString();
}

export function formatReadableDateTime(
  iso: string,
  timeZone: string = DEFAULT_PUBLISHING_TIMEZONE
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function getStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'scheduled':
    case 'pending':
      return 'Scheduled';
    case 'ready-to-send':
      return 'Ready to Send';
    case 'publishing':
      return 'Publishing';
    case 'published':
      return 'Published';
    case 'partially-published':
      return 'Partially Published';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'queued':
      return 'Ready to Send';
    default:
      return status;
  }
}

export function getPlatformLabel(platform: SocialPlatform | 'instagram' | 'youtube'): string {
  switch (platform) {
    case 'instagram-carousel':
      return 'Instagram Carousel';
    case 'instagram-reel':
      return 'Instagram Reel';
    case 'instagram-feed':
      return 'Instagram Post';
    case 'youtube-shorts':
      return 'YouTube Shorts';
    case 'instagram':
      return 'Instagram';
    case 'youtube':
      return 'YouTube';
    default:
      return platform;
  }
}

export function isIsoDueNow(scheduledIso?: string, nowMs: number = Date.now()): boolean {
  if (!scheduledIso) return false;
  const targetMs = Date.parse(scheduledIso);
  return !Number.isNaN(targetMs) && targetMs <= nowMs;
}

export function computeEffectiveLifecycleStatus(opts: {
  rawStatus?: string;
  scheduledIso?: string;
  destinations?: DestinationPublishState[];
  nowMs?: number;
}): PublishingLifecycleStatus {
  const nowMs = opts.nowMs ?? Date.now();
  const raw = opts.rawStatus || 'scheduled';
  if (raw === 'draft') return 'draft';
  if (raw === 'cancelled') return 'cancelled';

  const dests = opts.destinations || [];
  if (dests.length > 0) {
    if (dests.some((d) => d.status === 'publishing')) return 'publishing';
    const pubCount = dests.filter((d) => d.status === 'published').length;
    if (pubCount === dests.length) return 'published';
    if (pubCount > 0 && pubCount < dests.length) return 'partially-published';
    if (dests.some((d) => d.status === 'failed')) return 'failed';
  } else {
    if (raw === 'publishing') return 'publishing';
    if (raw === 'published') return 'published';
    if (raw === 'partially-published') return 'partially-published';
    if (raw === 'failed') return 'failed';
  }

  if (isIsoDueNow(opts.scheduledIso, nowMs) || raw === 'ready-to-send') {
    return 'ready-to-send';
  }
  return 'scheduled';
}
