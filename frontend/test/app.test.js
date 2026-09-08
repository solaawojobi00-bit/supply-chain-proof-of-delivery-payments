import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  getWalletState,
  subscribeWallet,
  connectSimulated,
  disconnectWallet,
  signTransactionClientSide,
} from "../src/wallet.js";
import {
  getOrders,
  getOrder,
  createOrder,
  attestOrder,
  claimOrder,
  submitSignedTx,
  getAttestors,
  getAttestor,
  registerAttestorApi,
} from "../src/api.js";
import {
  renderBuyerOrders,
  renderAttestorOrders,
  renderSellerOrders,
  renderExplorerOrders,
} from "../src/app.js";

describe("Frontend Client & Wallet Integration Test Suite (Issue #16)", () => {
  const buyerAddress =
    "GB6NVEN5HSUBKMYCE5ZOWSK5RPO5RDTBWTJHQ35YKVGFFL3U2NOSVNQI";
  const sellerAddress =
    "GC5H3W256B3QW4A44GAK36XN763K2KRN7O2OESN553TUXW7R6AKN4V6E";
  const attestorAddress =
    "GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI";

  const mockOrder = {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    numericId: 101,
    contractId: "C0000000000000000000000000000000000000000000000000000000",
    buyerAddress,
    sellerAddress,
    attestorAddress,
    amountStroops: "10000000",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    status: "Created",
    lifecycle: "in-transit",
    txHashes: {
      create: "tx-create-hash",
      attest: null,
      claim: null,
    },
  };

  beforeEach(() => {
    disconnectWallet();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    disconnectWallet();
    vi.restoreAllMocks();
  });

  describe("Wallet Integration (wallet.js)", () => {
    it("starts in a disconnected state", () => {
      const state = getWalletState();
      expect(state.connected).toBe(false);
      expect(state.address).toBeNull();
      expect(state.type).toBeNull();
    });

    it("connects simulated keypair via Stellar Public Key", async () => {
      const state = await connectSimulated(buyerAddress);
      expect(state.connected).toBe(true);
      expect(state.address).toBe(buyerAddress);
      expect(state.type).toBe("simulated");
      expect(state.shortAddress).toBe("GB6N...VNQI");
    });

    it("notifies subscribers when wallet state changes", async () => {
      const updates = [];
      const unsubscribe = subscribeWallet((state) =>
        updates.push({ ...state }),
      );

      await connectSimulated(sellerAddress);
      disconnectWallet();
      unsubscribe();

      expect(updates.length).toBeGreaterThanOrEqual(3);
      expect(updates[0].connected).toBe(false);
      expect(updates[1].connected).toBe(true);
      expect(updates[1].address).toBe(sellerAddress);
      expect(updates[2].connected).toBe(false);
    });

    it("rejects invalid key formats", async () => {
      await expect(connectSimulated("invalid-stellar-key")).rejects.toThrow(
        "Key must start with G (Public Key) or S (Secret Key)",
      );
    });

    it("signs transaction client-side without transmitting secret key", async () => {
      await connectSimulated(buyerAddress);
      const unsignedXdr = "AAAAAGmockUnsignedXdrBlob";
      const signed = await signTransactionClientSide(unsignedXdr);
      expect(signed).toContain(unsignedXdr);
      expect(signed).toContain(buyerAddress);
    });

    it("throws when attempting to sign without connected wallet", async () => {
      disconnectWallet();
      await expect(signTransactionClientSide("some-xdr")).rejects.toThrow(
        "Wallet not connected",
      );
    });
  });

  describe("API Client (api.js)", () => {
    it("getOrders filters by role and address via query params", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => [mockOrder],
      });

      const orders = await getOrders({
        role: "buyer",
        address: buyerAddress,
        status: "Created",
      });
      expect(orders).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("role=buyer");
      expect(url).toContain(`address=${encodeURIComponent(buyerAddress)}`);
      expect(url).toContain("status=Created");
      expect(opts.method).toBe("GET");
    });

    it("getOrder fetches single order details", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockOrder,
      });

      const order = await getOrder(mockOrder.id);
      expect(order.id).toBe(mockOrder.id);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/orders/${mockOrder.id}`),
        expect.any(Object),
      );
    });

    it("createOrder executes complete client-side signing flow", async () => {
      await connectSimulated(buyerAddress);

      // 1. POST /orders?unsigned=true returns unsignedTxXdr
      // 2. POST /tx/submit submits signedXdr
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            unsignedTxXdr: "mock-unsigned-xdr",
            order: mockOrder,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            txHash: "tx-submit-hash",
            status: "SUCCESS",
            order: mockOrder,
          }),
        });

      const created = await createOrder({
        buyerAddress,
        sellerAddress,
        attestorAddress,
        amountStroops: "10000000",
        deadlineSeconds: "1735689600",
      });

      expect(created.id).toBe(mockOrder.id);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const [firstUrl] = fetchSpy.mock.calls[0];
      expect(firstUrl).toContain("unsigned=true");

      const [secondUrl, secondOpts] = fetchSpy.mock.calls[1];
      expect(secondUrl).toContain("/tx/submit");
      const submittedBody = JSON.parse(secondOpts.body);
      expect(submittedBody.action).toBe("create");
      expect(submittedBody.signedXdr).toContain("mock-unsigned-xdr");
    });

    it("attestOrder requests unsigned XDR, signs client-side, and submits", async () => {
      await connectSimulated(attestorAddress);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            unsignedTxXdr: "mock-attest-unsigned-xdr",
            orderId: mockOrder.id,
            action: "attest",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            txHash: "tx-attest-hash",
            status: "SUCCESS",
            order: { ...mockOrder, status: "Attested" },
          }),
        });

      const result = await attestOrder(mockOrder.id, {
        attestorAddress,
        roleToken: "mock-attestor-token",
        unsigned: true,
      });

      expect(result.status).toBe("Attested");
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const [firstUrl, firstOpts] = fetchSpy.mock.calls[0];
      expect(firstUrl).toContain(
        `/orders/${mockOrder.id}/attest?unsigned=true`,
      );
      expect(firstOpts.headers["Authorization"]).toBe(
        "Bearer mock-attestor-token",
      );
    });

    it("claimOrder requests unsigned XDR, signs client-side, and submits", async () => {
      await connectSimulated(sellerAddress);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            unsignedTxXdr: "mock-claim-unsigned-xdr",
            orderId: mockOrder.id,
            action: "claim",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            txHash: "tx-claim-hash",
            status: "SUCCESS",
            order: { ...mockOrder, status: "Claimed" },
          }),
        });

      const result = await claimOrder(mockOrder.id, {
        roleToken: "mock-seller-token",
        unsigned: true,
      });

      expect(result.status).toBe("Claimed");
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const [firstUrl, firstOpts] = fetchSpy.mock.calls[0];
      expect(firstUrl).toContain(`/orders/${mockOrder.id}/claim?unsigned=true`);
      expect(firstOpts.headers["Authorization"]).toBe(
        "Bearer mock-seller-token",
      );
    });

    it("getAttestors fetches registered attestors with reputation", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => [
          {
            id: "attestor-1",
            address: attestorAddress,
            name: "Verified Logistics",
            reputation: { reputationScore: 98, totalAttested: 20 },
          },
        ],
      });

      const attestors = await getAttestors({
        coverageArea: "Europe",
        minScore: 90,
      });
      expect(attestors).toHaveLength(1);
      expect(attestors[0].name).toBe("Verified Logistics");
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/attestors?coverageArea=Europe&minScore=90"),
        expect.any(Object),
      );
    });
  });

  describe("UI View Renderers (app.js)", () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="buyer-orders-list"></div>
        <div id="attestor-orders-list"></div>
        <div id="seller-orders-list"></div>
        <div id="explorer-orders-list"></div>
        <div id="toast-container"></div>
        <div id="details-modal" class="modal-overlay">
          <div id="modal-details-body"></div>
        </div>
      `;
    });

    it("renders buyer orders list with status badge and amount", () => {
      renderBuyerOrders([mockOrder]);
      const container = document.getElementById("buyer-orders-list");
      expect(container?.innerHTML).toContain("Order #101");
      expect(container?.innerHTML).toContain("1.00 XLM");
      expect(container?.innerHTML).toContain("Created");
    });

    it("renders empty state when buyer has no orders", () => {
      renderBuyerOrders([]);
      const container = document.getElementById("buyer-orders-list");
      expect(container?.innerHTML).toContain("No Buyer Orders Yet");
    });

    it("renders attestor orders with confirm delivery action button for Created orders", () => {
      renderAttestorOrders([mockOrder]);
      const container = document.getElementById("attestor-orders-list");
      expect(container?.innerHTML).toContain("Confirm Delivery (Sign)");
      expect(container?.querySelector(".btn-attest")).not.toBeNull();
    });

    it("renders seller orders with claim action button for Attested orders", () => {
      const attestedOrder = { ...mockOrder, status: "Attested" };
      renderSellerOrders([attestedOrder]);
      const container = document.getElementById("seller-orders-list");
      expect(container?.innerHTML).toContain("Claim Funds (Sign)");
      expect(container?.querySelector(".btn-claim")).not.toBeNull();
    });

    it("renders explorer view with all orders", () => {
      renderExplorerOrders([mockOrder]);
      const container = document.getElementById("explorer-orders-list");
      expect(container?.innerHTML).toContain("Inspect Full State");
    });
  });
});
