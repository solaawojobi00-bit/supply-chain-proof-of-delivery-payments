import { Keypair, rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  KeypairSigner,
  Result,
} from "@stellar/stellar-sdk/contract";
import { config } from "./config.js";
import { deployerKeypair } from "./keys.js";
import { logStructured } from "./logger.js";

interface RawOrder {
  buyer: string;
  seller: string;
  attestors: string[];
  threshold: number;
  confirmations: string[];
  arbiter: string;
  token: string;
  amount: bigint;
  deadline: bigint;
  status: { tag: string };
  evidence_hash?: Buffer | Uint8Array | string | null;
}

interface ContractErrorMessage {
  message: string;
}

/**
 * Every contract method returns `Result<T, Error>` on the Rust side (see
 * contracts/escrow/src/lib.rs), which the JS client surfaces as this `Result`
 * wrapper instead of throwing, so callers must `.unwrap()` (or check
 * `.isErr()`) explicitly.
 */
type ContractResult<T> = Result<T, ContractErrorMessage>;

/** Method signatures for the deployed escrow contract, so `Client` calls typecheck. */
interface EscrowContract {
  create(args: {
    buyer: string;
    seller: string;
    attestors: string[];
    threshold: number;
    arbiter: string;
    token: string;
    amount: bigint;
    deadline: bigint;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  attest(args: { attestor: string }): Promise<AssembledTransaction<ContractResult<null>>>;
  claim(): Promise<AssembledTransaction<ContractResult<null>>>;
  reclaim(): Promise<AssembledTransaction<ContractResult<null>>>;
  cancel(): Promise<AssembledTransaction<ContractResult<null>>>;
  dispute(args?: {
    evidence_hash?: Buffer | Uint8Array | null;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  resolve_dispute(args: {
    release_to_seller: boolean;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  get_order(): Promise<AssembledTransaction<ContractResult<RawOrder>>>;
}

/** Unwraps a contract `Result`, converting a Rust-side `Err` into a thrown JS Error. */
function unwrap<T>(result: ContractResult<T>): T {
  return result.unwrap();
}

const baseClientOptions = {
  networkPassphrase: config.networkPassphrase,
  rpcUrl: config.rpcUrl,
};

function signerFor(keypair: Keypair) {
  return new KeypairSigner(keypair, config.networkPassphrase);
}

/** Deploys a fresh instance of the already-uploaded escrow WASM. One instance per order. */
export async function deployEscrowContract(): Promise<{
  contractId: string;
  txHash: string | undefined;
}> {
  const start = Date.now();
  try {
    const assembled = await ContractClient.deploy<ContractClient & EscrowContract>(null, {
      ...baseClientOptions,
      wasmHash: config.wasmHash,
      format: "hex",
      publicKey: deployerKeypair.publicKey(),
      signTransaction: signerFor(deployerKeypair),
    });
    const sent = await assembled.signAndSend();
    const client = sent.result;
    const contractId = client.options.contractId;
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "deploy",
      txHash,
      duration,
    });
    return {
      contractId,
      txHash,
    };
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      method: "deploy",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

async function clientFor(contractId: string, signer: Keypair) {
  return ContractClient.from<EscrowContract>({
    ...baseClientOptions,
    contractId,
    publicKey: signer.publicKey(),
    signTransaction: signerFor(signer),
  });
}

export async function callCreate(
  contractId: string,
  buyer: Keypair,
  params: {
    seller: string;
    attestors: string[];
    threshold?: number;
    arbiter?: string;
    token?: string;
    amount: bigint;
    deadline: bigint;
  },
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await clientFor(contractId, buyer);
    const tx = await client.create({
      buyer: buyer.publicKey(),
      seller: params.seller,
      attestors: params.attestors,
      threshold: params.threshold ?? 1,
      arbiter: params.arbiter ?? deployerKeypair.publicKey(),
      token: params.token ?? config.paymentTokenContractId,
      amount: params.amount,
      deadline: params.deadline,
    });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "create",
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "create",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callAttest(
  contractId: string,
  attestor: Keypair,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await clientFor(contractId, attestor);
    const tx = await client.attest({ attestor: attestor.publicKey() });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "attest",
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "attest",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callClaim(contractId: string, seller: Keypair): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await clientFor(contractId, seller);
    const tx = await client.claim();
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "claim",
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "claim",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callReclaim(contractId: string, buyer: Keypair): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await clientFor(contractId, buyer);
    const tx = await client.reclaim();
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "reclaim",
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "reclaim",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callCancel(
  contractId: string,
  buyer: Keypair,
  seller: Keypair,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await clientFor(contractId, buyer);
    const tx = await client.cancel();
    if (tx.needsNonInvokerSigningBy().includes(seller.publicKey())) {
      await tx.signAuthEntries({
        signAuthEntry: signerFor(seller),
        address: seller.publicKey(),
      });
    }
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "cancel",
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "cancel",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callDispute(
  contractId: string,
  buyer: Keypair,
  evidenceHash?: string | null,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await clientFor(contractId, buyer);
    const hashBuf = evidenceHash ? Buffer.from(evidenceHash, "hex") : null;
    const tx = await client.dispute({ evidence_hash: hashBuf });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "dispute",
      evidenceHash: evidenceHash ?? undefined,
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "dispute",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callResolveDispute(
  contractId: string,
  arbiter: Keypair,
  releaseToSeller: boolean,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await clientFor(contractId, arbiter);
    const tx = await client.resolve_dispute({ release_to_seller: releaseToSeller });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "resolve_dispute",
      releaseToSeller,
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "resolve_dispute",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export interface EscrowRegistryContract {
  create_order(args: {
    order_id: bigint;
    buyer: string;
    seller: string;
    attestors: string[];
    threshold: number;
    arbiter: string;
    token: string;
    amount: bigint;
    deadline: bigint;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  attest(args: {
    order_id: bigint;
    attestor: string;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  claim(args: { order_id: bigint }): Promise<AssembledTransaction<ContractResult<null>>>;
  reclaim(args: { order_id: bigint }): Promise<AssembledTransaction<ContractResult<null>>>;
  cancel(args: { order_id: bigint }): Promise<AssembledTransaction<ContractResult<null>>>;
  dispute(args: {
    order_id: bigint;
    evidence_hash?: Buffer | Uint8Array | null;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  resolve_dispute(args: {
    order_id: bigint;
    release_to_seller: boolean;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  get_order(args: {
    order_id: bigint;
  }): Promise<AssembledTransaction<ContractResult<RawOrder & { order_id: bigint }>>>;
}

export interface OnChainOrder {
  buyer: string;
  seller: string;
  attestors: string[];
  threshold: number;
  confirmations: string[];
  arbiter: string;
  token: string;
  amount: bigint;
  deadline: bigint;
  status: string;
  evidence_hash?: string | null;
}

export async function readOnChainOrder(contractId: string): Promise<OnChainOrder> {
  const client = await ContractClient.from<EscrowContract>({
    ...baseClientOptions,
    contractId,
    publicKey: deployerKeypair.publicKey(),
  });
  const tx = await client.get_order();
  const raw = unwrap(tx.result);
  const evidenceHashHex = raw.evidence_hash
    ? Buffer.isBuffer(raw.evidence_hash)
      ? raw.evidence_hash.toString("hex")
      : typeof raw.evidence_hash === "string"
        ? raw.evidence_hash
        : Buffer.from(raw.evidence_hash).toString("hex")
    : null;
  return { ...raw, status: raw.status.tag, evidence_hash: evidenceHashHex };
}

async function registryClientFor(contractId: string, signer: Keypair) {
  return ContractClient.from<EscrowRegistryContract>({
    ...baseClientOptions,
    contractId,
    publicKey: signer.publicKey(),
    signTransaction: signerFor(signer),
  });
}

export async function callRegistryCreateOrder(
  contractId: string,
  buyer: Keypair,
  params: {
    orderId: bigint;
    seller: string;
    attestors: string[];
    threshold?: number;
    arbiter?: string;
    token?: string;
    amount: bigint;
    deadline: bigint;
  },
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await registryClientFor(contractId, buyer);
    const tx = await client.create_order({
      order_id: params.orderId,
      buyer: buyer.publicKey(),
      seller: params.seller,
      attestors: params.attestors,
      threshold: params.threshold ?? 1,
      arbiter: params.arbiter ?? deployerKeypair.publicKey(),
      token: params.token ?? config.paymentTokenContractId,
      amount: params.amount,
      deadline: params.deadline,
    });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "registry_create_order",
      orderId: params.orderId.toString(),
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "registry_create_order",
      orderId: params.orderId.toString(),
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callRegistryAttest(
  contractId: string,
  attestor: Keypair,
  orderId: bigint,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await registryClientFor(contractId, attestor);
    const tx = await client.attest({ order_id: orderId, attestor: attestor.publicKey() });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "registry_attest",
      orderId: orderId.toString(),
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "registry_attest",
      orderId: orderId.toString(),
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callRegistryClaim(
  contractId: string,
  seller: Keypair,
  orderId: bigint,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await registryClientFor(contractId, seller);
    const tx = await client.claim({ order_id: orderId });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "registry_claim",
      orderId: orderId.toString(),
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "registry_claim",
      orderId: orderId.toString(),
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callRegistryReclaim(
  contractId: string,
  buyer: Keypair,
  orderId: bigint,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await registryClientFor(contractId, buyer);
    const tx = await client.reclaim({ order_id: orderId });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "registry_reclaim",
      orderId: orderId.toString(),
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "registry_reclaim",
      orderId: orderId.toString(),
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callRegistryCancel(
  contractId: string,
  buyer: Keypair,
  seller: Keypair,
  orderId: bigint,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await registryClientFor(contractId, buyer);
    const tx = await client.cancel({ order_id: orderId });
    if (tx.needsNonInvokerSigningBy().includes(seller.publicKey())) {
      await tx.signAuthEntries({
        signAuthEntry: signerFor(seller),
        address: seller.publicKey(),
      });
    }
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "registry_cancel",
      orderId: orderId.toString(),
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "registry_cancel",
      orderId: orderId.toString(),
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callRegistryDispute(
  contractId: string,
  buyer: Keypair,
  orderId: bigint,
  evidenceHash?: string | null,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await registryClientFor(contractId, buyer);
    const hashBuf = evidenceHash ? Buffer.from(evidenceHash, "hex") : null;
    const tx = await client.dispute({
      order_id: orderId,
      evidence_hash: hashBuf,
    });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "registry_dispute",
      orderId: orderId.toString(),
      evidenceHash: evidenceHash ?? undefined,
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "registry_dispute",
      orderId: orderId.toString(),
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function callRegistryResolveDispute(
  contractId: string,
  arbiter: Keypair,
  orderId: bigint,
  releaseToSeller: boolean,
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await registryClientFor(contractId, arbiter);
    const tx = await client.resolve_dispute({
      order_id: orderId,
      release_to_seller: releaseToSeller,
    });
    const sent = await tx.signAndSend();
    unwrap(sent.result);
    const txHash = sent.sendTransactionResponse?.hash;
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      contractId,
      method: "registry_resolve_dispute",
      orderId: orderId.toString(),
      releaseToSeller,
      txHash,
      duration,
    });
    return txHash;
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      contractId,
      method: "registry_resolve_dispute",
      orderId: orderId.toString(),
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}

export async function readOnChainRegistryOrder(
  contractId: string,
  orderId: bigint,
): Promise<OnChainOrder> {
  const client = await ContractClient.from<EscrowRegistryContract>({
    ...baseClientOptions,
    contractId,
    publicKey: deployerKeypair.publicKey(),
  });
  const tx = await client.get_order({ order_id: orderId });
  const raw = unwrap(tx.result);
  const evidenceHashHex = raw.evidence_hash
    ? Buffer.isBuffer(raw.evidence_hash)
      ? raw.evidence_hash.toString("hex")
      : typeof raw.evidence_hash === "string"
        ? raw.evidence_hash
        : Buffer.from(raw.evidence_hash).toString("hex")
    : null;
  return { ...raw, status: raw.status.tag, evidence_hash: evidenceHashHex };
}

async function readOnlyClientFor(contractId: string, publicKey: string) {
  return ContractClient.from<EscrowContract>({
    ...baseClientOptions,
    contractId,
    publicKey,
  });
}

async function readOnlyRegistryClientFor(contractId: string, publicKey: string) {
  return ContractClient.from<EscrowRegistryContract>({
    ...baseClientOptions,
    contractId,
    publicKey,
  });
}

export async function buildUnsignedCreateTx(
  contractId: string,
  buyerAddress: string,
  params: {
    seller: string;
    attestors: string[];
    threshold?: number;
    arbiter?: string;
    token?: string;
    amount: bigint;
    deadline: bigint;
  },
): Promise<string> {
  const client = await readOnlyClientFor(contractId, buyerAddress);
  const tx = await client.create({
    buyer: buyerAddress,
    seller: params.seller,
    attestors: params.attestors,
    threshold: params.threshold ?? 1,
    arbiter: params.arbiter ?? deployerKeypair.publicKey(),
    token: params.token ?? config.paymentTokenContractId,
    amount: params.amount,
    deadline: params.deadline,
  });
  return tx.toXDR();
}

export async function buildRegistryUnsignedCreateTx(
  contractId: string,
  buyerAddress: string,
  params: {
    orderId: bigint;
    seller: string;
    attestors: string[];
    threshold?: number;
    arbiter?: string;
    token?: string;
    amount: bigint;
    deadline: bigint;
  },
): Promise<string> {
  const client = await readOnlyRegistryClientFor(contractId, buyerAddress);
  const tx = await client.create_order({
    order_id: params.orderId,
    buyer: buyerAddress,
    seller: params.seller,
    attestors: params.attestors,
    threshold: params.threshold ?? 1,
    arbiter: params.arbiter ?? deployerKeypair.publicKey(),
    token: params.token ?? config.paymentTokenContractId,
    amount: params.amount,
    deadline: params.deadline,
  });
  return tx.toXDR();
}

export async function buildUnsignedAttestTx(
  contractId: string,
  attestorAddress: string,
): Promise<string> {
  const client = await readOnlyClientFor(contractId, attestorAddress);
  const tx = await client.attest({ attestor: attestorAddress });
  return tx.toXDR();
}

export async function buildRegistryUnsignedAttestTx(
  contractId: string,
  attestorAddress: string,
  orderId: bigint,
): Promise<string> {
  const client = await readOnlyRegistryClientFor(contractId, attestorAddress);
  const tx = await client.attest({ order_id: orderId, attestor: attestorAddress });
  return tx.toXDR();
}

export async function buildUnsignedClaimTx(
  contractId: string,
  sellerAddress: string,
): Promise<string> {
  const client = await readOnlyClientFor(contractId, sellerAddress);
  const tx = await client.claim();
  return tx.toXDR();
}

export async function buildRegistryUnsignedClaimTx(
  contractId: string,
  sellerAddress: string,
  orderId: bigint,
): Promise<string> {
  const client = await readOnlyRegistryClientFor(contractId, sellerAddress);
  const tx = await client.claim({ order_id: orderId });
  return tx.toXDR();
}

export async function buildUnsignedReclaimTx(
  contractId: string,
  buyerAddress: string,
): Promise<string> {
  const client = await readOnlyClientFor(contractId, buyerAddress);
  const tx = await client.reclaim();
  return tx.toXDR();
}

export async function buildRegistryUnsignedReclaimTx(
  contractId: string,
  buyerAddress: string,
  orderId: bigint,
): Promise<string> {
  const client = await readOnlyRegistryClientFor(contractId, buyerAddress);
  const tx = await client.reclaim({ order_id: orderId });
  return tx.toXDR();
}

export async function buildUnsignedCancelTx(
  contractId: string,
  callerAddress: string,
): Promise<string> {
  const client = await readOnlyClientFor(contractId, callerAddress);
  const tx = await client.cancel();
  return tx.toXDR();
}

export async function buildRegistryUnsignedCancelTx(
  contractId: string,
  callerAddress: string,
  orderId: bigint,
): Promise<string> {
  const client = await readOnlyRegistryClientFor(contractId, callerAddress);
  const tx = await client.cancel({ order_id: orderId });
  return tx.toXDR();
}

export async function buildUnsignedDisputeTx(
  contractId: string,
  buyerAddress: string,
  evidenceHash?: string | null,
): Promise<string> {
  const client = await readOnlyClientFor(contractId, buyerAddress);
  const hashBuf = evidenceHash ? Buffer.from(evidenceHash, "hex") : null;
  const tx = await client.dispute({ evidence_hash: hashBuf });
  return tx.toXDR();
}

export async function buildRegistryUnsignedDisputeTx(
  contractId: string,
  buyerAddress: string,
  orderId: bigint,
  evidenceHash?: string | null,
): Promise<string> {
  const client = await readOnlyRegistryClientFor(contractId, buyerAddress);
  const hashBuf = evidenceHash ? Buffer.from(evidenceHash, "hex") : null;
  const tx = await client.dispute({
    order_id: orderId,
    evidence_hash: hashBuf,
  });
  return tx.toXDR();
}

export async function buildUnsignedResolveTx(
  contractId: string,
  arbiterAddress: string,
  releaseToSeller: boolean,
): Promise<string> {
  const client = await readOnlyClientFor(contractId, arbiterAddress);
  const tx = await client.resolve_dispute({ release_to_seller: releaseToSeller });
  return tx.toXDR();
}

export async function buildRegistryUnsignedResolveTx(
  contractId: string,
  arbiterAddress: string,
  orderId: bigint,
  releaseToSeller: boolean,
): Promise<string> {
  const client = await readOnlyRegistryClientFor(contractId, arbiterAddress);
  const tx = await client.resolve_dispute({
    order_id: orderId,
    release_to_seller: releaseToSeller,
  });
  return tx.toXDR();
}

export async function submitSignedXDR(
  signedXDR: string,
): Promise<{ txHash: string; status: string }> {
  const start = Date.now();
  try {
    const server = new rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    const tx = TransactionBuilder.fromXDR(signedXDR, config.networkPassphrase);
    const sendRes = await server.sendTransaction(tx);
    if (sendRes.status === "ERROR") {
      throw new Error(
        `Transaction submission error: ${JSON.stringify(sendRes.errorResult ?? sendRes)}`,
      );
    }
    const pollRes = await server.pollTransaction(sendRes.hash);
    if (pollRes.status === "FAILED") {
      throw new Error(
        `Transaction failed on-chain: ${JSON.stringify(pollRes.resultXdr ?? pollRes)}`,
      );
    }
    const duration = Date.now() - start;
    logStructured({
      type: "contract_call",
      method: "submit_signed_xdr",
      txHash: sendRes.hash,
      status: pollRes.status,
      duration,
    });
    return { txHash: sendRes.hash, status: pollRes.status };
  } catch (err) {
    const duration = Date.now() - start;
    logStructured({
      level: "error",
      type: "contract_call",
      method: "submit_signed_xdr",
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    throw err;
  }
}
