import { Keypair } from "@stellar/stellar-sdk";

process.env.DB_PATH = ":memory:";
process.env.STELLAR_RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
process.env.ESCROW_WASM_HASH =
  process.env.ESCROW_WASM_HASH ||
  "0000000000000000000000000000000000000000000000000000000000000000";
process.env.PAYMENT_TOKEN_CONTRACT_ID =
  process.env.PAYMENT_TOKEN_CONTRACT_ID ||
  "CDUMMYTOKENCONTRACTID00000000000000000000000000000000000000";

if (!process.env.DEPLOYER_SECRET_KEY) {
  process.env.DEPLOYER_SECRET_KEY = Keypair.random().secret();
}
if (!process.env.BUYER_SECRET_KEY) {
  process.env.BUYER_SECRET_KEY = Keypair.random().secret();
}
if (!process.env.SELLER_SECRET_KEY) {
  process.env.SELLER_SECRET_KEY = Keypair.random().secret();
}
if (!process.env.ATTESTOR_SECRET_KEY) {
  process.env.ATTESTOR_SECRET_KEY = Keypair.random().secret();
}
