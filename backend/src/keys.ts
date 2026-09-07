import { Keypair } from "@stellar/stellar-sdk";
import { config } from "./config.js";

export const deployerKeypair = Keypair.fromSecret(config.deployerSecretKey);
export const buyerKeypair = Keypair.fromSecret(config.buyerSecretKey);
export const sellerKeypair = Keypair.fromSecret(config.sellerSecretKey);
export const attestorKeypair = Keypair.fromSecret(config.attestorSecretKey);

/**
 * Phase 1 simplification: the backend can only sign on behalf of a small,
 * fixed set of demo keypairs it holds server-side (see ARCHITECTURE.md).
 * The contract itself accepts any Stellar address as seller/attestor; this
 * keyring just limits which of those addresses *this demo backend* is able
 * to act as, since there is no client-side wallet-signing flow yet.
 */
const keyring = new Map<string, Keypair>(
  [deployerKeypair, buyerKeypair, sellerKeypair, attestorKeypair].map((kp) => [kp.publicKey(), kp]),
);

export function findLocalSigner(address: string): Keypair | undefined {
  return keyring.get(address);
}
