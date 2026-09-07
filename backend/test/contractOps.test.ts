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
  callRegistryCreateOrder,
  callRegistryAttest,
  callRegistryClaim,
  callRegistryReclaim,
  readOnChainRegistryOrder,
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
      attestors: [attestorKeypair.publicKey()],
      threshold: 1,
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
    expect(mockAttestMethod).toHaveBeenCalledWith({ attestor: attestorKeypair.publicKey() });
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
          attestors: [attestorKeypair.publicKey()],
          threshold: 1,
          confirmations: [attestorKeypair.publicKey()],
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
    expect(order.attestors).toEqual([attestorKeypair.publicKey()]);
  });

  it("callRegistryCreateOrder logs and sends create_order transaction", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockCreateOrder = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-registry-create-hash" },
      }),
    });
    mockFrom.mockResolvedValueOnce({ create_order: mockCreateOrder });

    const hash = await callRegistryCreateOrder(contractId, buyerKeypair, {
      orderId: 101n,
      seller: sellerKeypair.publicKey(),
      attestors: [attestorKeypair.publicKey()],
      threshold: 1,
      amount: 1000n,
      deadline: 123456n,
    });

    expect(hash).toBe("tx-registry-create-hash");
    const logged = consoleSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const regLog = logged.find(
      (l) => l.type === "contract_call" && l.method === "registry_create_order",
    );
    expect(regLog).toBeDefined();
    expect(regLog.orderId).toBe("101");
  });

  it("callRegistryAttest logs and sends attest transaction", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockAttest = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-registry-attest-hash" },
      }),
    });
    mockFrom.mockResolvedValueOnce({ attest: mockAttest });

    const hash = await callRegistryAttest(contractId, attestorKeypair, 101n);
    expect(hash).toBe("tx-registry-attest-hash");
    expect(mockAttest).toHaveBeenCalledWith({
      order_id: 101n,
      attestor: attestorKeypair.publicKey(),
    });
    const logged = consoleSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const regLog = logged.find((l) => l.type === "contract_call" && l.method === "registry_attest");
    expect(regLog).toBeDefined();
    expect(regLog.orderId).toBe("101");
  });

  it("callRegistryClaim logs and sends claim transaction", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockClaim = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-registry-claim-hash" },
      }),
    });
    mockFrom.mockResolvedValueOnce({ claim: mockClaim });

    const hash = await callRegistryClaim(contractId, sellerKeypair, 101n);
    expect(hash).toBe("tx-registry-claim-hash");
    const logged = consoleSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const regLog = logged.find((l) => l.type === "contract_call" && l.method === "registry_claim");
    expect(regLog).toBeDefined();
    expect(regLog.orderId).toBe("101");
  });

  it("callRegistryReclaim logs and sends reclaim transaction", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockReclaim = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-registry-reclaim-hash" },
      }),
    });
    mockFrom.mockResolvedValueOnce({ reclaim: mockReclaim });

    const hash = await callRegistryReclaim(contractId, buyerKeypair, 101n);
    expect(hash).toBe("tx-registry-reclaim-hash");
    const logged = consoleSpy.mock.calls.map((c) => JSON.parse(c[0]));
    const regLog = logged.find(
      (l) => l.type === "contract_call" && l.method === "registry_reclaim",
    );
    expect(regLog).toBeDefined();
    expect(regLog.orderId).toBe("101");
  });

  it("readOnChainRegistryOrder unwraps and returns order with tag", async () => {
    const mockGetOrder = vi.fn().mockResolvedValueOnce({
      result: {
        unwrap: () => ({
          order_id: 101n,
          buyer: buyerKeypair.publicKey(),
          seller: sellerKeypair.publicKey(),
          attestors: [attestorKeypair.publicKey()],
          threshold: 1,
          confirmations: [],
          token: "mock-token",
          amount: 500n,
          deadline: 9999n,
          status: { tag: "Created" },
        }),
      },
    });
    mockFrom.mockResolvedValueOnce({ get_order: mockGetOrder });

    const order = await readOnChainRegistryOrder(contractId, 101n);
    expect(order.status).toBe("Created");
    expect(order.buyer).toBe(buyerKeypair.publicKey());
    expect(order.attestors).toEqual([attestorKeypair.publicKey()]);
  });
});
