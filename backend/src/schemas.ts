import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

function isValidStellarAddress(val: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(val);
  } catch {
    return false;
  }
}

export const createOrderSchema = z.object({
  sellerAddress: z
    .string({ message: "sellerAddress is required" })
    .min(1, { message: "sellerAddress is required" })
    .refine(isValidStellarAddress, {
      message: "sellerAddress must be a valid Stellar public key (G...)",
    }),
  attestorAddress: z
    .string({ message: "attestorAddress is required" })
    .min(1, { message: "attestorAddress is required" })
    .refine(isValidStellarAddress, {
      message: "attestorAddress must be a valid Stellar public key (G...)",
    }),
  amountStroops: z
    .string({ message: "amountStroops is required" })
    .min(1, { message: "amountStroops is required" })
    .regex(/^[1-9]\d*$/, {
      message: "amountStroops must be a positive integer string",
    }),
  deadlineSeconds: z
    .string({ message: "deadlineSeconds is required" })
    .min(1, { message: "deadlineSeconds is required" })
    .regex(/^[1-9]\d*$/, {
      message: "deadlineSeconds must be a positive integer string",
    })
    .refine(
      (val) => {
        try {
          const deadline = BigInt(val);
          const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
          return deadline > nowSeconds;
        } catch {
          return false;
        }
      },
      {
        message: "deadlineSeconds must be a timestamp in the future",
      },
    ),
});

export type CreateOrderBody = z.infer<typeof createOrderSchema>;

export function formatZodError(error: z.ZodError): string {
  const issues = error.issues || (error as unknown as { errors?: z.ZodIssue[] }).errors || [];
  return issues
    .map((issue: z.ZodIssue) => {
      const field = Array.isArray(issue.path) ? issue.path.join(".") : "";
      if (field && issue.message && !issue.message.includes(field)) {
        return `${field}: ${issue.message}`;
      }
      return issue.message;
    })
    .join("; ");
}
