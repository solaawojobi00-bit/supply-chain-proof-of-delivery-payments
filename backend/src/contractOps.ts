import { Keypair } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  KeypairSigner,
  Result,
} from "@stellar/stellar-sdk/contract";
import { config } from "./config.js";
import { deployerKeypair } from "./keys.js";

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
  const assembled = await ContractClient.deploy<ContractClient & EscrowContract>(null, {
    ...baseClientOptions,
    wasmHash: config.wasmHash,
    format: "hex",
    publicKey: deployerKeypair.publicKey(),
    signTransaction: signerFor(deployerKeypair),
  });
  const sent = await assembled.signAndSend();
  const client = sent.result;
  return {
    contractId: client.options.contractId,
    txHash: sent.sendTransactionResponse?.hash,
  };
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
  return sent.sendTransactionResponse?.hash;
}

export async function callAttest(
  contractId: string,
  attestor: Keypair,
): Promise<string | undefined> {
  const client = await clientFor(contractId, attestor);
  const tx = await client.attest();
  const sent = await tx.signAndSend();
  unwrap(sent.result);
  return sent.sendTransactionResponse?.hash;
}

export async function callClaim(contractId: string, seller: Keypair): Promise<string | undefined> {
  const client = await clientFor(contractId, seller);
  const tx = await client.claim();
  const sent = await tx.signAndSend();
  unwrap(sent.result);
  return sent.sendTransactionResponse?.hash;
}

export async function callReclaim(contractId: string, buyer: Keypair): Promise<string | undefined> {
  const client = await clientFor(contractId, buyer);
  const tx = await client.reclaim();
  const sent = await tx.signAndSend();
  unwrap(sent.result);
  return sent.sendTransactionResponse?.hash;
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
