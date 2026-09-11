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

/** The order fields reputation is derived from. */
interface ReputationSourceRow {
  attestor_address: string;
  status: string;
  attestors: string | null;
  confirmations: string | null;
  dispute_tx_hash: string | null;
  resolve_tx_hash: string | null;
}

const REPUTATION_SOURCE_COLUMNS = `attestor_address, status, attestors, confirmations, dispute_tx_hash, resolve_tx_hash`;

/**
 * True when the address is this order's primary attestor or appears in its
 * multi-attestor array. Mirrors the SQL predicate used by the single-address
 * query so both paths select the same orders.
 */
function orderInvolvesAttestor(row: ReputationSourceRow, address: string): boolean {
  if (row.attestor_address === address) return true;
  return typeof row.attestors === "string" && row.attestors.includes(`"${address}"`);
}

/**
 * Reduces an attestor's order history into reputation statistics. Pure, so the
 * single-address and batch paths share identical scoring.
 */
function reduceReputation(rows: ReputationSourceRow[], address: string): AttestorReputationSummary {
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

/**
 * Derives dynamic reputation statistics from real order history in the `orders` table.
 * Reputation is calculated purely from actual contract execution events, never self-reported.
 */
export async function computeReputationForAddress(
  address: string,
): Promise<AttestorReputationSummary> {
  const result = await db.execute({
    sql: `SELECT ${REPUTATION_SOURCE_COLUMNS}
       FROM orders
       WHERE attestor_address = ? OR attestors LIKE ?`,
    args: [address, `%"${address}"%`],
  });
  return reduceReputation(result.rows as unknown as ReputationSourceRow[], address);
}

/**
 * Reputation for many addresses using a single query. Listing endpoints need a
 * score for every row, so fetching per address would issue one round-trip each.
 */
async function computeReputationForAddresses(
  addresses: string[],
): Promise<Map<string, AttestorReputationSummary>> {
  const summaries = new Map<string, AttestorReputationSummary>();
  if (addresses.length === 0) return summaries;

  const result = await db.execute(`SELECT ${REPUTATION_SOURCE_COLUMNS} FROM orders`);
  const allRows = result.rows as unknown as ReputationSourceRow[];

  for (const address of addresses) {
    const relevant = allRows.filter((row) => orderInvolvesAttestor(row, address));
    summaries.set(address, reduceReputation(relevant, address));
  }
  return summaries;
}

export function formatAttestor(
  row: AttestorRow,
  reputation: AttestorReputationSummary,
): AttestorWithReputation {
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

async function withReputation(row: AttestorRow): Promise<AttestorWithReputation> {
  return formatAttestor(row, await computeReputationForAddress(row.address));
}

/**
 * Registers a new attestor or updates an existing registration if the address is already registered.
 *
 * Written as a single upsert: a check-then-write pair would let two concurrent
 * registrations for the same address both miss the check, and one would then
 * fail the `address` UNIQUE constraint.
 */
export async function registerAttestor(
  input: RegisterAttestorInput,
): Promise<AttestorWithReputation> {
  const now = new Date().toISOString();

  // Optional fields bind as NULL and are COALESCEd, so an omitted field keeps
  // the stored value on update while still defaulting on insert.
  const result = await db.execute({
    sql: `INSERT INTO attestor_directory (
      id, address, name, description, coverage_area, fee_bps, active, created_at, updated_at
    ) VALUES (
      @id, @address, @name, @description, @coverage_area, COALESCE(@fee_bps, 0), 1, @now, @now
    )
    ON CONFLICT(address) DO UPDATE SET
      name = @name,
      description = COALESCE(@description, attestor_directory.description),
      coverage_area = COALESCE(@coverage_area, attestor_directory.coverage_area),
      fee_bps = COALESCE(@fee_bps, attestor_directory.fee_bps),
      active = 1,
      updated_at = @now
    RETURNING *`,
    args: {
      id: randomUUID(),
      address: input.address,
      name: input.name,
      description: input.description ?? null,
      coverage_area: input.coverageArea ?? null,
      fee_bps: input.feeBps ?? null,
      now,
    },
  });

  const row = result.rows[0] as unknown as AttestorRow;
  return withReputation(row);
}

/**
 * Fetch registered attestor by directory ID
 */
export async function getAttestorById(id: string): Promise<AttestorWithReputation | undefined> {
  const result = await db.execute({
    sql: `SELECT * FROM attestor_directory WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0] as unknown as AttestorRow | undefined;
  return row ? withReputation(row) : undefined;
}

/**
 * Fetch registered attestor by Stellar public key address
 */
export async function getAttestorByAddress(
  address: string,
): Promise<AttestorWithReputation | undefined> {
  const result = await db.execute({
    sql: `SELECT * FROM attestor_directory WHERE address = ?`,
    args: [address],
  });
  const row = result.rows[0] as unknown as AttestorRow | undefined;
  return row ? withReputation(row) : undefined;
}

/**
 * List registered attestors with calculated reputation summaries and optional filters
 */
export type AttestorSortKey = "reputationScore" | "successRate" | "disputeRate" | "feeBps";

/**
 * Default direction per sort key. Score-like fields read best highest-first,
 * whereas a fee is better when lower, so `feeBps` defaults the other way.
 */
const DEFAULT_SORT_ORDER: Record<AttestorSortKey, "asc" | "desc"> = {
  reputationScore: "desc",
  successRate: "desc",
  disputeRate: "asc",
  feeBps: "asc",
};

function sortValue(a: AttestorWithReputation, key: AttestorSortKey): number {
  switch (key) {
    case "feeBps":
      return a.feeBps;
    case "successRate":
      return a.reputation.successRate;
    case "disputeRate":
      return a.reputation.disputeRate;
    case "reputationScore":
      return a.reputation.reputationScore;
  }
}

export async function listAttestors(filters?: {
  coverageArea?: string;
  activeOnly?: boolean;
  minScore?: number;
  minSuccessRate?: number;
  maxDisputeRate?: number;
  maxFeeBps?: number;
  minCompletedOrders?: number;
  sort?: AttestorSortKey;
  order?: "asc" | "desc";
}): Promise<AttestorWithReputation[]> {
  let query = `SELECT * FROM attestor_directory WHERE 1=1`;
  const params: string[] = [];

  if (filters?.activeOnly !== false) {
    query += ` AND active = 1`;
  }

  if (filters?.coverageArea) {
    query += ` AND coverage_area LIKE ?`;
    params.push(`%${filters.coverageArea}%`);
  }

  query += ` ORDER BY created_at DESC`;

  const queryResult = await db.execute({ sql: query, args: params });
  const rows = queryResult.rows as unknown as AttestorRow[];

  // Every row needs a score for filtering and sorting, so resolve them all in
  // one query rather than one per attestor.
  const reputations = await computeReputationForAddresses(rows.map((r) => r.address));
  let results = rows.map((r) => formatAttestor(r, reputations.get(r.address)!));

  if (typeof filters?.minScore === "number") {
    results = results.filter((a) => a.reputation.reputationScore >= filters.minScore!);
  }
  if (typeof filters?.minSuccessRate === "number") {
    results = results.filter((a) => a.reputation.successRate >= filters.minSuccessRate!);
  }
  if (typeof filters?.maxDisputeRate === "number") {
    results = results.filter((a) => a.reputation.disputeRate <= filters.maxDisputeRate!);
  }
  if (typeof filters?.maxFeeBps === "number") {
    results = results.filter((a) => a.feeBps <= filters.maxFeeBps!);
  }
  // Guards the thin-sample problem: an attestor with one successful order shows
  // a 100% success rate, which should not outrank a long track record.
  if (typeof filters?.minCompletedOrders === "number") {
    results = results.filter((a) => a.reputation.totalAssigned >= filters.minCompletedOrders!);
  }

  if (filters?.sort) {
    const key = filters.sort;
    const direction = filters.order ?? DEFAULT_SORT_ORDER[key];
    const multiplier = direction === "asc" ? 1 : -1;
    results.sort((a, b) => {
      const diff = (sortValue(a, key) - sortValue(b, key)) * multiplier;
      // Tie-break on track record so ordering is stable and a thin sample does
      // not float above an equally-scored attestor with real volume.
      if (diff !== 0) return diff;
      return b.reputation.totalAttested - a.reputation.totalAttested;
    });
  } else {
    // Default: highest reputation score first, then most completed orders
    results.sort((a, b) => {
      if (b.reputation.reputationScore !== a.reputation.reputationScore) {
        return b.reputation.reputationScore - a.reputation.reputationScore;
      }
      return b.reputation.totalAttested - a.reputation.totalAttested;
    });
  }

  return results;
}
