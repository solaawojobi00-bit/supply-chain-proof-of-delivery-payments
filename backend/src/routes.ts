import { Router, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "./httpError.js";
import {
  attestOrder,
  claimOrder,
  createOrder,
  getAllOrders,
  getOrderWithChainState,
  lifecycleLabel,
  reclaimOrder,
} from "./orderService.js";
import { getOrderByIdempotencyKey, type OrderRow } from "./db.js";
import { createOrderSchema, formatZodError } from "./schemas.js";

export const router = Router();

router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

function serialize(order: OrderRow) {
  return {
    id: order.id,
    contractId: order.contract_id,
    buyerAddress: order.buyer_address,
    sellerAddress: order.seller_address,
    attestorAddress: order.attestor_address,
    tokenContractId: order.token_contract_id,
    amountStroops: order.amount,
    deadline: order.deadline,
    status: order.status,
    lifecycle: lifecycleLabel(order),
    txHashes: {
      create: order.create_tx_hash,
      attest: order.attest_tx_hash,
      claim: order.claim_tx_hash,
      reclaim: order.reclaim_tx_hash,
    },
    createdAt: order.created_at,
  };
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

router.post(
  "/orders",
  asyncHandler(async (req, res) => {
    const rawIdempotencyKey = req.header("idempotency-key") || req.header("x-idempotency-key");
    const idempotencyKey =
      typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : undefined;

    const parseResult = createOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpError(400, formatZodError(parseResult.error));
    }
    const { sellerAddress, attestorAddress, amountStroops, deadlineSeconds } = parseResult.data;
    const normalizedPayload = JSON.stringify({
      sellerAddress,
      attestorAddress,
      amountStroops,
      deadlineSeconds,
    });

    if (idempotencyKey) {
      const existing = getOrderByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.request_payload && existing.request_payload !== normalizedPayload) {
          throw new HttpError(
            409,
            "Idempotency key was previously used with a different request body",
          );
        }
        res.status(200).json(serialize(existing));
        return;
      }
    }

    const order = await createOrder(
      {
        sellerAddress,
        attestorAddress,
        amountStroops: BigInt(amountStroops),
        deadlineSeconds: BigInt(deadlineSeconds),
      },
      idempotencyKey,
      normalizedPayload,
    );
    res.status(201).json(serialize(order));
  }),
);

router.get(
  "/orders",
  asyncHandler(async (_req, res) => {
    res.json(getAllOrders().map(serialize));
  }),
);

router.get(
  "/orders/:id",
  asyncHandler(async (req, res) => {
    const { order, onChain, lifecycle } = await getOrderWithChainState(String(req.params.id));
    res.json({
      ...serialize(order),
      lifecycle,
      onChain: {
        ...onChain,
        amount: onChain.amount.toString(),
        deadline: onChain.deadline.toString(),
      },
    });
  }),
);

router.post(
  "/orders/:id/attest",
  asyncHandler(async (req, res) => {
    res.json(serialize(await attestOrder(String(req.params.id))));
  }),
);

router.post(
  "/orders/:id/claim",
  asyncHandler(async (req, res) => {
    res.json(serialize(await claimOrder(String(req.params.id))));
  }),
);

router.post(
  "/orders/:id/reclaim",
  asyncHandler(async (req, res) => {
    res.json(serialize(await reclaimOrder(String(req.params.id))));
  }),
);
