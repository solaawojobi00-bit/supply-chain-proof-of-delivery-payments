import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

function isValidStellarAddress(val: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(val);
  } catch {
    return false;
  }
}

function isValidContractAddress(val: string): boolean {
  try {
    return StrKey.isValidContract(val);
  } catch {
    return false;
  }
}

export const createOrderSchema = z
  .object({
    sellerAddress: z
      .string({ message: "sellerAddress is required" })
      .min(1, { message: "sellerAddress is required" })
      .refine(isValidStellarAddress, {
        message: "sellerAddress must be a valid Stellar public key (G...)",
      }),
    attestorAddress: z
      .string()
      .refine(isValidStellarAddress, {
        message: "attestorAddress must be a valid Stellar public key (G...)",
      })
      .optional(),
    attestors: z
      .array(
        z.string().refine(isValidStellarAddress, {
          message: "each attestor in attestors must be a valid Stellar public key (G...)",
        }),
        { message: "attestors must be an array of Stellar public keys" },
      )
      .min(1, { message: "attestors array must contain at least one address" })
      .optional(),
    threshold: z
      .number({ message: "threshold must be a number" })
      .int({ message: "threshold must be an integer" })
      .positive({ message: "threshold must be a positive integer" })
      .optional(),
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
    tokenContractId: z
      .string()
      .refine(isValidContractAddress, {
        message: "tokenContractId must be a valid Stellar contract address (C...)",
      })
      .optional(),
    arbiterAddress: z
      .string()
      .refine(isValidStellarAddress, {
        message: "arbiterAddress must be a valid Stellar public key (G...)",
      })
      .optional(),
  })
  .refine(
    (data) => Boolean(data.attestors && data.attestors.length > 0) || Boolean(data.attestorAddress),
    {
      message: "Either attestorAddress or non-empty attestors array is required",
      path: ["attestors"],
    },
  )
  .refine(
    (data) => {
      const list = data.attestors ?? (data.attestorAddress ? [data.attestorAddress] : []);
      if (data.threshold !== undefined) {
        return data.threshold >= 1 && data.threshold <= list.length;
      }
      return true;
    },
    {
      message: "threshold must be between 1 and the number of designated attestors",
      path: ["threshold"],
    },
  );

export const attestOrderSchema = z.object({
  attestorAddress: z
    .string()
    .refine(isValidStellarAddress, {
      message: "attestorAddress must be a valid Stellar public key (G...)",
    })
    .optional(),
});

export const resolveDisputeSchema = z.object({
  releaseToSeller: z.boolean({
    message: "releaseToSeller is required and must be a boolean",
  }),
});

export type CreateOrderBody = z.infer<typeof createOrderSchema>;
export type AttestOrderBody = z.infer<typeof attestOrderSchema>;
export type ResolveDisputeBody = z.infer<typeof resolveDisputeSchema>;

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
