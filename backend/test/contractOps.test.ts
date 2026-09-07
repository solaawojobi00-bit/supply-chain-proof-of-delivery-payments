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
  callDispute,
  callResolveDispute,
  readOnChainOrder,
  callRegistryCreateOrder,
  callRegistryAttest,
  callRegistryClaim,
  callRegistryReclaim,
  callRegistryDispute,
  callRegistryResolveDispute,
  readOnChainRegistryOrder,
  buildUnsignedCreateTx,
  buildUnsignedAttestTx,
  buildUnsignedClaimTx,
  buildUnsignedReclaimTx,
  buildUnsignedCancelTx,
  buildUnsignedDisputeTx,
  buildUnsignedResolveTx,
  buildRegistryUnsignedCreateTx,
  buildRegistryUnsignedAttestTx,
  buildRegistryUnsignedClaimTx,
  buildRegistryUnsignedReclaimTx,
  buildRegistryUnsignedCancelTx,
  buildRegistryUnsignedDisputeTx,
  buildRegistryUnsignedResolveTx,
} from "../src/contractOps.js";

describe("Contract Operations with Logging (contractOps.ts)", () => {
  const buyerKeypair = Keypair.random();
  const sellerKeypair = Keypair.random();
  const attestorKeypair = Keypair.random();
  const arbiterKeypair = Keypair.random();
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
      arbiter: arbiterKeypair.publicKey(),
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

  it("callDispute and callResolveDispute log and send dispute transactions", async () => {
    const _consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockDisputeMethod = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-dispute-hash" },
      }),
    });
    const mockResolveMethod = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-resolve-hash" },
      }),
    });
    mockFrom
      .mockResolvedValueOnce({ dispute: mockDisputeMethod })
      .mockResolvedValueOnce({ resolve_dispute: mockResolveMethod });

    const disputeHash = await callDispute(contractId, buyerKeypair);
    expect(disputeHash).toBe("tx-dispute-hash");

    const resolveHash = await callResolveDispute(contractId, arbiterKeypair, true);
    expect(resolveHash).toBe("tx-resolve-hash");
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
          arbiter: arbiterKeypair.publicKey(),
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
      arbiter: arbiterKeypair.publicKey(),
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

  it("callRegistryDispute and callRegistryResolveDispute log and send dispute transactions", async () => {
    const mockDispute = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-reg-dispute-hash" },
      }),
    });
    const mockResolve = vi.fn().mockResolvedValueOnce({
      signAndSend: vi.fn().mockResolvedValueOnce({
        result: { unwrap: () => null },
        sendTransactionResponse: { hash: "tx-reg-resolve-hash" },
      }),
    });
    mockFrom
      .mockResolvedValueOnce({ dispute: mockDispute })
      .mockResolvedValueOnce({ resolve_dispute: mockResolve });

    const disHash = await callRegistryDispute(contractId, buyerKeypair, 101n);
    expect(disHash).toBe("tx-reg-dispute-hash");

    const resHash = await callRegistryResolveDispute(contractId, arbiterKeypair, 101n, false);
    expect(resHash).toBe("tx-reg-resolve-hash");
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
          arbiter: arbiterKeypair.publicKey(),
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

  describe("Unsigned Transaction Builders (SEP-43 / Wallet-Signing)", () => {
    it("builds unsigned transaction XDR for escrow contract operations", async () => {
      const mockToXDR = vi.fn().mockReturnValue("mock-unsigned-xdr");
      mockFrom.mockResolvedValue({
        create: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        attest: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        claim: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        reclaim: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        cancel: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        dispute: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        resolve_dispute: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
      });

      const createXdr = await buildUnsignedCreateTx(contractId, buyerKeypair.publicKey(), {
        seller: sellerKeypair.publicKey(),
        attestors: [attestorKeypair.publicKey()],
        amount: 100n,
        deadline: 9999n,
      });
      expect(createXdr).toBe("mock-unsigned-xdr");

      const attestXdr = await buildUnsignedAttestTx(contractId, attestorKeypair.publicKey());
      expect(attestXdr).toBe("mock-unsigned-xdr");

      const claimXdr = await buildUnsignedClaimTx(contractId, sellerKeypair.publicKey());
      expect(claimXdr).toBe("mock-unsigned-xdr");

      const reclaimXdr = await buildUnsignedReclaimTx(contractId, buyerKeypair.publicKey());
      expect(reclaimXdr).toBe("mock-unsigned-xdr");

      const cancelXdr = await buildUnsignedCancelTx(contractId, buyerKeypair.publicKey());
      expect(cancelXdr).toBe("mock-unsigned-xdr");

      const disputeXdr = await buildUnsignedDisputeTx(contractId, buyerKeypair.publicKey());
      expect(disputeXdr).toBe("mock-unsigned-xdr");

      const resolveXdr = await buildUnsignedResolveTx(contractId, arbiterKeypair.publicKey(), true);
      expect(resolveXdr).toBe("mock-unsigned-xdr");
    });

    it("builds unsigned transaction XDR for registry contract operations", async () => {
      const mockToXDR = vi.fn().mockReturnValue("mock-registry-unsigned-xdr");
      mockFrom.mockResolvedValue({
        create_order: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        attest: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        claim: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        reclaim: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        cancel: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        dispute: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
        resolve_dispute: vi.fn().mockResolvedValue({ toXDR: mockToXDR }),
      });

      const createXdr = await buildRegistryUnsignedCreateTx(contractId, buyerKeypair.publicKey(), {
        orderId: 102n,
        seller: sellerKeypair.publicKey(),
        attestors: [attestorKeypair.publicKey()],
        amount: 100n,
        deadline: 9999n,
      });
      expect(createXdr).toBe("mock-registry-unsigned-xdr");

      const attestXdr = await buildRegistryUnsignedAttestTx(
        contractId,
        attestorKeypair.publicKey(),
        102n,
      );
      expect(attestXdr).toBe("mock-registry-unsigned-xdr");

      const claimXdr = await buildRegistryUnsignedClaimTx(
        contractId,
        sellerKeypair.publicKey(),
        102n,
      );
      expect(claimXdr).toBe("mock-registry-unsigned-xdr");

      const reclaimXdr = await buildRegistryUnsignedReclaimTx(
        contractId,
        buyerKeypair.publicKey(),
        102n,
      );
      expect(reclaimXdr).toBe("mock-registry-unsigned-xdr");

      const cancelXdr = await buildRegistryUnsignedCancelTx(
        contractId,
        buyerKeypair.publicKey(),
        102n,
      );
      expect(cancelXdr).toBe("mock-registry-unsigned-xdr");

      const disputeXdr = await buildRegistryUnsignedDisputeTx(
        contractId,
        buyerKeypair.publicKey(),
        102n,
      );
      expect(disputeXdr).toBe("mock-registry-unsigned-xdr");

      const resolveXdr = await buildRegistryUnsignedResolveTx(
        contractId,
        arbiterKeypair.publicKey(),
        102n,
        false,
      );
      expect(resolveXdr).toBe("mock-registry-unsigned-xdr");
    });
  });
});
