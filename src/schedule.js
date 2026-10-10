// When the next update runs, and when the display should wake for it.
import { Cron } from 'croner';

export function nextRunAt(cfg, from = new Date()) {
  const job = new Cron(cfg.schedule, { timezone: cfg.timezone, paused: true });
  try {
    return job.nextRun(from);
  } finally {
    job.stop();
  }
}

// Local time of day (in cfg.timezone) for the display's wake-up timer:
// WAKE_LEAD_MIN before the next scheduled update.
export function wakeTimeFor(cfg, from = new Date()) {
  const next = nextRunAt(cfg, from);
  if (!next) return null;
  return timeOfDay(cfg, new Date(next.getTime() - cfg.sleep.wakeLeadMin * 60000));
}

export function timeOfDay(cfg, at) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return { at, hour, minute, label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}
