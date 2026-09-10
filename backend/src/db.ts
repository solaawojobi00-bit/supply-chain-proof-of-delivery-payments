import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { HttpError } from "./httpError.js";

export type OrderStatus =
  "Created" | "Attested" | "Claimed" | "Reclaimed" | "Cancelled" | "Disputed";

export interface OrderRow {
  id: string;
  contract_id: string;
  numeric_id?: number | null;
  buyer_address: string;
  seller_address: string;
  attestor_address: string;
  attestors?: string | null;
  threshold?: number | null;
  confirmations?: string | null;
  arbiter_address?: string | null;
  token_contract_id: string;
  amount: string;
  deadline: number;
  status: OrderStatus;
  evidence_hash?: string | null;
  create_tx_hash: string | null;
  attest_tx_hash: string | null;
  claim_tx_hash: string | null;
  reclaim_tx_hash: string | null;
  cancel_tx_hash?: string | null;
  dispute_tx_hash?: string | null;
  resolve_tx_hash?: string | null;
  buyer_token?: string | null;
  seller_token?: string | null;
  attestor_token?: string | null;
  arbiter_token?: string | null;
  webhook_url?: string | null;
  idempotency_key?: string | null;
  request_payload?: string | null;
  created_at: string;
}

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    numeric_id INTEGER,
    buyer_address TEXT NOT NULL,
    seller_address TEXT NOT NULL,
    attestor_address TEXT NOT NULL,
    attestors TEXT,
    threshold INTEGER DEFAULT 1,
    confirmations TEXT DEFAULT '[]',
    arbiter_address TEXT,
    token_contract_id TEXT NOT NULL,
    amount TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    status TEXT NOT NULL,
    evidence_hash TEXT,
    create_tx_hash TEXT,
    attest_tx_hash TEXT,
    claim_tx_hash TEXT,
    reclaim_tx_hash TEXT,
    cancel_tx_hash TEXT,
    dispute_tx_hash TEXT,
    resolve_tx_hash TEXT,
    buyer_token TEXT,
    seller_token TEXT,
    attestor_token TEXT,
    arbiter_token TEXT,
    webhook_url TEXT,
    idempotency_key TEXT UNIQUE,
    request_payload TEXT,
    created_at TEXT NOT NULL
  )
`);

try {
  db.exec(`ALTER TABLE orders ADD COLUMN idempotency_key TEXT UNIQUE`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN request_payload TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN numeric_id INTEGER`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN cancel_tx_hash TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN attestors TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN threshold INTEGER DEFAULT 1`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN confirmations TEXT DEFAULT '[]'`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN arbiter_address TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN dispute_tx_hash TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN resolve_tx_hash TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN buyer_token TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN seller_token TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN attestor_token TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN arbiter_token TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN webhook_url TEXT`);
} catch {
  // column already exists
}

try {
  db.exec(`ALTER TABLE orders ADD COLUMN evidence_hash TEXT`);
} catch {
  // column already exists
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_address);
  CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_address);
  CREATE INDEX IF NOT EXISTS idx_orders_attestor ON orders(attestor_address);
  CREATE INDEX IF NOT EXISTS idx_orders_created_at_id ON orders(created_at DESC, id DESC);
`);

export interface OrderCursor {
  createdAt: string;
  id: string;
}

