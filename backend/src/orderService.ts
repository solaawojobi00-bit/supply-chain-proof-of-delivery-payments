import { randomUUID } from "node:crypto";
import {
  buildRegistryUnsignedAttestTx,
  buildRegistryUnsignedCancelTx,
  buildRegistryUnsignedClaimTx,
  buildRegistryUnsignedCreateTx,
  buildRegistryUnsignedDisputeTx,
  buildRegistryUnsignedReclaimTx,
  buildRegistryUnsignedResolveTx,
  buildUnsignedAttestTx,
  buildUnsignedCancelTx,
  buildUnsignedClaimTx,
  buildUnsignedCreateTx,
  buildUnsignedDisputeTx,
  buildUnsignedReclaimTx,
  buildUnsignedResolveTx,
  callAttest,
  callCancel,
  callClaim,
  callCreate,
  callDispute,
  callReclaim,
  callRegistryAttest,
  callRegistryCancel,
  callRegistryClaim,
  callRegistryCreateOrder,
  callRegistryDispute,
  callRegistryReclaim,
  callRegistryResolveDispute,
  callResolveDispute,
  deployEscrowContract,
  readOnChainOrder,
  readOnChainRegistryOrder,
  submitSignedXDR,
} from "./contractOps.js";
import { config } from "./config.js";
import {
  getOrder,
  insertOrder,
  listOrders,
  updateOrderAttestation,
  updateOrderStatus,
  type OrderRow,
} from "./db.js";
import { HttpError } from "./httpError.js";
import { buyerKeypair, deployerKeypair, findLocalSigner } from "./keys.js";

export interface CreateOrderInput {
  sellerAddress: string;
  buyerAddress?: string;
  attestorAddress?: string;
  attestors?: string[];
  threshold?: number;
  arbiterAddress?: string;
  amountStroops: bigint;
  deadlineSeconds: bigint;
  tokenContractId?: string;
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
    case "Disputed":
      return "disputed";
    case "Claimed":
      return "claimed";
    case "Reclaimed":
      return "reclaimed";
    case "Cancelled":
      return "cancelled";
  }
}

