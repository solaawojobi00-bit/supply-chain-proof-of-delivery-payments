import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const config = {
  rpcUrl: requireEnv("STELLAR_RPC_URL"),
  networkPassphrase: requireEnv("STELLAR_NETWORK_PASSPHRASE"),
  wasmHash: requireEnv("ESCROW_WASM_HASH"),
  paymentTokenContractId: requireEnv("PAYMENT_TOKEN_CONTRACT_ID"),
  escrowRegistryContractId:
    process.env.ESCROW_REGISTRY_CONTRACT_ID ?? process.env.ESCROW_CONTRACT_ID,
  deployerSecretKey: requireEnv("DEPLOYER_SECRET_KEY"),
  buyerSecretKey: requireEnv("BUYER_SECRET_KEY"),
  sellerSecretKey: requireEnv("SELLER_SECRET_KEY"),
  attestorSecretKey: requireEnv("ATTESTOR_SECRET_KEY"),
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./data/orders.sqlite",
};
