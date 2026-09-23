// Desktop alerts on macOS, so you know what the bot did without watching the
// terminal. Three independent switches in .env:
//
//   NOTIFICATIONS=true -> a banner in Notification Center
//   SOUNDS=true        -> a short chime (afplay), a different one per event
//   SPEECH=true        -> a spoken phrase (say): "Order filled", "Order sold"
//
// The chime plays first and the phrase follows it, so they never talk over
// each other. Simulated (dry-run) trades are spoken as "Simulated order
// filled" — hearing a paper trade as if it were real money is exactly the
// confusion this project refuses to create.
//
// Everything goes through execFile (no shell, so nothing in .env can be
// interpreted as a command) and is fire-and-forget: trading never waits on
// audio, and audio that fails is never surfaced.
//
// macOS uses afplay + say. Windows uses PowerShell's built-in SoundPlayer and
// System.Speech (see the Windows section below). Linux stays silent.

import { execFile } from 'child_process';

export type NotifyKind = 'buy' | 'sell' | 'fail';

// macOS ships these in /System/Library/Sounds: Basso Blow Bottle Frog Funk
// Glass Hero Morse Ping Pop Purr Sosumi Submarine Tink.
const DEFAULT_SOUNDS: Record<NotifyKind, string> = {
  buy: 'Glass', // order filled
  sell: 'Hero', // order sold
  fail: 'Basso', // sell failed — position stuck
};

const DEFAULT_PHRASES: Record<NotifyKind, string> = {
  buy: 'Order filled',
  sell: 'Order sold',
  fail: 'Sell failed. Position stuck.',
};

const SOUND_KEYS: Record<NotifyKind, string> = {
  buy: 'SOUND_BUY',
  sell: 'SOUND_SELL',
  fail: 'SOUND_FAIL',
};

const SPEECH_KEYS: Record<NotifyKind, string> = {
  buy: 'SPEECH_BUY',
  sell: 'SPEECH_SELL',
  fail: 'SPEECH_FAIL',
};

const MAX_PHRASE_CHARS = 200;

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
  const override = (env[SOUND_KEYS[kind]] ?? '').trim();
  const name = override || DEFAULT_SOUNDS[kind];
  if (name.startsWith('/')) return name;
  if (/^[A-Za-z0-9 _-]+$/.test(name)) return `/System/Library/Sounds/${name}.aiff`;
  return `/System/Library/Sounds/${DEFAULT_SOUNDS[kind]}.aiff`;
}

// Pure: what the Mac should SAY for an event, or null for silence. As with
// sounds, an empty or missing override falls back to the default phrase —
// silence is only ever chosen deliberately, with SPEECH=false.
export function speechFor(
  kind: NotifyKind,
  simulated: boolean,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (flagOff(env, 'SPEECH')) return null;
  const override = (env[SPEECH_KEYS[kind]] ?? '').trim();
  const phrase = (override || DEFAULT_PHRASES[kind]).slice(0, MAX_PHRASE_CHARS);
  return simulated ? `Simulated. ${phrase}` : phrase;
}

// Pure: the voice/rate flags for `say`. Both are validated rather than passed
// through: a value starting with "-" would become a flag, and a nonsense rate
// makes `say` fail silently — in both cases the phrase is better spoken in the
// default voice than not spoken at all.
export function speechArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  const voice = (env.SPEECH_VOICE ?? '').trim();
  if (/^[A-Za-z][A-Za-z ]{0,40}$/.test(voice)) args.push('-v', voice);
  const rate = Number((env.SPEECH_RATE ?? '').trim());
  if (Number.isInteger(rate) && rate >= 80 && rate <= 500) args.push('-r', String(rate));
  return args;
}

// ---------------------------------------------------------------- Windows ---
// Windows has no afplay or say, but every copy ships PowerShell with
// System.Media.SoundPlayer and System.Speech. The script below is a CONSTANT
// and is passed base64-encoded (-EncodedCommand), so there is no quoting to
// get wrong. The phrase, sound file and voice reach it ONLY through
// environment variables — never pasted into the command — so nothing in .env
// can ever run as PowerShell. Each step has its own try/catch: a missing sound
// file or an unknown voice skips that step and the phrase is still spoken.

const WINDOWS_MEDIA = 'C:\\Windows\\Media\\';
const WINDOWS_DEFAULT_SOUNDS: Record<NotifyKind, string> = {
  buy: `${WINDOWS_MEDIA}chimes.wav`,
  sell: `${WINDOWS_MEDIA}tada.wav`,
  fail: `${WINDOWS_MEDIA}Windows Critical Stop.wav`,
};

