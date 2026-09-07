import { Keypair } from "@stellar/stellar-sdk";
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
  attestor: string;
  token: string;
  amount: bigint;
  deadline: bigint;
  status: { tag: string };
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
    attestor: string;
    token: string;
    amount: bigint;
    deadline: bigint;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  attest(): Promise<AssembledTransaction<ContractResult<null>>>;
  claim(): Promise<AssembledTransaction<ContractResult<null>>>;
  reclaim(): Promise<AssembledTransaction<ContractResult<null>>>;
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
  params: { seller: string; attestor: string; amount: bigint; deadline: bigint },
): Promise<string | undefined> {
  const start = Date.now();
  try {
    const client = await clientFor(contractId, buyer);
    const tx = await client.create({
      buyer: buyer.publicKey(),
      seller: params.seller,
      attestor: params.attestor,
      token: config.paymentTokenContractId,
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
    const tx = await client.attest();
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

export interface EscrowRegistryContract {
  create_order(args: {
    order_id: bigint;
    buyer: string;
    seller: string;
    attestor: string;
    token: string;
    amount: bigint;
    deadline: bigint;
  }): Promise<AssembledTransaction<ContractResult<null>>>;
  attest(args: { order_id: bigint }): Promise<AssembledTransaction<ContractResult<null>>>;
  claim(args: { order_id: bigint }): Promise<AssembledTransaction<ContractResult<null>>>;
  reclaim(args: { order_id: bigint }): Promise<AssembledTransaction<ContractResult<null>>>;
  get_order(args: {
    order_id: bigint;
  }): Promise<AssembledTransaction<ContractResult<RawOrder & { order_id: bigint }>>>;
}

export interface OnChainOrder {
  buyer: string;
  seller: string;
  attestor: string;
  token: string;
  amount: bigint;
  deadline: bigint;
  status: string;
}

export async function readOnChainOrder(contractId: string): Promise<OnChainOrder> {
  const client = await ContractClient.from<EscrowContract>({
    ...baseClientOptions,
    contractId,
    publicKey: deployerKeypair.publicKey(),
  });
  const tx = await client.get_order();
  const raw = unwrap(tx.result);
  return { ...raw, status: raw.status.tag };
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
    attestor: string;
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
      attestor: params.attestor,
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
    const tx = await client.attest({ order_id: orderId });
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
  return { ...raw, status: raw.status.tag };
}
