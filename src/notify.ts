// Desktop notifications and sounds on macOS, so you don't have to watch the
// terminal.
//
// Two independent channels, each with its own .env switch:
//   NOTIFICATIONS=true  -> a banner via osascript (Notification Center)
//   SOUNDS=true         -> a sound via afplay, DIFFERENT per event:
//                          buy filled / sell done / sell FAILED (stuck)
//
// The sound goes through afplay rather than the notification's own
// "sound name" so it still plays when Notification Center is muted or in Do
// Not Disturb, and so a fill and a sale are audibly distinct without reading
// the screen.
//
// Both use execFile (no shell). Text is stripped of characters that would
// break out of the AppleScript string. A notification or sound failing must
// never interrupt trading, so every error is swallowed.

import { execFile } from 'child_process';

export type NotifyKind = 'buy' | 'sell' | 'fail';

// macOS ships these in /System/Library/Sounds: Basso Blow Bottle Frog Funk
// Glass Hero Morse Ping Pop Purr Sosumi Submarine Tink.
const DEFAULT_SOUNDS: Record<NotifyKind, string> = {
  buy: 'Glass', // order filled
  sell: 'Hero', // order sold
  fail: 'Basso', // sell failed — position stuck
};

const ENV_KEYS: Record<NotifyKind, string> = {
  buy: 'SOUND_BUY',
  sell: 'SOUND_SELL',
  fail: 'SOUND_FAIL',
};

function sanitize(text: string): string {
  return text.replace(/["\\\n\r]/g, ' ').slice(0, 200);
}

function flagOff(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name] ?? 'true').trim().toLowerCase() === 'false';
}

// Pure: which audio file to play for an event, or null for silence. Exported
// so the tests can pin the choice without spawning anything. A bare name is a
// system sound; an absolute path (starts with "/") is your own .aiff/.mp3/.wav.
// Anything else — a relative path, shell-looking junk, a name with ".aiff" on
// it — falls back to the DEFAULT for that event rather than to silence, so a
// typo in .env can't quietly mute a real trade.
export function soundFor(kind: NotifyKind, env: NodeJS.ProcessEnv = process.env): string | null {
  if (flagOff(env, 'SOUNDS')) return null;
  const override = (env[ENV_KEYS[kind]] ?? '').trim();
  const name = override || DEFAULT_SOUNDS[kind];
  if (name.startsWith('/')) return name;
  if (/^[A-Za-z0-9 _-]+$/.test(name)) return `/System/Library/Sounds/${name}.aiff`;
  return `/System/Library/Sounds/${DEFAULT_SOUNDS[kind]}.aiff`;
}

function playSound(file: string): void {
  try {
    execFile('afplay', [file], () => {
      /* a missing or unplayable sound is never worth surfacing */
    });
  } catch {
    /* ignore */
  }
}

function showBanner(title: string, message: string): void {
  const script = `display notification "${sanitize(message)}" with title "${sanitize(title)}"`;
  try {
    execFile('osascript', ['-e', script], () => {
      /* a failed notification is never worth surfacing */
    });
  } catch {
    /* ignore */
  }
}

export function notify(title: string, message: string, kind: NotifyKind): void {
  if (process.platform !== 'darwin') return;
  const sound = soundFor(kind);
  if (sound) playSound(sound);
  if (!flagOff(process.env, 'NOTIFICATIONS')) showBanner(title, message);
}
