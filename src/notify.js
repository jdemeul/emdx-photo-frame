// NOTIFY_URL: a line of text POSTed when the frame needs a hand (it missed a change, its battery
// is low, it won't go into deep sleep) and when it is fine again. Made for ntfy (a topic address
// like https://ntfy.sh/my-frame-topic, or your own ntfy server), and anything else that takes a
// plain-text POST. Nothing is sent unless NOTIFY_URL is set.
import { log } from './log.js';

export async function notify(cfg, title, text) {
  if (!cfg.notifyUrl) return false;
  try {
    const res = await fetch(cfg.notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title.replace(/[^\x20-\x7e]/g, '') },
      body: text,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    log.warn(`Could not send the notification (NOTIFY_URL): ${err.message}`);
    return false;
  }
}
