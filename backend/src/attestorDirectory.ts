import { randomUUID } from "node:crypto";
import { db } from "./db.js";

export interface AttestorRow {
  id: string;
  address: string;
  name: string;
  description: string | null;
  coverage_area: string | null;
  fee_bps: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface AttestorReputationSummary {
  totalAssigned: number;
  totalAttested: number;
  successfulClaims: number;
  reclaimedAfterExpiry: number;
  disputedOrders: number;
  resolvedDisputes: number;
  successRate: number; // 0.0 to 1.0
  disputeRate: number; // 0.0 to 1.0
  reputationScore: number; // 0 to 100
}

export interface AttestorWithReputation {
  id: string;
  address: string;
  name: string;
  description: string | null;
  coverageArea: string | null;
  feeBps: number;
  active: boolean;
  reputation: AttestorReputationSummary;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterAttestorInput {
  address: string;
  name: string;
  description?: string;
  coverageArea?: string;
  feeBps?: number;
}

export interface UpdateAttestorInput {
  name?: string;
  description?: string;
  coverageArea?: string;
  feeBps?: number;
  active?: boolean;
}

// Ensure database table exists
db.exec(`
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
  );
  CREATE INDEX IF NOT EXISTS idx_attestor_directory_address ON attestor_directory (address);
`);

/**
 * Derives dynamic reputation statistics from real order history in the `orders` table.
 * Reputation is calculated purely from actual contract execution events, never self-reported.
 */
export function computeReputationForAddress(address: string): AttestorReputationSummary {
  // Query all orders where this address was the primary attestor or part of multi-attestor array
  const rows = db
    .prepare(
      `SELECT status, attestors, confirmations, dispute_tx_hash, resolve_tx_hash 
       FROM orders 
       WHERE attestor_address = ? OR attestors LIKE ?`,
    )
    .all(address, `%"${address}"%`) as Array<{
    status: string;
    attestors: string | null;
    confirmations: string | null;
    dispute_tx_hash: string | null;
    resolve_tx_hash: string | null;
  }>;

  const totalAssigned = rows.length;
  let totalAttested = 0;
  let successfulClaims = 0;
  let reclaimedAfterExpiry = 0;
  let disputedOrders = 0;
  let resolvedDisputes = 0;

  for (const row of rows) {
    const isAttestedStatus = row.status === "Attested" || row.status === "Claimed";
    let confirmedByThisAttestor = false;

    if (row.confirmations) {
      try {
        const confList = JSON.parse(row.confirmations);
        if (Array.isArray(confList) && confList.includes(address)) {
          confirmedByThisAttestor = true;
        }
      } catch {
        // ignore json parse error
      }
    }

    if (isAttestedStatus || confirmedByThisAttestor) {
      totalAttested++;
    }

    if (row.status === "Claimed") {
      successfulClaims++;
    } else if (row.status === "Reclaimed") {
      reclaimedAfterExpiry++;
    }

    if (row.status === "Disputed" || row.dispute_tx_hash) {
      disputedOrders++;
    }

    if (row.resolve_tx_hash) {
      resolvedDisputes++;
    }
  }

  const successRate = totalAssigned > 0 ? Number((successfulClaims / totalAssigned).toFixed(4)) : 1;
  const disputeRate = totalAssigned > 0 ? Number((disputedOrders / totalAssigned).toFixed(4)) : 0;

  // Composite Reputation Score Algorithm (0 - 100):
  // Baseline: 100 for unblemished/new attestor
  // When orders exist:
  // - Success weight: 60% (successful delivery leading to claim)
  // - Low-expiry weight: 20% (preventing expired orders)
  // - Dispute penalty: -30% (disputed attestation actions)
  // - Track record volume bonus: up to +10 pts for volume
  let reputationScore = 100;
  if (totalAssigned > 0) {
    const successComponent = (successfulClaims / totalAssigned) * 60;
    const nonExpiredComponent = (1 - reclaimedAfterExpiry / totalAssigned) * 20;
    const disputePenalty = (disputedOrders / totalAssigned) * 30;
    const volumeBonus = Math.min(10, totalAttested * 2);

    const calculated = successComponent + nonExpiredComponent - disputePenalty + volumeBonus;
    reputationScore = Math.max(0, Math.min(100, Math.round(calculated)));
  }

  return {
    totalAssigned,
    totalAttested,
    successfulClaims,
    reclaimedAfterExpiry,
    disputedOrders,
    resolvedDisputes,
    successRate,
    disputeRate,
    reputationScore,
  };
}

export function formatAttestor(
  row: AttestorRow,
  reputationOverride?: AttestorReputationSummary,
): AttestorWithReputation {
  const reputation = reputationOverride || computeReputationForAddress(row.address);
  return {
    id: row.id,
    address: row.address,
    name: row.name,
    description: row.description,
    coverageArea: row.coverage_area,
    feeBps: row.fee_bps,
    active: Boolean(row.active),
    reputation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Registers a new attestor or updates an existing registration if the address is already registered.
 */
export function registerAttestor(input: RegisterAttestorInput): AttestorWithReputation {
  const existing = db
    .prepare(`SELECT * FROM attestor_directory WHERE address = ?`)
    .get(input.address) as AttestorRow | undefined;

  const now = new Date().toISOString();

  if (existing) {
    db.prepare(
      `UPDATE attestor_directory 
       SET name = ?, description = ?, coverage_area = ?, fee_bps = ?, active = 1, updated_at = ? 
       WHERE id = ?`,
    ).run(
      input.name,
      input.description ?? existing.description,
      input.coverageArea ?? existing.coverage_area,
      input.feeBps ?? existing.fee_bps,
      now,
      existing.id,
    );

    const updated = db
      .prepare(`SELECT * FROM attestor_directory WHERE id = ?`)
      .get(existing.id) as AttestorRow;
    return formatAttestor(updated);
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO attestor_directory (
      id, address, name, description, coverage_area, fee_bps, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.address,
    input.name,
    input.description ?? null,
    input.coverageArea ?? null,
    input.feeBps ?? 0,
    1,
    now,
    now,
  );

  const row = db.prepare(`SELECT * FROM attestor_directory WHERE id = ?`).get(id) as AttestorRow;
  return formatAttestor(row);
}

/**
 * Fetch registered attestor by directory ID
 */
export function getAttestorById(id: string): AttestorWithReputation | undefined {
  const row = db.prepare(`SELECT * FROM attestor_directory WHERE id = ?`).get(id) as
    AttestorRow | undefined;
  return row ? formatAttestor(row) : undefined;
}

/**
 * Fetch registered attestor by Stellar public key address
 */
export function getAttestorByAddress(address: string): AttestorWithReputation | undefined {
  const row = db.prepare(`SELECT * FROM attestor_directory WHERE address = ?`).get(address) as
    AttestorRow | undefined;
  return row ? formatAttestor(row) : undefined;
}

/**
 * List registered attestors with calculated reputation summaries and optional filters
 */
export function listAttestors(filters?: {
  coverageArea?: string;
  activeOnly?: boolean;
  minScore?: number;
}): AttestorWithReputation[] {
  let query = `SELECT * FROM attestor_directory WHERE 1=1`;
  const params: unknown[] = [];

  if (filters?.activeOnly !== false) {
    query += ` AND active = 1`;
  }

  if (filters?.coverageArea) {
    query += ` AND coverage_area LIKE ?`;
    params.push(`%${filters.coverageArea}%`);
  }

  query += ` ORDER BY created_at DESC`;

  const rows = db.prepare(query).all(...params) as AttestorRow[];
  let results = rows.map((r) => formatAttestor(r));

  if (typeof filters?.minScore === "number") {
    results = results.filter((a) => a.reputation.reputationScore >= filters.minScore!);
  }

  // Sort by highest reputation score first, then most completed orders
  results.sort((a, b) => {
    if (b.reputation.reputationScore !== a.reputation.reputationScore) {
      return b.reputation.reputationScore - a.reputation.reputationScore;
    }
    return b.reputation.totalAttested - a.reputation.totalAttested;
  });

  return results;
}