export async function createOrder(
  input: CreateOrderInput,
  idempotencyKey?: string,
  requestPayload?: string,
): Promise<OrderRow> {
  const numericId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const paymentToken = input.tokenContractId ?? config.paymentTokenContractId;
  const attestors =
    input.attestors && input.attestors.length > 0 ? input.attestors : [input.attestorAddress!];
  const threshold = input.threshold ?? 1;
  const primaryAttestor = attestors[0];
  const arbiterAddress = input.arbiterAddress ?? deployerKeypair.publicKey();
  let contractId: string;
  let createTxHash: string | undefined;

  if (config.escrowRegistryContractId) {
    contractId = config.escrowRegistryContractId;
    createTxHash = await callRegistryCreateOrder(contractId, buyerKeypair, {
      orderId: BigInt(numericId),
      seller: input.sellerAddress,
      attestors,
      threshold,
      arbiter: arbiterAddress,
      token: paymentToken,
      amount: input.amountStroops,
      deadline: input.deadlineSeconds,
    });
  } else {
    const deployed = await deployEscrowContract();
    contractId = deployed.contractId;
    createTxHash = await callCreate(contractId, buyerKeypair, {
      seller: input.sellerAddress,
      attestors,
      threshold,
      arbiter: arbiterAddress,
      token: paymentToken,
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
    attestor_address: primaryAttestor,
    attestors: JSON.stringify(attestors),
    threshold,
    confirmations: JSON.stringify([]),
    arbiter_address: arbiterAddress,
    token_contract_id: paymentToken,
    amount: input.amountStroops.toString(),
    deadline: Number(input.deadlineSeconds),
    status: "Created",
    create_tx_hash: createTxHash ?? null,
    attest_tx_hash: null,
    claim_tx_hash: null,
    reclaim_tx_hash: null,
    dispute_tx_hash: null,
    resolve_tx_hash: null,
    buyer_token: `buyer_${randomUUID()}`,
    seller_token: `seller_${randomUUID()}`,
    attestor_token: `attestor_${randomUUID()}`,
    arbiter_token: `arbiter_${randomUUID()}`,
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

export async function attestOrder(id: string, attestorAddress?: string): Promise<OrderRow> {
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

  const designatedAttestors: string[] = order.attestors
    ? JSON.parse(order.attestors)
    : [order.attestor_address];
  const confirmations: string[] = order.confirmations ? JSON.parse(order.confirmations) : [];

  let targetAttestor: string | undefined;
  if (attestorAddress) {
    if (!designatedAttestors.includes(attestorAddress)) {
      throw new HttpError(400, "Attestor address is not authorized for this order");
    }
    if (confirmations.includes(attestorAddress)) {
      throw new HttpError(409, "This attestor has already confirmed delivery for this order");
    }
    targetAttestor = attestorAddress;
  } else {
    targetAttestor = designatedAttestors.find(
      (a) => !confirmations.includes(a) && Boolean(findLocalSigner(a)),
    );
    if (!targetAttestor) {
      if (designatedAttestors.every((a) => confirmations.includes(a))) {
        throw new HttpError(409, "All authorized attestors have already confirmed delivery");
      }
      if (designatedAttestors.length === 1) {
        throw new HttpError(
          400,
          "No local signer for this attestor address. Phase 1 backend can only sign for its configured demo keypairs (see ARCHITECTURE.md); client-side wallet signing is Phase 2+.",
        );
      }
      throw new HttpError(
        400,
        "No local signer found for unconfirmed authorized attestors on this order.",
      );
    }
  }

  const signer = findLocalSigner(targetAttestor);
  if (!signer) {
    throw new HttpError(
      400,
      `No local signer for attestor ${targetAttestor}. Phase 1 backend can only sign for its configured demo keypairs (see ARCHITECTURE.md); client-side wallet signing is Phase 2+.`,
    );
  }

  const txHash =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await callRegistryAttest(order.contract_id, signer, BigInt(order.numeric_id))
      : await callAttest(order.contract_id, signer);

  const nextConfirmations = [...confirmations, signer.publicKey()];
  const requiredThreshold = order.threshold ?? 1;
  const nextStatus = nextConfirmations.length >= requiredThreshold ? "Attested" : "Created";

  updateOrderAttestation(id, nextStatus, nextConfirmations, txHash ?? "");
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

export async function cancelOrder(id: string): Promise<OrderRow> {
  const order = requireOrder(id);
  if (order.status !== "Created") {
    throw new HttpError(409, `Order is ${order.status}; can only cancel an order that is Created`);
  }
  const buyerSigner = findLocalSigner(order.buyer_address);
  if (!buyerSigner) {
    throw new HttpError(
      400,
      "No local signer for this buyer address. Phase 1 backend requires local signers for mutual cancellation.",
    );
  }
  const sellerSigner = findLocalSigner(order.seller_address);
  if (!sellerSigner) {
    throw new HttpError(
      400,
      "No local signer for this seller address. Phase 1 backend requires local signers for mutual cancellation.",
    );
  }
  const txHash =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await callRegistryCancel(
          order.contract_id,
          buyerSigner,
          sellerSigner,
          BigInt(order.numeric_id),
        )
      : await callCancel(order.contract_id, buyerSigner, sellerSigner);
  updateOrderStatus(id, "Cancelled", "cancel_tx_hash", txHash ?? "");
  return requireOrder(id);
}

export async function disputeOrder(id: string): Promise<OrderRow> {
  const order = requireOrder(id);
  if (order.status !== "Attested") {
    throw new HttpError(
      409,
      `Order is ${order.status}; can only dispute an order that is Attested`,
    );
  }
  const buyerSigner = findLocalSigner(order.buyer_address);
  if (!buyerSigner) {
    throw new HttpError(
      400,
      "No local signer for this buyer address. Phase 1 backend requires local signers for raising disputes.",
    );
  }
  const txHash =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await callRegistryDispute(order.contract_id, buyerSigner, BigInt(order.numeric_id))
      : await callDispute(order.contract_id, buyerSigner);
  updateOrderStatus(id, "Disputed", "dispute_tx_hash", txHash ?? "");
  return requireOrder(id);
}

export async function buildUnsignedCreateOrder(
  input: CreateOrderInput,
  idempotencyKey?: string,
  requestPayload?: string,
): Promise<{ unsignedTxXdr: string; order: OrderRow }> {
  const numericId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const paymentToken = input.tokenContractId ?? config.paymentTokenContractId;
  const attestors =
    input.attestors && input.attestors.length > 0 ? input.attestors : [input.attestorAddress!];
  const threshold = input.threshold ?? 1;
  const primaryAttestor = attestors[0];
  const arbiterAddress = input.arbiterAddress ?? deployerKeypair.publicKey();
  const buyerAddress = input.buyerAddress ?? buyerKeypair.publicKey();

  let contractId: string;
  let unsignedTxXdr: string;

  if (config.escrowRegistryContractId) {
    contractId = config.escrowRegistryContractId;
    unsignedTxXdr = await buildRegistryUnsignedCreateTx(contractId, buyerAddress, {
      orderId: BigInt(numericId),
      seller: input.sellerAddress,
      attestors,
      threshold,
      arbiter: arbiterAddress,
      token: paymentToken,
      amount: input.amountStroops,
      deadline: input.deadlineSeconds,
    });
  } else {
    const deployed = await deployEscrowContract();
    contractId = deployed.contractId;
    unsignedTxXdr = await buildUnsignedCreateTx(contractId, buyerAddress, {
      seller: input.sellerAddress,
      attestors,
      threshold,
      arbiter: arbiterAddress,
      token: paymentToken,
      amount: input.amountStroops,
      deadline: input.deadlineSeconds,
    });
  }

  const row: OrderRow = {
    id: randomUUID(),
    contract_id: contractId,
    numeric_id: numericId,
    buyer_address: buyerAddress,
    seller_address: input.sellerAddress,
    attestor_address: primaryAttestor,
    attestors: JSON.stringify(attestors),
    threshold,
    confirmations: JSON.stringify([]),
    arbiter_address: arbiterAddress,
    token_contract_id: paymentToken,
    amount: input.amountStroops.toString(),
    deadline: Number(input.deadlineSeconds),
    status: "Created",
    create_tx_hash: null,
    attest_tx_hash: null,
    claim_tx_hash: null,
    reclaim_tx_hash: null,
    dispute_tx_hash: null,
    resolve_tx_hash: null,
    buyer_token: `buyer_${randomUUID()}`,
    seller_token: `seller_${randomUUID()}`,
    attestor_token: `attestor_${randomUUID()}`,
    arbiter_token: `arbiter_${randomUUID()}`,
    idempotency_key: idempotencyKey ?? null,
    request_payload: requestPayload ?? null,
    created_at: new Date().toISOString(),
  };
  insertOrder(row);
  return { unsignedTxXdr, order: row };
}

export async function buildUnsignedAttest(
  id: string,
  attestorAddress?: string,
): Promise<{ unsignedTxXdr: string; orderId: string; contractId: string; action: string }> {
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

  const designatedAttestors: string[] = order.attestors
    ? JSON.parse(order.attestors)
    : [order.attestor_address];
  const confirmations: string[] = order.confirmations ? JSON.parse(order.confirmations) : [];

  let targetAttestor: string;
  if (attestorAddress) {
    if (!designatedAttestors.includes(attestorAddress)) {
      throw new HttpError(400, "Attestor address is not authorized for this order");
    }
    if (confirmations.includes(attestorAddress)) {
      throw new HttpError(409, "This attestor has already confirmed delivery for this order");
    }
    targetAttestor = attestorAddress;
  } else {
    const unconfirmed = designatedAttestors.find((a) => !confirmations.includes(a));
    if (!unconfirmed) {
      throw new HttpError(409, "All authorized attestors have already confirmed delivery");
    }
    targetAttestor = unconfirmed;
  }

  const unsignedTxXdr =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await buildRegistryUnsignedAttestTx(
          order.contract_id,
          targetAttestor,
          BigInt(order.numeric_id),
        )
      : await buildUnsignedAttestTx(order.contract_id, targetAttestor);

  return { unsignedTxXdr, orderId: id, contractId: order.contract_id, action: "attest" };
}

export async function buildUnsignedClaim(
  id: string,
): Promise<{ unsignedTxXdr: string; orderId: string; contractId: string; action: string }> {
  const order = requireOrder(id);
  if (order.status !== "Attested") {
    throw new HttpError(
      409,
      `Order is ${order.status}; can only claim an order that has been Attested`,
    );
  }

  const unsignedTxXdr =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await buildRegistryUnsignedClaimTx(
          order.contract_id,
          order.seller_address,
          BigInt(order.numeric_id),
        )
      : await buildUnsignedClaimTx(order.contract_id, order.seller_address);

  return { unsignedTxXdr, orderId: id, contractId: order.contract_id, action: "claim" };
}

export async function buildUnsignedReclaim(
  id: string,
): Promise<{ unsignedTxXdr: string; orderId: string; contractId: string; action: string }> {
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

  const unsignedTxXdr =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await buildRegistryUnsignedReclaimTx(
          order.contract_id,
          order.buyer_address,
          BigInt(order.numeric_id),
        )
      : await buildUnsignedReclaimTx(order.contract_id, order.buyer_address);

  return { unsignedTxXdr, orderId: id, contractId: order.contract_id, action: "reclaim" };
}

export async function buildUnsignedCancel(
  id: string,
  callerAddress?: string,
): Promise<{ unsignedTxXdr: string; orderId: string; contractId: string; action: string }> {
  const order = requireOrder(id);
  if (order.status !== "Created") {
    throw new HttpError(409, `Order is ${order.status}; can only cancel an order that is Created`);
  }
  const caller = callerAddress ?? order.buyer_address;

  const unsignedTxXdr =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await buildRegistryUnsignedCancelTx(order.contract_id, caller, BigInt(order.numeric_id))
      : await buildUnsignedCancelTx(order.contract_id, caller);

  return { unsignedTxXdr, orderId: id, contractId: order.contract_id, action: "cancel" };
}

export async function buildUnsignedDispute(
  id: string,
  buyerAddress?: string,
): Promise<{ unsignedTxXdr: string; orderId: string; contractId: string; action: string }> {
  const order = requireOrder(id);
  if (order.status !== "Attested") {
    throw new HttpError(
      409,
      `Order is ${order.status}; can only dispute an order that is Attested`,
    );
  }
  const buyer = buyerAddress ?? order.buyer_address;

  const unsignedTxXdr =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await buildRegistryUnsignedDisputeTx(order.contract_id, buyer, BigInt(order.numeric_id))
      : await buildUnsignedDisputeTx(order.contract_id, buyer);

  return { unsignedTxXdr, orderId: id, contractId: order.contract_id, action: "dispute" };
}

export async function buildUnsignedResolve(
  id: string,
  releaseToSeller: boolean,
  arbiterAddress?: string,
): Promise<{ unsignedTxXdr: string; orderId: string; contractId: string; action: string }> {
  const order = requireOrder(id);
  if (order.status !== "Disputed") {
    throw new HttpError(
      409,
      `Order is ${order.status}; can only resolve a dispute on an order that is Disputed`,
    );
  }
  const arbiter = arbiterAddress ?? order.arbiter_address ?? deployerKeypair.publicKey();

  const unsignedTxXdr =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await buildRegistryUnsignedResolveTx(
          order.contract_id,
          arbiter,
          BigInt(order.numeric_id),
          releaseToSeller,
        )
      : await buildUnsignedResolveTx(order.contract_id, arbiter, releaseToSeller);

  return { unsignedTxXdr, orderId: id, contractId: order.contract_id, action: "resolve" };
}

export async function resolveDispute(id: string, releaseToSeller: boolean): Promise<OrderRow> {
  const order = requireOrder(id);
  if (order.status !== "Disputed") {
    throw new HttpError(
      409,
      `Order is ${order.status}; can only resolve a dispute on an order that is Disputed`,
    );
  }
  const arbiterAddress = order.arbiter_address ?? deployerKeypair.publicKey();
  const arbiterSigner = findLocalSigner(arbiterAddress);
  if (!arbiterSigner) {
    throw new HttpError(
      400,
      `No local signer for arbiter address ${arbiterAddress}. Phase 1 backend requires local signers for dispute resolution.`,
    );
  }
  const txHash =
    order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
      ? await callRegistryResolveDispute(
          order.contract_id,
          arbiterSigner,
          BigInt(order.numeric_id),
          releaseToSeller,
        )
      : await callResolveDispute(order.contract_id, arbiterSigner, releaseToSeller);
  const nextStatus = releaseToSeller ? "Claimed" : "Reclaimed";
  updateOrderStatus(id, nextStatus, "resolve_tx_hash", txHash ?? "");
  return requireOrder(id);
}

export async function submitSignedTx(
  signedXdr: string,
  orderId?: string,
  action?: string,
): Promise<{ txHash: string; status: string; order?: OrderRow }> {
  const result = await submitSignedXDR(signedXdr);
  if (!orderId) {
    return { txHash: result.txHash, status: result.status };
  }
  const order = getOrder(orderId);
  if (!order) {
    return { txHash: result.txHash, status: result.status };
  }

  try {
    const chainState =
      order.numeric_id != null && order.contract_id === config.escrowRegistryContractId
        ? await readOnChainRegistryOrder(order.contract_id, BigInt(order.numeric_id))
        : await readOnChainOrder(order.contract_id);

    let onChainStatus = chainState.status as OrderRow["status"];
    const confirmations = chainState.confirmations;

    if (action === "attest") {
      onChainStatus = "Attested";
    } else if (action === "claim") {
      onChainStatus = "Claimed";
    } else if (action === "reclaim") {
      onChainStatus = "Reclaimed";
    } else if (action === "cancel") {
      onChainStatus = "Cancelled";
    } else if (action === "dispute") {
      onChainStatus = "Disputed";
    } else if (action === "resolve") {
      onChainStatus = "Claimed";
    }

    let txHashCol:
      | "attest_tx_hash"
      | "claim_tx_hash"
      | "reclaim_tx_hash"
      | "cancel_tx_hash"
      | "dispute_tx_hash"
      | "resolve_tx_hash" = "attest_tx_hash";

    if (action === "claim" || onChainStatus === "Claimed") txHashCol = "claim_tx_hash";
    else if (action === "reclaim" || onChainStatus === "Reclaimed") txHashCol = "reclaim_tx_hash";
    else if (action === "cancel" || onChainStatus === "Cancelled") txHashCol = "cancel_tx_hash";
    else if (action === "dispute" || onChainStatus === "Disputed") txHashCol = "dispute_tx_hash";
    else if (action === "resolve") txHashCol = "resolve_tx_hash";

    updateOrderAttestation(
      orderId,
      onChainStatus,
      confirmations,
      action === "attest" ? result.txHash : (order.attest_tx_hash ?? ""),
    );
    updateOrderStatus(orderId, onChainStatus, txHashCol, result.txHash);
  } catch {
    if (action === "attest") {
      updateOrderStatus(orderId, "Attested", "attest_tx_hash", result.txHash);
    } else if (action === "claim") {
      updateOrderStatus(orderId, "Claimed", "claim_tx_hash", result.txHash);
    } else if (action === "reclaim") {
      updateOrderStatus(orderId, "Reclaimed", "reclaim_tx_hash", result.txHash);
    } else if (action === "cancel") {
      updateOrderStatus(orderId, "Cancelled", "cancel_tx_hash", result.txHash);
    } else if (action === "dispute") {
      updateOrderStatus(orderId, "Disputed", "dispute_tx_hash", result.txHash);
    } else if (action === "resolve") {
      updateOrderStatus(orderId, "Claimed", "resolve_tx_hash", result.txHash);
    }
  }

  return { txHash: result.txHash, status: result.status, order: requireOrder(orderId) };
}
