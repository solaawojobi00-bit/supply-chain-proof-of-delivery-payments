import { createClient, type Client, type InValue } from "@libsql/client";
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

/**
 * Accepts either a libSQL URL (libsql://, https://, file:, ws://) or a bare
 * filesystem path, so existing DB_PATH values keep working unchanged.
 */
export function toLibsqlUrl(raw: string): string {
  if (raw === ":memory:") return raw;
  if (/^(libsql|https?|wss?|file):/.test(raw)) return raw;
  return `file:${raw}`;
}

function createDbClient(): Client {
  const url = toLibsqlUrl(config.databaseUrl);
  // Local file databases need their parent directory to exist; remote and
  // in-memory URLs have no directory to create.
  if (url.startsWith("file:")) {
    mkdirSync(dirname(url.slice("file:".length)), { recursive: true });
  }
  return createClient({
    url,
    ...(config.databaseAuthToken ? { authToken: config.databaseAuthToken } : {}),
  });
}

export const db: Client = createDbClient();

const ORDERS_TABLE = `
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
`;

/**
 * Additive column migrations for databases created before each column existed.
 * Every one of these is also present in ORDERS_TABLE, so on a fresh database
 * they all fail with "duplicate column name" and are skipped.
 */
const ORDERS_ADDED_COLUMNS = [
  `idempotency_key TEXT UNIQUE`,
  `request_payload TEXT`,
  `numeric_id INTEGER`,
  `cancel_tx_hash TEXT`,
  `attestors TEXT`,
  `threshold INTEGER DEFAULT 1`,
  `confirmations TEXT DEFAULT '[]'`,
  `arbiter_address TEXT`,
  `dispute_tx_hash TEXT`,
  `resolve_tx_hash TEXT`,
  `buyer_token TEXT`,
  `seller_token TEXT`,
  `attestor_token TEXT`,
  `arbiter_token TEXT`,
  `webhook_url TEXT`,
  `evidence_hash TEXT`,
];

const ORDERS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_address)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_address)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_attestor ON orders(attestor_address)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created_at_id ON orders(created_at DESC, id DESC)`,
];

const ATTESTOR_DIRECTORY_TABLE = `
  CREATE TABLE IF NOT EXISTS attestor_directory (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    coverage_area TEXT,
    fee_bps INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const ATTESTOR_DIRECTORY_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_attestor_directory_address ON attestor_directory (address)`,
];

let schemaReady: Promise<void> | undefined;

async function runSchema(): Promise<void> {
  await db.execute(ORDERS_TABLE);
  for (const column of ORDERS_ADDED_COLUMNS) {
    try {
      await db.execute(`ALTER TABLE orders ADD COLUMN ${column}`);
    } catch {
      // column already exists
    }
  }
  for (const statement of ORDERS_INDEXES) {
    await db.execute(statement);
  }

  await db.execute(ATTESTOR_DIRECTORY_TABLE);
  for (const statement of ATTESTOR_DIRECTORY_INDEXES) {
    await db.execute(statement);
  }
}

/**
 * Creates tables and indexes. Idempotent, and safe to call concurrently — the
 * first caller's promise is reused so the DDL runs exactly once per process.
 */
export function initSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = runSchema();
  }
  return schemaReady;
}

type NamedArgs = Record<string, InValue>;

async function selectRows<T>(sql: string, args?: NamedArgs | InValue[]): Promise<T[]> {
  const result = await db.execute(args === undefined ? sql : { sql, args });
  return result.rows as unknown as T[];
}

async function selectOne<T>(sql: string, args: NamedArgs | InValue[]): Promise<T | undefined> {
  const rows = await selectRows<T>(sql, args);
  return rows[0];
}

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

export async function insertOrder(row: OrderRow): Promise<void> {
  await db.execute({
    sql: `INSERT INTO orders (
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
    args: {
      id: row.id,
      contract_id: row.contract_id,
      numeric_id: row.numeric_id ?? null,
      buyer_address: row.buyer_address,
      seller_address: row.seller_address,
      attestor_address: row.attestor_address,
      attestors: row.attestors ?? null,
      threshold: row.threshold ?? 1,
      confirmations: row.confirmations ?? "[]",
      arbiter_address: row.arbiter_address ?? null,
      token_contract_id: row.token_contract_id,
      amount: row.amount,
      deadline: row.deadline,
      status: row.status,
      evidence_hash: row.evidence_hash ?? null,
      create_tx_hash: row.create_tx_hash ?? null,
      attest_tx_hash: row.attest_tx_hash ?? null,
      claim_tx_hash: row.claim_tx_hash ?? null,
      reclaim_tx_hash: row.reclaim_tx_hash ?? null,
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
      created_at: row.created_at,
    },
  });
}

export async function getOrder(id: string): Promise<OrderRow | undefined> {
  return selectOne<OrderRow>(`SELECT * FROM orders WHERE id = ?`, [id]);
}

export async function getOrderByIdempotencyKey(key: string): Promise<OrderRow | undefined> {
  return selectOne<OrderRow>(`SELECT * FROM orders WHERE idempotency_key = ?`, [key]);
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

export async function queryOrders(options: ListOrdersOptions = {}): Promise<PaginatedOrdersResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const whereClauses: string[] = [];
  const params: NamedArgs = {};

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
  // Fetch one extra row to detect whether a further page exists.
  params.limit = limit + 1;
  const sql = `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC, id DESC LIMIT @limit`;

  const rows = await selectRows<OrderRow>(sql, params);

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

export async function listOrders(): Promise<OrderRow[]> {
  return selectRows<OrderRow>(`SELECT * FROM orders ORDER BY created_at DESC, id DESC`);
}

export async function updateOrderStatus(
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
): Promise<void> {
  await db.execute({
    sql: `UPDATE orders SET status = ?, ${txHashColumn} = ? WHERE id = ?`,
    args: [status, txHash, id],
  });
}

export async function updateOrderDispute(
  id: string,
  status: OrderStatus,
  disputeTxHash: string,
  evidenceHash?: string | null,
): Promise<void> {
  await db.execute({
    sql: `UPDATE orders SET status = ?, dispute_tx_hash = ?, evidence_hash = ? WHERE id = ?`,
    args: [status, disputeTxHash, evidenceHash ?? null, id],
  });
}

/**
 * Records an attestation and its resulting status in a single statement, so a
 * concurrent write cannot land between the confirmations and status updates.
 */
export async function updateOrderAttestation(
  id: string,
  status: OrderStatus,
  confirmations: string[],
  attestTxHash: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE orders SET status = ?, confirmations = ?, attest_tx_hash = ? WHERE id = ?`,
    args: [status, JSON.stringify(confirmations), attestTxHash, id],
  });
}