export const WINDOWS_ALERT_SCRIPT = [
  'try { if ($env:COPYBOT_WAV) { (New-Object System.Media.SoundPlayer $env:COPYBOT_WAV).PlaySync() } } catch {}',
  'try {',
  '  if ($env:COPYBOT_SAY) {',
  '    Add-Type -AssemblyName System.Speech',
  '    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '    if ($env:COPYBOT_VOICE) {',
  '      try { $s.SelectVoice($env:COPYBOT_VOICE) } catch {',
  "        try { if ($env:COPYBOT_VOICE -match '^(male|female)$') { $s.SelectVoiceByHints($env:COPYBOT_VOICE) } } catch {}",
  '      }',
  '    }',
  '    $s.Speak($env:COPYBOT_SAY)',
  '  }',
  '} catch {}',
].join('\n');

const WINDOWS_ALERT_SCRIPT_B64 = Buffer.from(WINDOWS_ALERT_SCRIPT, 'utf16le').toString('base64');

// Pure: which .wav to play on Windows. SOUND_BUY etc. may be a full Windows
// path to a .wav (C:\...\x.wav); anything else — including the Mac names
// like Glass, so a .env copied from a Mac just works — falls back to the
// Windows default for that event rather than to silence.
export function windowsSoundFor(kind: NotifyKind, env: NodeJS.ProcessEnv = process.env): string | null {
  if (flagOff(env, 'SOUNDS')) return null;
  const override = (env[SOUND_KEYS[kind]] ?? '').trim();
  if (/^[A-Za-z]:\\[^"<>|?*]+\.wav$/i.test(override)) return override;
  return WINDOWS_DEFAULT_SOUNDS[kind];
}

// Pure: exactly how the Windows alert is launched. Exported so a test can
// prove no .env value ever appears in the command line itself.
export function windowsAlertInvocation(
  kind: NotifyKind,
  simulated: boolean,
  env: NodeJS.ProcessEnv = process.env
): { file: string; args: string[]; env: Record<string, string> } | null {
  const wav = windowsSoundFor(kind, env);
  const phrase = speechFor(kind, simulated, env);
  if (!wav && !phrase) return null;
  const voice = (env.SPEECH_VOICE ?? '').trim();
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_ALERT_SCRIPT_B64],
    env: {
      COPYBOT_WAV: wav ?? '',
      COPYBOT_SAY: phrase ?? '',
      // Same validation as the Mac voice: letters and spaces only. Windows
      // voice names look like 'Microsoft David Desktop'; 'male' or 'female'
      // picks any installed voice of that kind.
      COPYBOT_VOICE: /^[A-Za-z][A-Za-z ]{0,40}$/.test(voice) ? voice : '',
    },
  };
}

// Resolves when the command finishes. Never rejects: a missing sound file or
// an unavailable voice must not surface as an error mid-trade.
function run(command: string, args: string[], extraEnv?: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { env: extraEnv ? { ...process.env, ...extraEnv } : process.env, windowsHide: true },
        () => resolve()
      );
    } catch {
      resolve();
    }
  });
}

// Chime, then speech — sequenced so the phrase isn't buried under the chime.
async function playAlert(kind: NotifyKind, simulated: boolean): Promise<void> {
  if (process.platform === 'win32') {
    const invocation = windowsAlertInvocation(kind, simulated);
    if (invocation) await run(invocation.file, invocation.args, invocation.env);
    return;
  }
  if (process.platform !== 'darwin') return;
  const sound = soundFor(kind);
  if (sound) await run('afplay', [sound]);
  const phrase = speechFor(kind, simulated);
  if (phrase) await run('say', [...speechArgs(), phrase]);
}

// Hear an alert on demand (npm run alerts), awaiting it so a preview plays one
// at a time instead of three at once.
export function previewAlert(kind: NotifyKind, simulated = false): Promise<void> {
  return playAlert(kind, simulated);
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

export function notify(title: string, message: string, kind: NotifyKind, simulated = false): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  void playAlert(kind, simulated); // deliberately not awaited — trading never waits on audio
  // Banners are macOS-only (Notification Center); Windows gets sound + speech.
  if (process.platform === 'darwin' && !flagOff(process.env, 'NOTIFICATIONS')) showBanner(title, message);
}
