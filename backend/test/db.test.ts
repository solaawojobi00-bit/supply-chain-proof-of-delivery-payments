import { describe, expect, it } from "vitest";
import {
  getOrder,
  getOrderByIdempotencyKey,
  insertOrder,
  listOrders,
  queryOrders,
  updateOrderStatus,
  type OrderRow,
} from "../src/db.js";

function makeRow(overrides: Partial<OrderRow> & Pick<OrderRow, "id">): OrderRow {
  return {
    contract_id: "contract-generic",
    buyer_address: "GBUYER123",
    seller_address: "GSELLER123",
    attestor_address: "GATTESTOR123",
    token_contract_id: "GTOKEN123",
    amount: "10000000",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    status: "Created",
    create_tx_hash: null,
    attest_tx_hash: null,
    claim_tx_hash: null,
    reclaim_tx_hash: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("Database Operations (db.ts)", () => {
  it("inserts and retrieves an order by id", async () => {
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

    await insertOrder(row);
    const retrieved = await getOrder("test-order-1");
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("test-order-1");
    expect(retrieved?.contract_id).toBe("contract-123");
    expect(retrieved?.status).toBe("Created");
  });

  it("returns undefined for nonexistent order id", async () => {
    const nonexistent = await getOrder("does-not-exist");
    expect(nonexistent).toBeUndefined();
  });

  it("lists all orders in descending order of created_at", async () => {
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

    await insertOrder(row2);
    const orders = await listOrders();
    expect(orders.length).toBeGreaterThanOrEqual(2);
    expect(orders[0].id).toBe("test-order-2");
  });

  it("updates order status and transaction hash", async () => {
    await updateOrderStatus("test-order-1", "Attested", "attest_tx_hash", "tx-attest-1");
    const updated = await getOrder("test-order-1");
    expect(updated?.status).toBe("Attested");
    expect(updated?.attest_tx_hash).toBe("tx-attest-1");

    await updateOrderStatus("test-order-1", "Claimed", "claim_tx_hash", "tx-claim-1");
    const claimed = await getOrder("test-order-1");
    expect(claimed?.status).toBe("Claimed");
    expect(claimed?.claim_tx_hash).toBe("tx-claim-1");

    await updateOrderStatus("test-order-1", "Disputed", "dispute_tx_hash", "tx-dispute-1");
    const disputed = await getOrder("test-order-1");
    expect(disputed?.status).toBe("Disputed");
    expect(disputed?.dispute_tx_hash).toBe("tx-dispute-1");

    await updateOrderStatus("test-order-1", "Claimed", "resolve_tx_hash", "tx-resolve-1");
    const resolved = await getOrder("test-order-1");
    expect(resolved?.status).toBe("Claimed");
    expect(resolved?.resolve_tx_hash).toBe("tx-resolve-1");
  });

  it("stores and retrieves order by idempotency_key", async () => {
    const rowIdemp: OrderRow = {
      id: "test-order-idemp",
      contract_id: "contract-idemp",
      buyer_address: "GBUYER123",
      seller_address: "GSELLER123",
      attestor_address: "GATTESTOR123",
      arbiter_address: "GARBITER123",
      token_contract_id: "GTOKEN123",
      amount: "30000000",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      status: "Created",
      create_tx_hash: "tx-create-idemp",
      attest_tx_hash: null,
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      dispute_tx_hash: null,
      resolve_tx_hash: null,
      idempotency_key: "test-uuid-idem-001",
      request_payload: JSON.stringify({ amount: "30000000" }),
      created_at: new Date().toISOString(),
    };

    await insertOrder(rowIdemp);
    const retrieved = await getOrderByIdempotencyKey("test-uuid-idem-001");
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("test-order-idemp");
    expect(retrieved?.arbiter_address).toBe("GARBITER123");
    expect(retrieved?.idempotency_key).toBe("test-uuid-idem-001");
    expect(retrieved?.request_payload).toBe(JSON.stringify({ amount: "30000000" }));

    const nonexistent = await getOrderByIdempotencyKey("non-existent-token");
    expect(nonexistent).toBeUndefined();
  });

  // The driver may hand back 64-bit columns as strings or BigInt. Both would
  // break `Date.now() / 1000 >= order.deadline` in orderService silently, so the
  // representation is pinned here rather than assumed.
  it("returns integer columns as JS numbers within safe-integer range", async () => {
    // Same magnitude as a real numeric_id (Date.now() * 1000 + rand).
    const numericId = 1_757_000_000_000_000;
    const deadline = 1_893_456_000;
    await insertOrder(
      makeRow({ id: "test-order-ints", numeric_id: numericId, deadline, status: "Created" }),
    );

    const retrieved = await getOrder("test-order-ints");
    expect(typeof retrieved?.numeric_id).toBe("number");
    expect(retrieved?.numeric_id).toBe(numericId);
    expect(typeof retrieved?.deadline).toBe("number");
    expect(retrieved?.deadline).toBe(deadline);
    expect(numericId).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  // Keyset pagination compares `id` in the cursor predicate and in ORDER BY.
  // If those two ever disagree on collation, pages silently skip or repeat rows.
  // Punctuated ids sharing one created_at force the id tiebreaker on every page.
  it("paginates without gaps or duplicates when ids contain punctuation", async () => {
    const buyer = "GPAGINATIONCOLLATION";
    const createdAt = "2026-01-01T00:00:00.000Z";
    const ids = ["ord-1", "ord1", "ORD-2", "ord_3", "ord.4", "ord-10"];
    for (const id of ids) {
      await insertOrder(makeRow({ id, buyer_address: buyer, created_at: createdAt }));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ids.length + 2; page++) {
      const result = await queryOrders({ buyer, limit: 2, cursor });
      seen.push(...result.orders.map((o) => o.id));
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
    // Pages must arrive in the same total order a single unpaginated query gives.
    const unpaged = await queryOrders({ buyer, limit: 200 });
    expect(seen).toEqual(unpaged.orders.map((o) => o.id));
  });
});
