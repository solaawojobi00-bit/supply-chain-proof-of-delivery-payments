import { describe, expect, it } from "vitest";
import { NETWORK_PASSPHRASES, REQUIRED_ENV_VARS, resolveConfig } from "../src/config.js";

describe("Network & Configuration Readiness (Issue #84)", () => {
  const baseValidEnv: NodeJS.ProcessEnv = {
    STELLAR_NETWORK: "testnet",
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    ESCROW_WASM_HASH: "0000000000000000000000000000000000000000000000000000000000000000",
    PAYMENT_TOKEN_CONTRACT_ID: "CDUMMYTOKENCONTRACTID00000000000000000000000000000000000000",
    DEPLOYER_SECRET_KEY: "SDEPLOYERSECRETKEY000000000000000000000000000000000000000000",
    BUYER_SECRET_KEY: "SBUYERSECRETKEY000000000000000000000000000000000000000000000",
    SELLER_SECRET_KEY: "SSELLERSECRETKEY000000000000000000000000000000000000000000000",
    ATTESTOR_SECRET_KEY: "SATTESTORSECRETKEY00000000000000000000000000000000000000000000",
  };

  it("resolves valid testnet config and derives expected passphrase if omitted", () => {
    const env = { ...baseValidEnv };
    delete env.STELLAR_NETWORK_PASSPHRASE;
    delete env.STELLAR_NETWORK;

    const resolved = resolveConfig(env);
    expect(resolved.network).toBe("testnet");
    expect(resolved.networkPassphrase).toBe(NETWORK_PASSPHRASES.testnet);
    expect(resolved.rpcUrl).toBe(baseValidEnv.STELLAR_RPC_URL);
  });

  it("resolves valid local / standalone network config", () => {
    const env = {
      ...baseValidEnv,
      STELLAR_NETWORK: "local",
      STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.local,
      STELLAR_RPC_URL: "http://localhost:8000/soroban/rpc",
    };

    const resolved = resolveConfig(env);
    expect(resolved.network).toBe("local");
    expect(resolved.networkPassphrase).toBe(NETWORK_PASSPHRASES.local);
  });

  it("resolves valid mainnet config when ALLOW_MAINNET=true is explicitly set", () => {
    const env = {
      ...baseValidEnv,
      STELLAR_NETWORK: "mainnet",
      ALLOW_MAINNET: "true",
      STELLAR_RPC_URL: "https://mainnet.stellar.org:443",
      STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.mainnet,
    };

    const resolved = resolveConfig(env);
    expect(resolved.network).toBe("mainnet");
    expect(resolved.networkPassphrase).toBe(NETWORK_PASSPHRASES.mainnet);
  });

  it("fails fast if STELLAR_NETWORK=mainnet is specified without ALLOW_MAINNET=true", () => {
    const env = {
      ...baseValidEnv,
      STELLAR_NETWORK: "mainnet",
      STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.mainnet,
    };

    expect(() => resolveConfig(env)).toThrowError(
      /Mainnet configuration detected.*ALLOW_MAINNET=true is not set/,
    );
  });

  it("rejects unsupported or invalid STELLAR_NETWORK values", () => {
    const env = {
      ...baseValidEnv,
      STELLAR_NETWORK: "unknown-net",
    };

    expect(() => resolveConfig(env)).toThrowError(
      /Invalid STELLAR_NETWORK: "unknown-net". Supported networks are: testnet, mainnet, local/,
    );
  });

  it("throws clear error on STELLAR_NETWORK_PASSPHRASE mismatch naming both values", () => {
    const env = {
      ...baseValidEnv,
      STELLAR_NETWORK: "testnet",
      STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; July 2015",
    };

    expect(() => resolveConfig(env)).toThrowError(
      /STELLAR_NETWORK_PASSPHRASE mismatch for network "testnet"\. Expected "Test SDF Network ; September 2015", but got "Public Global Stellar Network ; July 2015"/,
    );
  });

  it("reports all missing required environment variables at once", () => {
    const env: NodeJS.ProcessEnv = {
      STELLAR_NETWORK: "testnet",
    };

    expect(() => resolveConfig(env)).toThrowError(
      new RegExp(
        `Missing required environment variable\\(s\\) for network "testnet": ${REQUIRED_ENV_VARS.join(
          ", ",
        )}`,
      ),
    );
  });

  it("reports subset of missing variables simultaneously", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseValidEnv,
    };
    delete env.DEPLOYER_SECRET_KEY;
    delete env.ESCROW_WASM_HASH;

    expect(() => resolveConfig(env)).toThrowError(
      /Missing required environment variable\(s\) for network "testnet": ESCROW_WASM_HASH, DEPLOYER_SECRET_KEY/,
    );
  });
});
