// Getting token-account rent back.
//
// Every new coin the bot buys with real money gets its own token account, and
// Solana makes the wallet lock ~0.002 SOL of "rent" in it. Selling empties the
// account but does not close it, so that SOL stayed locked — at 0.03 SOL a
// trade, ~7% of every trade. Over one night of ~30 new coins that was most of
// what the wallet seemed to lose, while the P&L sheet (which counted only the
// swap) showed a profit. Closing an empty account sends its rent back.
//
// Safety: only accounts reported as holding exactly zero tokens are ever
// closed, and the chain itself refuses to close a token account that still
// holds tokens — so nothing here can destroy a balance. Every transaction is
// simulated before it is sent (preflight), so one that would fail costs
// nothing.

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const CLOSE_ACCOUNT = 9; // the SPL Token "CloseAccount" instruction; the same index in both programs
const BATCH_SIZE = 8; // accounts closed per transaction
const VERIFY_CHUNK = 100; // getMultipleAccountsInfo takes at most 100 addresses
const SETTLE_MS = 4_000; // before checking what really closed, if a confirmation was missed
// Confirmation is polled over plain RPC, never over the WebSocket: when the
// socket is down, web3's own confirmTransaction can wait ~90s for the
// blockhash to expire. This gives up much sooner — the chain check decides.
const CONFIRM_TIMEOUT_MS = 30_000;
const CONFIRM_POLL_MS = 1_000;

async function waitForConfirmation(connection: Connection, signature: string, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) return false;
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
}

export interface EmptyAccount {
  address: PublicKey;
  programId: PublicKey; // Token or Token-2022, whichever owns the account
  mint: string;
  lamports: number; // the rent that comes back when it is closed
}

// The shape getParsedTokenAccountsByOwner returns, loosely: only the fields used.
export interface ParsedTokenAccount {
  pubkey?: PublicKey;
  account?: {
    owner?: PublicKey;
    lamports?: number;
    data?: { parsed?: { info?: { mint?: string; state?: string; tokenAmount?: { amount?: string } } } };
  };
}

export function closeAccountInstruction(account: PublicKey, destination: PublicKey, owner: PublicKey, programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT]),
  });
}

// Pure: the accounts that are safe to close — holding exactly zero, not
// frozen, and not for a mint in `keep` (coins the bot still holds).
export function selectEmpty(accounts: ParsedTokenAccount[], keep: Set<string> = new Set()): EmptyAccount[] {
  const empty: EmptyAccount[] = [];
  for (const a of accounts) {
    const info = a.account?.data?.parsed?.info;
    const programId = a.account?.owner;
    if (!a.pubkey || !programId || !info?.mint) continue;
    if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) continue;
    if (info.tokenAmount?.amount !== '0' || info.state === 'frozen' || keep.has(info.mint)) continue;
    empty.push({ address: a.pubkey, programId, mint: info.mint, lamports: a.account?.lamports ?? 0 });
  }
  return empty;
}

// The wallet's empty token accounts: for one mint, or all of them.
export async function findEmptyAccounts(
  connection: Connection,
  owner: PublicKey,
  options: { mint?: string; keep?: Set<string> } = {}
): Promise<EmptyAccount[]> {
  if (options.mint) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(options.mint) });
    return selectEmpty(res.value as ParsedTokenAccount[], options.keep);
  }
  const found: EmptyAccount[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    found.push(...selectEmpty(res.value as ParsedTokenAccount[], options.keep));
  }
  return found;
}

// Sends one close transaction. Throws only if it was never sent — the
// preflight simulation refused it — which costs nothing. Once sent, whether it
// landed is settled afterwards by looking at the chain, not by the
// confirmation (a missed confirmation doesn't mean the close didn't happen).
async function sendClose(
  connection: Connection,
  keypair: Keypair,
  batch: EmptyAccount[],
  confirmTimeoutMs: number
): Promise<{ signature: string; confirmed: boolean }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight });
  for (const a of batch) tx.add(closeAccountInstruction(a.address, keypair.publicKey, keypair.publicKey, a.programId));
  tx.sign(keypair);
  const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  try {
    return { signature, confirmed: await waitForConfirmation(connection, signature, confirmTimeoutMs) };
  } catch {
    return { signature, confirmed: false };
  }
}

// Which of these addresses no longer exist on-chain — i.e. were closed.
async function goneFromChain(connection: Connection, addresses: PublicKey[]): Promise<Set<string>> {
  const gone = new Set<string>();
  for (let i = 0; i < addresses.length; i += VERIFY_CHUNK) {
    const chunk = addresses.slice(i, i + VERIFY_CHUNK);
    const infos = await connection.getMultipleAccountsInfo(chunk, 'confirmed');
    chunk.forEach((address, j) => {
      if (infos[j] === null) gone.add(address.toBase58());
    });
  }
  return gone;
}

export interface CloseResult {
  closed: EmptyAccount[];
  failed: { account: EmptyAccount; error: string }[];
  signatures: string[];
  reclaimedSol: number;
}

// Close accounts a few per transaction. If a batch is refused (one account in
// it can't be closed — e.g. a token that keeps fees in the account), its
// accounts are retried one by one, so one bad account never blocks the rest.
// What counts as closed — and so how much rent came back — is read from the
// chain at the end: an account that no longer exists was closed.
export async function closeAccounts(
  connection: Connection,
  keypair: Keypair,
  accounts: EmptyAccount[],
  onProgress?: (done: number, total: number) => void,
  options: { confirmTimeoutMs?: number } = {}
): Promise<CloseResult> {
  const result: CloseResult = { closed: [], failed: [], signatures: [], reclaimedSol: 0 };
  const refused = new Map<string, string>(); // address -> why the chain refused to even try it
  let missedConfirmation = false;
  const send = async (batch: EmptyAccount[]) => {
    const sent = await sendClose(connection, keypair, batch, options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS);
    result.signatures.push(sent.signature);
    if (!sent.confirmed) missedConfirmation = true;
  };
  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    const batch = accounts.slice(i, i + BATCH_SIZE);
    try {
      await send(batch);
    } catch (error) {
      if (batch.length === 1) {
        refused.set(batch[0].address.toBase58(), (error as Error).message);
      } else {
        for (const one of batch) {
          try {
            await send([one]);
          } catch (singleError) {
            refused.set(one.address.toBase58(), (singleError as Error).message);
          }
        }
      }
    }
    onProgress?.(Math.min(i + BATCH_SIZE, accounts.length), accounts.length);
  }
  if (missedConfirmation) await new Promise((r) => setTimeout(r, SETTLE_MS));
  const gone = await goneFromChain(connection, accounts.map((a) => a.address));
  for (const account of accounts) {
    const key = account.address.toBase58();
    if (gone.has(key)) result.closed.push(account);
    else result.failed.push({ account, error: refused.get(key) ?? 'sent, but still open — it may not have landed; run npm run reclaim again' });
  }
  result.reclaimedSol = result.closed.reduce((a, c) => a + c.lamports, 0) / 1e9;
  return result;
}
