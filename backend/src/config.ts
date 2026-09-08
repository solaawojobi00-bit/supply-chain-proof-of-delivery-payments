import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export function parseCorsOrigins(origins?: string): string[] {
  if (!origins || origins.trim() === "") return [];
  return origins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
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
  buyerApiKey: process.env.BUYER_API_KEY ?? "demo-buyer-token",
  sellerApiKey: process.env.SELLER_API_KEY ?? "demo-seller-token",
  attestorApiKey: process.env.ATTESTOR_API_KEY ?? "demo-attestor-token",
  arbiterApiKey: process.env.ARBITER_API_KEY ?? "demo-arbiter-token",
  adminApiKey: process.env.ADMIN_API_KEY ?? "demo-admin-token",
  corsAllowedOrigins: parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS),
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./data/orders.sqlite",
};
