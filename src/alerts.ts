// Hear every alert on demand, without waiting for a trade: npm run alerts
//
// Plays each event the way the bot will play it — chime first, then the
// spoken phrase — reading SOUNDS / SPEECH / SPEECH_VOICE / SPEECH_RATE from
// your .env, so what you hear here is exactly what you'll hear live.

import 'dotenv/config';
import { NotifyKind, previewAlert, soundFor, speechFor, windowsSoundFor } from './notify';

const SEQUENCE: { kind: NotifyKind; simulated: boolean; when: string }[] = [
  { kind: 'buy', simulated: false, when: 'a real buy fills' },
  { kind: 'sell', simulated: false, when: 'a real sell completes' },
  { kind: 'fail', simulated: false, when: 'a sell FAILS and the position is stuck' },
  { kind: 'buy', simulated: true, when: 'a dry-run (paper) buy fills' },
];

async function main(): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    console.log('Alerts only play on macOS and Windows. Nothing to preview here.');
    return;
  }
  const chimeFor = process.platform === 'win32' ? windowsSoundFor : soundFor;
  console.log('\n🔊 Playing each alert once. Turn the volume up.\n');
  for (const step of SEQUENCE) {
    const chime = chimeFor(step.kind);
    const phrase = speechFor(step.kind, step.simulated);
    console.log(`   When ${step.when}:`);
    console.log(`      chime:  ${chime ?? 'off (SOUNDS=false)'}`);
    console.log(`      speech: ${phrase === null ? 'off (SPEECH=false)' : `"${phrase}"`}`);
    await previewAlert(step.kind, step.simulated);
    console.log('');
  }
  console.log('Change these with SOUNDS / SPEECH / SOUND_* / SPEECH_* in .env, then run this again.');
  if (process.platform === 'win32') {
    console.log('Male voice on Windows: SPEECH_VOICE=male   (or an exact name like SPEECH_VOICE=Microsoft David Desktop)\n');
  } else {
    console.log('Voices your Mac has: say -v "?"     (set one with SPEECH_VOICE=Samantha)\n');
  }
}

main().catch((error) => {
  console.error(`Could not play the alerts: ${(error as Error).message}`);
  process.exit(1);
});
