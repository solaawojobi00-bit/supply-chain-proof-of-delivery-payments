import { randomUUID } from "node:crypto";
import {
  callAttest,
  callClaim,
  callCreate,
  callReclaim,
  callRegistryAttest,
  callRegistryClaim,
  callRegistryCreateOrder,
  callRegistryReclaim,
  deployEscrowContract,
  readOnChainOrder,
  readOnChainRegistryOrder,
} from "./contractOps.js";
import { config } from "./config.js";
import { getOrder, insertOrder, listOrders, updateOrderStatus, type OrderRow } from "./db.js";
import { HttpError } from "./httpError.js";
import { buyerKeypair, findLocalSigner } from "./keys.js";

export interface CreateOrderInput {
  sellerAddress: string;
  attestorAddress: string;
  amountStroops: bigint;
  deadlineSeconds: bigint;
}

function requireOrder(id: string): OrderRow {
  const order = getOrder(id);
  if (!order) {
    throw new HttpError(404, `Order ${id} not found`);
  }
  return order;
}

/** Human-readable label mirroring the lifecycle stages described in the PRD. */
export function lifecycleLabel(order: OrderRow): string {
  const deadlinePassed = Date.now() / 1000 >= order.deadline;
  switch (order.status) {
    case "Created":
      return deadlinePassed ? "deadline-passed" : "in-transit";
    case "Attested":
      return "delivered/confirmed";
    case "Claimed":
      return "claimed";
    case "Reclaimed":
      return "reclaimed";
  }
}

export async function createOrder(
  input: CreateOrderInput,
  idempotencyKey?: string,
  requestPayload?: string,
): Promise<OrderRow> {
  const numericId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  let contractId: string;
  let createTxHash: string | undefined;

  if (config.escrowRegistryContractId) {
    contractId = config.escrowRegistryContractId;
    createTxHash = await callRegistryCreateOrder(contractId, buyerKeypair, {
      orderId: BigInt(numericId),
      seller: input.sellerAddress,
      attestor: input.attestorAddress,
      amount: input.amountStroops,
      deadline: input.deadlineSeconds,
    });
  } else {
    const deployed = await deployEscrowContract();
    contractId = deployed.contractId;
    createTxHash = await callCreate(contractId, buyerKeypair, {
      seller: input.sellerAddress,
      attestor: input.attestorAddress,
      amount: input.amountStroops,
      deadline: input.deadlineSeconds,
    });
  }

  const row: OrderRow = {
    id: randomUUID(),
    contract_id: contractId,
    numeric_id: numericId,
    buyer_address: buyerKeypair.publicKey(),
    seller_address: input.sellerAddress,
    attestor_address: input.attestorAddress,
    token_contract_id: config.paymentTokenContractId,
    amount: input.amountStroops.toString(),
    deadline: Number(input.deadlineSeconds),
    status: "Created",
    create_tx_hash: createTxHash ?? null,
    attest_tx_hash: null,
    claim_tx_hash: null,
    reclaim_tx_hash: null,
    idempotency_key: idempotencyKey ?? null,
    request_payload: requestPayload ?? null,
    created_at: new Date().toISOString(),
  };
  insertOrder(row);
  return row;
}

export function getOrderById(id: string): OrderRow {
  return requireOrder(id);
}

export function getAllOrders(): OrderRow[] {
  return listOrders();
}

export async function getOrderWithChainState(id: string) {
  const order = requireOrder(id);
  const onChain =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await readOnChainRegistryOrder(order.contract_id, BigInt(order.numeric_id))
      : await readOnChainOrder(order.contract_id);
  return { order, onChain, lifecycle: lifecycleLabel(order) };
}

export async function attestOrder(id: string): Promise<OrderRow> {
  const order = requireOrder(id);
  if (order.status !== "Created") {
    throw new HttpError(409, `Order is ${order.status}; can only attest an order that is Created`);
  }
  if (Date.now() / 1000 >= order.deadline) {
    throw new HttpError(
      409,
      "Deadline has already passed; this order can only be reclaimed by the buyer now",
    );
  }
  const signer = findLocalSigner(order.attestor_address);
  if (!signer) {
    throw new HttpError(
      400,
      "No local signer for this attestor address. Phase 1 backend can only sign for its configured demo keypairs (see ARCHITECTURE.md); client-side wallet signing is Phase 2+.",
    );
  }
  const txHash =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await callRegistryAttest(order.contract_id, signer, BigInt(order.numeric_id))
      : await callAttest(order.contract_id, signer);
  updateOrderStatus(id, "Attested", "attest_tx_hash", txHash ?? "");
  return requireOrder(id);
}

export async function claimOrder(id: string): Promise<OrderRow> {
  const order = requireOrder(id);
  if (order.status !== "Attested") {
    throw new HttpError(
      409,
      `Order is ${order.status}; can only claim an order that has been Attested`,
    );
  }
  const signer = findLocalSigner(order.seller_address);
  if (!signer) {
    throw new HttpError(
      400,
      "No local signer for this seller address. Phase 1 backend can only sign for its configured demo keypairs (see ARCHITECTURE.md); client-side wallet signing is Phase 2+.",
    );
  }
  const txHash =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await callRegistryClaim(order.contract_id, signer, BigInt(order.numeric_id))
      : await callClaim(order.contract_id, signer);
  updateOrderStatus(id, "Claimed", "claim_tx_hash", txHash ?? "");
  return requireOrder(id);
}

export async function reclaimOrder(id: string): Promise<OrderRow> {
  const order = requireOrder(id);
  if (order.status !== "Created") {
    throw new HttpError(
      409,
      `Order is ${order.status}; can only reclaim an order that is still Created`,
    );
  }
  if (Date.now() / 1000 < order.deadline) {
    throw new HttpError(409, "Deadline has not passed yet; buyer cannot reclaim until it does");
  }
  const txHash =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await callRegistryReclaim(order.contract_id, buyerKeypair, BigInt(order.numeric_id))
      : await callReclaim(order.contract_id, buyerKeypair);
  updateOrderStatus(id, "Reclaimed", "reclaim_tx_hash", txHash ?? "");
  return requireOrder(id);
}
