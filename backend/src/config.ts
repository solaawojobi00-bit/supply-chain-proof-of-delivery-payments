import "dotenv/config";

export type StellarNetwork = "testnet" | "mainnet" | "local";

export const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; July 2015",
  local: "Standalone Network ; February 2017",
};

export const REQUIRED_ENV_VARS = [
  "STELLAR_RPC_URL",
  "ESCROW_WASM_HASH",
  "PAYMENT_TOKEN_CONTRACT_ID",
  "DEPLOYER_SECRET_KEY",
  "BUYER_SECRET_KEY",
  "SELLER_SECRET_KEY",
  "ATTESTOR_SECRET_KEY",
] as const;

export function parseCorsOrigins(origins?: string): string[] {
  if (!origins || origins.trim() === "") return [];
  return origins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function parseTrustProxy(value?: string): boolean | number | string {
  if (value === undefined || value.trim() === "") return false;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1") return true;
  if (trimmed === "false" || trimmed === "0") return false;
  const num = Number(value);
  if (!isNaN(num)) return num;
  return value.trim();
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env) {
  const rawNetwork = (env.STELLAR_NETWORK || "testnet").toLowerCase().trim();
  if (rawNetwork !== "testnet" && rawNetwork !== "mainnet" && rawNetwork !== "local") {
    throw new Error(
      `Invalid STELLAR_NETWORK: "${rawNetwork}". Supported networks are: testnet, mainnet, local.`,
    );
  }
  const network: StellarNetwork = rawNetwork as StellarNetwork;

  if (network === "mainnet" && env.ALLOW_MAINNET !== "true" && env.ALLOW_MAINNET !== "1") {
    throw new Error(
      `Mainnet configuration detected (STELLAR_NETWORK="mainnet"), but ALLOW_MAINNET=true is not set. Explicit opt-in required for mainnet operation.`,
    );
  }

  const missingVars = REQUIRED_ENV_VARS.filter(
    (name) => !env[name] || env[name]!.trim().length === 0,
  );
  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variable(s) for network "${network}": ${missingVars.join(
        ", ",
      )}. Copy .env.example to .env and fill them in.`,
    );
  }

  const expectedPassphrase = NETWORK_PASSPHRASES[network];
  const providedPassphrase = env.STELLAR_NETWORK_PASSPHRASE?.trim();
  if (providedPassphrase && providedPassphrase !== expectedPassphrase) {
    throw new Error(
      `STELLAR_NETWORK_PASSPHRASE mismatch for network "${network}". Expected "${expectedPassphrase}", but got "${providedPassphrase}".`,
    );
  }
  const networkPassphrase = providedPassphrase || expectedPassphrase;

  return {
    network,
    rpcUrl: env.STELLAR_RPC_URL!,
    networkPassphrase,
    wasmHash: env.ESCROW_WASM_HASH!,
    paymentTokenContractId: env.PAYMENT_TOKEN_CONTRACT_ID!,
    escrowRegistryContractId: env.ESCROW_REGISTRY_CONTRACT_ID ?? env.ESCROW_CONTRACT_ID,
    deployerSecretKey: env.DEPLOYER_SECRET_KEY!,
    buyerSecretKey: env.BUYER_SECRET_KEY!,
    sellerSecretKey: env.SELLER_SECRET_KEY!,
    attestorSecretKey: env.ATTESTOR_SECRET_KEY!,
    buyerApiKey: env.BUYER_API_KEY ?? "demo-buyer-token",
    sellerApiKey: env.SELLER_API_KEY ?? "demo-seller-token",
    attestorApiKey: env.ATTESTOR_API_KEY ?? "demo-attestor-token",
    arbiterApiKey: env.ARBITER_API_KEY ?? "demo-arbiter-token",
    adminApiKey: env.ADMIN_API_KEY ?? "demo-admin-token",
    corsAllowedOrigins: parseCorsOrigins(env.CORS_ALLOWED_ORIGINS),
    webhookSigningSecret: env.WEBHOOK_SIGNING_SECRET ?? "",
    webhookSignatureToleranceSeconds: Number(env.WEBHOOK_SIGNATURE_TOLERANCE_SECONDS ?? 300),
    rateLimitEnabled: env.RATE_LIMIT_ENABLED !== "false" && env.RATE_LIMIT_ENABLED !== "0",
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? 60000),
    rateLimitMaxMutating: Number(env.RATE_LIMIT_MAX_MUTATING ?? 30),
    rateLimitMaxGeneral: Number(env.RATE_LIMIT_MAX_GENERAL ?? 300),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? "./data/orders.sqlite",
  };
}

export const config = resolveConfig(process.env);
