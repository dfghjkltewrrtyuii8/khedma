import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Config } from './config';

// Phantom's standard derivation path for the first Solana account.
const DERIVATION_PATH = "m/44'/501'/0'/0'";

export function loadKeypair(config: Pick<Config, 'privateKeyBase58' | 'walletMnemonic'>): Keypair {
  if (config.privateKeyBase58) {
    let secretKey: Uint8Array;
    try {
      secretKey = bs58.decode(config.privateKeyBase58);
    } catch {
      throw new Error('PRIVATE_KEY_BASE58 is not valid base58. Re-export it from Phantom and paste it exactly.');
    }
    if (secretKey.length !== 64) {
      throw new Error(
        `PRIVATE_KEY_BASE58 decoded to ${secretKey.length} bytes, expected 64. ` +
          'Make sure you exported the PRIVATE KEY (not the public address or the recovery phrase).'
      );
    }
    return Keypair.fromSecretKey(secretKey);
  }

  if (config.walletMnemonic) {
    const mnemonic = config.walletMnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error(
        'WALLET_MNEMONIC is not a valid 12/24-word recovery phrase. ' +
          'Check for typos and make sure words are separated by single spaces.'
      );
    }
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const derived = derivePath(DERIVATION_PATH, seed.toString('hex')).key;
    return Keypair.fromSeed(derived);
  }

  throw new Error('No wallet configured (this should have been caught by config validation).');
}
