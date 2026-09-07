import { describe, expect, it } from "vitest";
import { lifecycleLabel } from "../src/orderService.js";
import type { OrderRow } from "../src/db.js";

describe("Order Lifecycle Mapping (orderService.ts)", () => {
  const baseOrder: OrderRow = {
    id: "order-lifecycle-test",
    contract_id: "contract-test",
    buyer_address: "GBUYER",
    seller_address: "GSELLER",
    attestor_address: "GATTESTOR",
    token_contract_id: "GTOKEN",
    amount: "1000000",
    deadline: Math.floor(Date.now() / 1000) + 3600, // in future
    status: "Created",
    create_tx_hash: "tx-create",
    attest_tx_hash: null,
    claim_tx_hash: null,
    reclaim_tx_hash: null,
    created_at: new Date().toISOString(),
  };

  it("returns 'in-transit' when Created and deadline is in the future", () => {
    expect(lifecycleLabel(baseOrder)).toBe("in-transit");
  });

  it("returns 'deadline-passed' when Created and deadline has elapsed", () => {
    const expiredOrder: OrderRow = {
      ...baseOrder,
      deadline: Math.floor(Date.now() / 1000) - 100, // in past
    };
    expect(lifecycleLabel(expiredOrder)).toBe("deadline-passed");
  });

  it("returns 'delivered/confirmed' when Attested", () => {
    const attestedOrder: OrderRow = {
      ...baseOrder,
      status: "Attested",
    };
    expect(lifecycleLabel(attestedOrder)).toBe("delivered/confirmed");
  });

  it("returns 'claimed' when Claimed", () => {
    const claimedOrder: OrderRow = {
      ...baseOrder,
      status: "Claimed",
    };
    expect(lifecycleLabel(claimedOrder)).toBe("claimed");
  });

  it("returns 'reclaimed' when Reclaimed", () => {
    const reclaimedOrder: OrderRow = {
      ...baseOrder,
      status: "Reclaimed",
    };
    expect(lifecycleLabel(reclaimedOrder)).toBe("reclaimed");
  });

  it("returns 'disputed' when Disputed", () => {
    const disputedOrder: OrderRow = {
      ...baseOrder,
      status: "Disputed",
    };
    expect(lifecycleLabel(disputedOrder)).toBe("disputed");
  });
});
