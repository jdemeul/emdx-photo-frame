// Minimal timestamped logger (Container Manager shows stdout as the container log).
const tz = process.env.TZ || 'Europe/Brussels';
let fmt;
try {
  fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
} catch {
  fmt = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium' });
}

export function stamp(date = new Date()) {
  return fmt.format(date);
}

function line(level, args) {
  const msg = args
    .map((a) => (a instanceof Error ? (process.env.DEBUG ? a.stack : a.message) : typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  const out = `${stamp()} ${level} ${msg}`;
  if (level === 'ERROR' || level === 'WARN ') console.error(out);
  else console.log(out);
}

export const log = {
  info: (...a) => line('INFO ', a),
  warn: (...a) => line('WARN ', a),
  error: (...a) => line('ERROR', a),
  debug: (...a) => { if (process.env.DEBUG) line('DEBUG', a); },
};
