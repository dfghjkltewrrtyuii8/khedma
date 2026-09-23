// Terminal questions for the interactive commands (`npm run setup`,
// `npm run telegram`): plain, hidden (for secrets) and yes/no.

import readline from 'readline/promises';
import { Writable } from 'stream';

export interface Prompter {
  ask(prompt: string): Promise<string>;
  askHidden(prompt: string): Promise<string>;
  askYesNo(prompt: string): Promise<boolean>;
  // Call once everything is written; after this, closing input is not an error.
  done(): void;
}

// `what` names the command in the messages shown if input ends early or
// Ctrl+C is pressed, e.g. "setup" -> "Setup cancelled — nothing was written."
export function createPrompter(what: string): Prompter {
  // Hidden input: in terminal mode readline echoes what you type through
  // `output`; while `muted` that echo is dropped, so a pasted key or phrase
  // never shows on screen. (Terminal mode only makes sense on a real TTY; with
  // piped input nothing is echoed anyway.)
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });

  // Lines are queued as they arrive and handed out one per question, in order.
  // readline's own question() drops any line that lands while no question is
  // pending — which happens when several lines arrive at once (a paste with
  // line breaks, or answers piped in) — and a dropped answer here means a
  // question silently waits forever.
  const pendingLines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let finished = false;
  let inputEnded = false;
  const endedEarly = (): never => {
    console.log(`\n\nInput ended before ${what} finished — nothing was written.`);
    process.exit(1);
  };
  rl.on('line', (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else pendingLines.push(line);
  });
  // Input can end while answers are still queued (piped in, or pasted just
  // before the window closed) — only give up once a question has nothing left.
  rl.on('close', () => {
    inputEnded = true;
    if (!finished && waiting.length > 0) endedEarly();
  });
  rl.on('SIGINT', () => {
    console.log(`\n\n${what[0].toUpperCase()}${what.slice(1)} cancelled — nothing was written.`);
    process.exit(130);
  });

  function nextLine(): Promise<string> {
    if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift()!);
    if (inputEnded) endedEarly();
    return new Promise((resolve) => waiting.push(resolve));
  }

  async function ask(prompt: string): Promise<string> {
    muted = false;
    rl.setPrompt(prompt);
    rl.prompt();
    return (await nextLine()).trim();
  }

  async function askHidden(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    muted = true;
    try {
      rl.setPrompt('');
      rl.prompt();
      return (await nextLine()).trim();
    } finally {
      muted = false;
      process.stdout.write('\n');
    }
  }

  async function askYesNo(prompt: string): Promise<boolean> {
    for (;;) {
      const answer = (await ask(`${prompt} (y/n) `)).toLowerCase();
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
    }
  }

  return {
    ask,
    askHidden,
    askYesNo,
    done() {
      finished = true;
      if (!inputEnded) rl.close();
    },
  };
}
