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
    buyerAddress: z
      .string()
      .refine(isValidStellarAddress, {
        message: "buyerAddress must be a valid Stellar public key (G...)",
      })
      .optional(),
    attestorId: z.string().min(1, { message: "attestorId cannot be empty" }).optional(),
    webhookUrl: z.string().url({ message: "webhookUrl must be a valid URL" }).optional(),
  })
  .refine(
    (data) =>
      Boolean(data.attestors && data.attestors.length > 0) ||
      Boolean(data.attestorAddress) ||
      Boolean(data.attestorId),
    {
      message: "Either attestorAddress, non-empty attestors array, or attestorId is required",
      path: ["attestors"],
    },
  )
  .refine(
    (data) => {
      const list =
        data.attestors ??
        (data.attestorAddress || data.attestorId ? [data.attestorAddress || data.attestorId!] : []);
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

export const registerAttestorSchema = z.object({
  address: z
    .string({ message: "address is required" })
    .min(1, { message: "address is required" })
    .refine(isValidStellarAddress, {
      message: "address must be a valid Stellar public key (G...)",
    }),
  name: z
    .string({ message: "name is required" })
    .trim()
    .min(2, { message: "name must be at least 2 characters" })
    .max(100, { message: "name must be at most 100 characters" }),
  description: z
    .string()
    .trim()
    .max(500, { message: "description must be at most 500 characters" })
    .optional(),
  coverageArea: z
    .string()
    .trim()
    .max(200, { message: "coverageArea must be at most 200 characters" })
    .optional(),
  feeBps: z
    .number()
    .int()
    .min(0, { message: "feeBps must be >= 0" })
    .max(10000, { message: "feeBps must be <= 10000" })
    .optional(),
});

export const updateAttestorSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  coverageArea: z.string().trim().max(200).optional(),
  feeBps: z.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
});

export type RegisterAttestorBody = z.infer<typeof registerAttestorSchema>;
export type UpdateAttestorBody = z.infer<typeof updateAttestorSchema>;

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

export const submitSignedTxSchema = z.object({
  signedXdr: z
    .string({ message: "signedXdr is required" })
    .min(1, { message: "signedXdr cannot be empty" }),
  orderId: z.string().optional(),
  action: z
    .enum(["create", "attest", "claim", "reclaim", "cancel", "dispute", "resolve"])
    .optional(),
});

export const buildTxSchema = z.object({
  action: z.enum(["attest", "claim", "reclaim", "cancel", "dispute", "resolve"], {
    message: "action must be one of: attest, claim, reclaim, cancel, dispute, resolve",
  }),
  attestorAddress: z
    .string()
    .refine(isValidStellarAddress, {
      message: "attestorAddress must be a valid Stellar public key (G...)",
    })
    .optional(),
  callerAddress: z
    .string()
    .refine(isValidStellarAddress, {
      message: "callerAddress must be a valid Stellar public key (G...)",
    })
    .optional(),
  releaseToSeller: z.boolean().optional(),
});

export type CreateOrderBody = z.infer<typeof createOrderSchema>;
export type AttestOrderBody = z.infer<typeof attestOrderSchema>;
export type ResolveDisputeBody = z.infer<typeof resolveDisputeSchema>;
export type SubmitSignedTxBody = z.infer<typeof submitSignedTxSchema>;
export type BuildTxBody = z.infer<typeof buildTxSchema>;

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
