/**
 * End-to-end demo against the running backend + real Stellar testnet.
 *
 * Usage (with the backend already running via `npm run dev`):
 *   npm run demo:claim     # create -> attest -> claim
 *   npm run demo:reclaim   # create with a short deadline -> deadline passes -> reclaim
 */
import { config } from "../src/config.js";
import { attestorKeypair, sellerKeypair } from "../src/keys.js";

const BASE_URL = `http://localhost:${config.port}`;

interface OrderResponse {
  id: string;
  status: string;
  [key: string]: unknown;
}

async function api(method: string, path: string, body?: unknown): Promise<OrderResponse> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json as OrderResponse;
}

function log(step: string, data: unknown) {
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(data, null, 2));
}

function assertStatus(order: { status: string }, expected: string) {
  if (order.status !== expected) {
    throw new Error(`Expected status ${expected}, got ${order.status}`);
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const tokenArg = process.argv.find((arg) => arg.startsWith("--token="))?.split("=")[1];
const tokenContractId = tokenArg || process.env.DEMO_TOKEN_CONTRACT_ID;

async function runClaimPath() {
  console.log("Demo: create -> attest -> claim (delivery confirmed before deadline)");

  const deadlineSeconds = Math.floor(Date.now() / 1000) + 3600;
  const order = await api("POST", "/orders", {
    sellerAddress: sellerKeypair.publicKey(),
    attestorAddress: attestorKeypair.publicKey(),
    amountStroops: "500000000",
    deadlineSeconds: String(deadlineSeconds),
    tokenContractId,
  });
  log("1. Order created (funds escrowed on testnet)", order);
  assertStatus(order, "Created");

  const attested = await api("POST", `/orders/${order.id}/attest`);
  log("2. Attestor confirmed delivery", attested);
  assertStatus(attested, "Attested");

  const claimed = await api("POST", `/orders/${order.id}/claim`);
  log("3. Seller claimed the escrowed funds", claimed);
  assertStatus(claimed, "Claimed");

  console.log("\nClaim path complete: funds moved buyer -> escrow -> seller on Stellar testnet.");
}

async function runReclaimPath() {
  console.log("Demo: create -> deadline passes with no attestation -> buyer reclaims");

  const deadlineSeconds = Math.floor(Date.now() / 1000) + 15;
  const order = await api("POST", "/orders", {
    sellerAddress: sellerKeypair.publicKey(),
    attestorAddress: attestorKeypair.publicKey(),
    amountStroops: "250000000",
    deadlineSeconds: String(deadlineSeconds),
    tokenContractId,
  });
  log("1. Order created with a 15s deadline (funds escrowed on testnet)", order);
  assertStatus(order, "Created");

  const waitMs = deadlineSeconds * 1000 - Date.now() + 3000;
  console.log(
    `\nWaiting ${Math.ceil(waitMs / 1000)}s for the deadline to pass without attestation...`,
  );
  await sleep(Math.max(waitMs, 0));

  const reclaimed = await api("POST", `/orders/${order.id}/reclaim`);
  log("2. Buyer reclaimed the funds after the deadline passed", reclaimed);
  assertStatus(reclaimed, "Reclaimed");

  console.log(
    "\nReclaim path complete: funds moved buyer -> escrow -> back to buyer on Stellar testnet.",
  );
}

const mode = process.argv[2]?.startsWith("--") ? process.argv[3] : process.argv[2];
if (mode === "claim" || process.argv.includes("claim")) {
  await runClaimPath();
} else if (mode === "reclaim" || process.argv.includes("reclaim")) {
  await runReclaimPath();
} else {
  console.error("Usage: tsx demo/demo.ts <claim|reclaim> [--token=<contractId>]");
  process.exit(1);
}
