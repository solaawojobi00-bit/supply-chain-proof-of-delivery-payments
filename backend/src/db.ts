import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

export type OrderStatus = "Created" | "Attested" | "Claimed" | "Reclaimed";

export interface OrderRow {
  id: string;
  contract_id: string;
  buyer_address: string;
  seller_address: string;
  attestor_address: string;
  token_contract_id: string;
  amount: string;
  deadline: number;
  status: OrderStatus;
  create_tx_hash: string | null;
  attest_tx_hash: string | null;
  claim_tx_hash: string | null;
  reclaim_tx_hash: string | null;
  created_at: string;
}

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    buyer_address TEXT NOT NULL,
    seller_address TEXT NOT NULL,
    attestor_address TEXT NOT NULL,
    token_contract_id TEXT NOT NULL,
    amount TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    status TEXT NOT NULL,
    create_tx_hash TEXT,
    attest_tx_hash TEXT,
    claim_tx_hash TEXT,
    reclaim_tx_hash TEXT,
    created_at TEXT NOT NULL
  )
`);

export function insertOrder(row: OrderRow): void {
  db.prepare(
    `INSERT INTO orders (
      id, contract_id, buyer_address, seller_address, attestor_address,
      token_contract_id, amount, deadline, status,
      create_tx_hash, attest_tx_hash, claim_tx_hash, reclaim_tx_hash, created_at
    ) VALUES (
      @id, @contract_id, @buyer_address, @seller_address, @attestor_address,
      @token_contract_id, @amount, @deadline, @status,
      @create_tx_hash, @attest_tx_hash, @claim_tx_hash, @reclaim_tx_hash, @created_at
    )`,
  ).run(row);
}

export function getOrder(id: string): OrderRow | undefined {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
}

export function listOrders(): OrderRow[] {
  return db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all() as OrderRow[];
}

export function updateOrderStatus(
  id: string,
  status: OrderStatus,
  txHashColumn: "attest_tx_hash" | "claim_tx_hash" | "reclaim_tx_hash",
  txHash: string,
): void {
  db.prepare(`UPDATE orders SET status = ?, ${txHashColumn} = ? WHERE id = ?`).run(status, txHash, id);
}
