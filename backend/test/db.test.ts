import { describe, expect, it } from "vitest";
import { db, getOrder, insertOrder, listOrders, updateOrderStatus, type OrderRow } from "../src/db.js";

describe("Database Operations (db.ts)", () => {
  it("inserts and retrieves an order by id", () => {
    const row: OrderRow = {
      id: "test-order-1",
      contract_id: "contract-123",
      buyer_address: "GBUYER123",
      seller_address: "GSELLER123",
      attestor_address: "GATTESTOR123",
      token_contract_id: "GTOKEN123",
      amount: "10000000",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      status: "Created",
      create_tx_hash: "tx-create-1",
      attest_tx_hash: null,
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      created_at: new Date().toISOString(),
    };

    insertOrder(row);
    const retrieved = getOrder("test-order-1");
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("test-order-1");
    expect(retrieved?.contract_id).toBe("contract-123");
    expect(retrieved?.status).toBe("Created");
  });

  it("returns undefined for nonexistent order id", () => {
    const nonexistent = getOrder("does-not-exist");
    expect(nonexistent).toBeUndefined();
  });

  it("lists all orders in descending order of created_at", () => {
    const row2: OrderRow = {
      id: "test-order-2",
      contract_id: "contract-456",
      buyer_address: "GBUYER123",
      seller_address: "GSELLER123",
      attestor_address: "GATTESTOR123",
      token_contract_id: "GTOKEN123",
      amount: "20000000",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      status: "Created",
      create_tx_hash: "tx-create-2",
      attest_tx_hash: null,
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      created_at: new Date(Date.now() + 1000).toISOString(),
    };

    insertOrder(row2);
    const orders = listOrders();
    expect(orders.length).toBeGreaterThanOrEqual(2);
    expect(orders[0].id).toBe("test-order-2");
  });

  it("updates order status and transaction hash", () => {
    updateOrderStatus("test-order-1", "Attested", "attest_tx_hash", "tx-attest-1");
    const updated = getOrder("test-order-1");
    expect(updated?.status).toBe("Attested");
    expect(updated?.attest_tx_hash).toBe("tx-attest-1");

    updateOrderStatus("test-order-1", "Claimed", "claim_tx_hash", "tx-claim-1");
    const claimed = getOrder("test-order-1");
    expect(claimed?.status).toBe("Claimed");
    expect(claimed?.claim_tx_hash).toBe("tx-claim-1");
  });
});
