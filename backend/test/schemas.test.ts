import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createOrderSchema, formatZodError } from "../src/schemas.js";

describe("Schema Validation (schemas.ts)", () => {
  const sellerKeypair = Keypair.random();
  const attestorKeypair = Keypair.random();

  it("validates valid order input successfully", () => {
    const futureDeadline = String(Math.floor(Date.now() / 1000) + 3600);
    const result = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: futureDeadline,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid/malformed Stellar addresses", () => {
    const futureDeadline = String(Math.floor(Date.now() / 1000) + 3600);
    const result = createOrderSchema.safeParse({
      sellerAddress: "invalid-stellar-address",
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: futureDeadline,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toContain("sellerAddress");
      expect(formatted).toContain("valid Stellar public key");
    }
  });

  it("rejects non-positive and malformed amountStroops", () => {
    const futureDeadline = String(Math.floor(Date.now() / 1000) + 3600);
    const zeroRes = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "0",
      deadlineSeconds: futureDeadline,
    });
    expect(zeroRes.success).toBe(false);

    const negRes = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "-500",
      deadlineSeconds: futureDeadline,
    });
    expect(negRes.success).toBe(false);

    const nonNumRes = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "abc",
      deadlineSeconds: futureDeadline,
    });
    expect(nonNumRes.success).toBe(false);
  });

  it("rejects past and non-numeric deadlineSeconds", () => {
    const pastDeadline = String(Math.floor(Date.now() / 1000) - 100);
    const pastRes = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: pastDeadline,
    });
    expect(pastRes.success).toBe(false);
    if (!pastRes.success) {
      const formatted = formatZodError(pastRes.error);
      expect(formatted).toContain("deadlineSeconds");
      expect(formatted).toContain("future");
    }

    const textRes = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: "not-a-number",
    });
    expect(textRes.success).toBe(false);
  });

  it("accepts valid tokenContractId and rejects malformed tokenContractId", () => {
    const futureDeadline = String(Math.floor(Date.now() / 1000) + 3600);
    // Valid 32-byte contract ID encoded with StrKey
    const validContractId = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

    const validRes = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: futureDeadline,
      tokenContractId: validContractId,
    });
    expect(validRes.success).toBe(true);

    const invalidRes = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: futureDeadline,
      tokenContractId: "invalid-token-contract-id",
    });
    expect(invalidRes.success).toBe(false);
    if (!invalidRes.success) {
      const formatted = formatZodError(invalidRes.error);
      expect(formatted).toContain("tokenContractId");
      expect(formatted).toContain("valid Stellar contract address");
    }
  });

  it("validates M-of-N multi-attestor array and threshold", () => {
    const futureDeadline = String(Math.floor(Date.now() / 1000) + 3600);
    const attestor2 = Keypair.random();
    const attestor3 = Keypair.random();

    // Valid 2-of-3 setup
    const validMulti = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestors: [attestorKeypair.publicKey(), attestor2.publicKey(), attestor3.publicKey()],
      threshold: 2,
      amountStroops: "10000000",
      deadlineSeconds: futureDeadline,
    });
    expect(validMulti.success).toBe(true);

    // Invalid threshold (exceeds attestors count)
    const invalidThreshold = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestors: [attestorKeypair.publicKey(), attestor2.publicKey()],
      threshold: 3,
      amountStroops: "10000000",
      deadlineSeconds: futureDeadline,
    });
    expect(invalidThreshold.success).toBe(false);
    if (!invalidThreshold.success) {
      const formatted = formatZodError(invalidThreshold.error);
      expect(formatted).toContain("threshold");
    }

    // Invalid threshold = 0
    const zeroThreshold = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      attestors: [attestorKeypair.publicKey()],
      threshold: 0,
      amountStroops: "10000000",
      deadlineSeconds: futureDeadline,
    });
    expect(zeroThreshold.success).toBe(false);

    // Missing both attestors and attestorAddress
    const missingBoth = createOrderSchema.safeParse({
      sellerAddress: sellerKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: futureDeadline,
    });
    expect(missingBoth.success).toBe(false);
  });
});
