import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

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

export function listOrders(): OrderRow[] {
  return db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all() as OrderRow[];
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