export function encodeOrderCursor(row: Pick<OrderRow, "created_at" | "id">): string {
  const payload = JSON.stringify({ createdAt: row.created_at, id: row.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeOrderCursor(cursorStr: string): OrderCursor {
  try {
    const json = Buffer.from(cursorStr, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string"
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // fallback to throwing HttpError 400
  }
  throw new HttpError(400, "Invalid pagination cursor format");
}

export function insertOrder(row: OrderRow): void {
  db.prepare(
    `INSERT INTO orders (
      id, contract_id, numeric_id, buyer_address, seller_address, attestor_address,
      attestors, threshold, confirmations, arbiter_address,
      token_contract_id, amount, deadline, status, evidence_hash,
      create_tx_hash, attest_tx_hash, claim_tx_hash, reclaim_tx_hash, cancel_tx_hash,
      dispute_tx_hash, resolve_tx_hash,
      buyer_token, seller_token, attestor_token, arbiter_token,
      webhook_url,
      idempotency_key, request_payload, created_at
    ) VALUES (
      @id, @contract_id, @numeric_id, @buyer_address, @seller_address, @attestor_address,
      @attestors, @threshold, @confirmations, @arbiter_address,
      @token_contract_id, @amount, @deadline, @status, @evidence_hash,
      @create_tx_hash, @attest_tx_hash, @claim_tx_hash, @reclaim_tx_hash, @cancel_tx_hash,
      @dispute_tx_hash, @resolve_tx_hash,
      @buyer_token, @seller_token, @attestor_token, @arbiter_token,
      @webhook_url,
      @idempotency_key, @request_payload, @created_at
    )`,
  ).run({
    ...row,
    numeric_id: row.numeric_id ?? null,
    attestors: row.attestors ?? null,
    threshold: row.threshold ?? 1,
    confirmations: row.confirmations ?? "[]",
    arbiter_address: row.arbiter_address ?? null,
    evidence_hash: row.evidence_hash ?? null,
    cancel_tx_hash: row.cancel_tx_hash ?? null,
    dispute_tx_hash: row.dispute_tx_hash ?? null,
    resolve_tx_hash: row.resolve_tx_hash ?? null,
    buyer_token: row.buyer_token ?? null,
    seller_token: row.seller_token ?? null,
    attestor_token: row.attestor_token ?? null,
    arbiter_token: row.arbiter_token ?? null,
    webhook_url: row.webhook_url ?? null,
    idempotency_key: row.idempotency_key ?? null,
    request_payload: row.request_payload ?? null,
  });
}

export function getOrder(id: string): OrderRow | undefined {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
}

export function getOrderByIdempotencyKey(key: string): OrderRow | undefined {
  return db.prepare(`SELECT * FROM orders WHERE idempotency_key = ?`).get(key) as
    OrderRow | undefined;
}

export interface ListOrdersOptions {
  status?: string[];
  buyer?: string;
  seller?: string;
  attestor?: string;
  arbiter?: string;
  role?: "buyer" | "seller" | "attestor" | "arbiter";
  address?: string;
  limit?: number;
  cursor?: string;
}

export interface PaginatedOrdersResult {
  orders: OrderRow[];
  next_cursor: string | null;
}

export function queryOrders(options: ListOrdersOptions = {}): PaginatedOrdersResult {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const whereClauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.status && options.status.length > 0) {
    const statusPlaceholders = options.status.map((_, i) => `@status_${i}`);
    options.status.forEach((st, i) => {
      params[`status_${i}`] = st.toLowerCase();
    });
    whereClauses.push(`LOWER(status) IN (${statusPlaceholders.join(", ")})`);
  }

  if (options.buyer) {
    whereClauses.push(`buyer_address = @buyer`);
    params.buyer = options.buyer;
  }

  if (options.seller) {
    whereClauses.push(`seller_address = @seller`);
    params.seller = options.seller;
  }

  if (options.attestor) {
    whereClauses.push(`(attestor_address = @attestor OR attestors LIKE '%' || @attestor || '%')`);
    params.attestor = options.attestor;
  }

  if (options.arbiter) {
    whereClauses.push(`arbiter_address = @arbiter`);
    params.arbiter = options.arbiter;
  }

  if (options.role && options.address) {
    if (options.role === "buyer") {
      whereClauses.push(`buyer_address = @role_addr`);
      params.role_addr = options.address;
    } else if (options.role === "seller") {
      whereClauses.push(`seller_address = @role_addr`);
      params.role_addr = options.address;
    } else if (options.role === "attestor") {
      whereClauses.push(
        `(attestor_address = @role_addr OR attestors LIKE '%' || @role_addr || '%')`,
      );
      params.role_addr = options.address;
    } else if (options.role === "arbiter") {
      whereClauses.push(`arbiter_address = @role_addr`);
      params.role_addr = options.address;
    }
  } else if (options.address) {
    whereClauses.push(
      `(buyer_address = @addr OR seller_address = @addr OR attestor_address = @addr OR arbiter_address = @addr OR attestors LIKE '%' || @addr || '%')`,
    );
    params.addr = options.address;
  }

  if (options.cursor) {
    const cursor = decodeOrderCursor(options.cursor);
    whereClauses.push(
      `(created_at < @cursor_created_at OR (created_at = @cursor_created_at AND id < @cursor_id))`,
    );
    params.cursor_created_at = cursor.createdAt;
    params.cursor_id = cursor.id;
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;

  const rows = db.prepare(sql).all(params) as OrderRow[];

  let next_cursor: string | null = null;
  let resultOrders = rows;

  if (rows.length > limit) {
    resultOrders = rows.slice(0, limit);
    const lastItem = resultOrders[resultOrders.length - 1];
    next_cursor = encodeOrderCursor(lastItem);
  }

  return {
    orders: resultOrders,
    next_cursor,
  };
}

export function listOrders(): OrderRow[] {
  return db.prepare(`SELECT * FROM orders ORDER BY created_at DESC, id DESC`).all() as OrderRow[];
}

export function updateOrderStatus(
  id: string,
  status: OrderStatus,
  txHashColumn:
    | "attest_tx_hash"
    | "claim_tx_hash"
    | "reclaim_tx_hash"
    | "cancel_tx_hash"
    | "dispute_tx_hash"
    | "resolve_tx_hash",
  txHash: string,
): void {
  db.prepare(`UPDATE orders SET status = ?, ${txHashColumn} = ? WHERE id = ?`).run(
    status,
    txHash,
    id,
  );
}

export function updateOrderDispute(
  id: string,
  status: OrderStatus,
  disputeTxHash: string,
  evidenceHash?: string | null,
): void {
  db.prepare(
    `UPDATE orders SET status = ?, dispute_tx_hash = ?, evidence_hash = ? WHERE id = ?`,
  ).run(status, disputeTxHash, evidenceHash ?? null, id);
}

export function updateOrderAttestation(
  id: string,
  status: OrderStatus,
  confirmations: string[],
  attestTxHash: string,
): void {
  db.prepare(
    `UPDATE orders SET status = ?, confirmations = ?, attest_tx_hash = ? WHERE id = ?`,
  ).run(status, JSON.stringify(confirmations), attestTxHash, id);
}
