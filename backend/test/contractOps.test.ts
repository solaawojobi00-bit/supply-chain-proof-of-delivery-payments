import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// Mock @stellar/stellar-sdk/contract
const mockDeploy = vi.fn();
const mockFrom = vi.fn();

vi.mock("@stellar/stellar-sdk/contract", () => ({
  Client: {
    deploy: vi.fn((...args: unknown[]) => mockDeploy(...args)),
    from: vi.fn((...args: unknown[]) => mockFrom(...args)),
  },
  KeypairSigner: vi.fn(),
  Result: class {
    constructor(
      private val: unknown,
      private err?: unknown,
    ) {}
    unwrap() {
      if (this.err) throw new Error(String(this.err));
      return this.val;
    }
  },
}));

import {
  deployEscrowContract,
  callCreate,
  callAttest,
  callClaim,
  callReclaim,
  readOnChainOrder,
} from "../src/contractOps.js";

describe("Contract Operations with Logging (contractOps.ts)", () => {
  const buyerKeypair = Keypair.random();
  const sellerKeypair = Keypair.random();
  const attestorKeypair = Keypair.random();
  const contractId = "C" + "0".repeat(55);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deployEscrowContract logs contract deploy and txHash on success", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDeploy.mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { options: { contractId } },
        sendTransactionResponse: { hash: "tx-deploy-123" },
      }),
    });

    const res = await deployEscrowContract();
    expect(res.contractId).toBe(contractId);
    expect(res.txHash).toBe("tx-deploy-123");

    const logged = consoleSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const deployLog = logged.find((l) => l.type === "contract_call" && l.method === "deploy");
    expect(deployLog).toBeDefined();
    expect(deployLog.contractId).toBe(contractId);
    expect(deployLog.txHash).toBe("tx-deploy-123");
    expect(typeof deployLog.duration).toBe("number");
  });

  it("deployEscrowContract logs error on failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDeploy.mockRejectedValueOnce(new Error("RPC deployment timeout"));

    await expect(deployEscrowContract()).rejects.toThrow("RPC deployment timeout");

    const logged = errorSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const errLog = logged.find((l) => l.type === "contract_call" && l.method === "deploy");
    expect(errLog).toBeDefined();
    expect(errLog.level).toBe("error");
    expect(errLog.error).toBe("RPC deployment timeout");
  });

  it("callCreate logs method, contractId, txHash, and duration", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockCreateMethod = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-create-hash" },
      }),
    });
    mockFrom.mockResolvedValueOnce({ create: mockCreateMethod });

    const hash = await callCreate(contractId, buyerKeypair, {
      seller: sellerKeypair.publicKey(),
      attestor: attestorKeypair.publicKey(),
      amount: 1000n,
      deadline: 123456n,
    });

    expect(hash).toBe("tx-create-hash");
    const logged = consoleSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const createLog = logged.find((l) => l.type === "contract_call" && l.method === "create");
    expect(createLog).toBeDefined();
    expect(createLog.contractId).toBe(contractId);
    expect(createLog.txHash).toBe("tx-create-hash");
  });

  it("callAttest logs method, contractId, txHash, and duration", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockAttestMethod = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-attest-hash" },
      }),
    });
    mockFrom.mockResolvedValueOnce({ attest: mockAttestMethod });

    const hash = await callAttest(contractId, attestorKeypair);

    expect(hash).toBe("tx-attest-hash");
    const logged = consoleSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const attestLog = logged.find((l) => l.type === "contract_call" && l.method === "attest");
    expect(attestLog).toBeDefined();
    expect(attestLog.contractId).toBe(contractId);
    expect(attestLog.txHash).toBe("tx-attest-hash");
  });

  it("callClaim logs error on failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockClaimMethod = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockRejectedValueOnce(new Error("Contract error: Already claimed")),
    });
    mockFrom.mockResolvedValueOnce({ claim: mockClaimMethod });

    await expect(callClaim(contractId, sellerKeypair)).rejects.toThrow("Already claimed");

    const logged = errorSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const claimLog = logged.find((l) => l.type === "contract_call" && l.method === "claim");
    expect(claimLog).toBeDefined();
    expect(claimLog.level).toBe("error");
    expect(claimLog.error).toContain("Already claimed");
  });

  it("callReclaim logs method, contractId, txHash on success", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockReclaimMethod = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-reclaim-hash" },
      }),
    });
    mockFrom.mockResolvedValueOnce({ reclaim: mockReclaimMethod });

    const hash = await callReclaim(contractId, buyerKeypair);
    expect(hash).toBe("tx-reclaim-hash");

    const logged = consoleSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const reclaimLog = logged.find((l) => l.type === "contract_call" && l.method === "reclaim");
    expect(reclaimLog).toBeDefined();
    expect(reclaimLog.contractId).toBe(contractId);
    expect(reclaimLog.txHash).toBe("tx-reclaim-hash");
  });

  it("readOnChainOrder unwraps and formats on-chain order data", async () => {
    const mockGetOrder = vi.fn().mockResolvedValueOnce({
      result: {
        unwrap: () => ({
          buyer: buyerKeypair.publicKey(),
          seller: sellerKeypair.publicKey(),
          attestor: attestorKeypair.publicKey(),
          token: "mock-token",
          amount: 500n,
          deadline: 9999n,
          status: { tag: "Attested" },
        }),
      },
    });
    mockFrom.mockResolvedValueOnce({ get_order: mockGetOrder });

    const order = await readOnChainOrder(contractId);
    expect(order.status).toBe("Attested");
    expect(order.buyer).toBe(buyerKeypair.publicKey());
  });
});
