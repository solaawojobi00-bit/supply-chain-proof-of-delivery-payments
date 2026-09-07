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

  it("rejects missing required fields with informative messages", () => {
    const result = createOrderSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toContain("sellerAddress");
      expect(formatted).toContain("attestorAddress");
      expect(formatted).toContain("amountStroops");
      expect(formatted).toContain("deadlineSeconds");
    }
  });
});
