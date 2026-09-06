// Desktop notifications on macOS, so you don't have to watch the terminal.
//
// Uses osascript via execFile (no shell), and strips characters that would
// break out of the AppleScript string. A notification failing must never
// interrupt trading, so every error is swallowed.

import { execFile } from 'child_process';

function sanitize(text: string): string {
  return text.replace(/["\\\n\r]/g, ' ').slice(0, 200);
}

export function notify(title: string, message: string): void {
  if (process.platform !== 'darwin') return;
  if ((process.env.NOTIFICATIONS ?? 'true').trim().toLowerCase() === 'false') return;

  const script = `display notification "${sanitize(message)}" with title "${sanitize(title)}" sound name "Glass"`;
  try {
    execFile('osascript', ['-e', script], () => {
      /* a failed notification is never worth surfacing */
    });
  } catch {
    /* ignore */
  }
}
