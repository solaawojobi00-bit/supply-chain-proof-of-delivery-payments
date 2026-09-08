import { Router, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "./httpError.js";
import { verifyRole } from "./auth.js";
import {
  attestOrder,
  buildUnsignedAttest,
  buildUnsignedCancel,
  buildUnsignedClaim,
  buildUnsignedCreateOrder,
  buildUnsignedDispute,
  buildUnsignedReclaim,
  buildUnsignedResolve,
  cancelOrder,
  claimOrder,
  createOrder,
  disputeOrder,
  getAllOrders,
  getOrderById,
  getOrderWithChainState,
  lifecycleLabel,
  reclaimOrder,
  resolveDispute,
  submitSignedTx,
} from "./orderService.js";
import {
  attestOrderSchema,
  buildTxSchema,
  createOrderSchema,
  disputeOrderSchema,
  formatZodError,
  iotEventSchema,
  registerAttestorSchema,
  resolveDisputeSchema,
  submitSignedTxSchema,
} from "./schemas.js";
import { getAttestorById, listAttestors, registerAttestor } from "./attestorDirectory.js";
import { processIoTTelemetryEvent } from "./integrations/iotAttestation.js";
import { getOrderByIdempotencyKey, type OrderRow } from "./db.js";
import { mutatingRateLimiter } from "./rateLimit.js";

export const router = Router();

router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

router.post(
  "/integrations/iot/events",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const parseResult = iotEventSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpError(400, formatZodError(parseResult.error));
    }

    const signature =
      req.header("x-iot-signature") ||
      (req.header("authorization")?.startsWith("Signature ")
        ? req.header("authorization")?.slice(10)
        : undefined);
    const secret =
      req.header("x-iot-secret") ||
      (req.header("authorization")?.startsWith("Bearer ")
        ? req.header("authorization")?.slice(7)
        : undefined);

    const result = await processIoTTelemetryEvent(parseResult.data, {
      signature,
      secret,
    });

    res.status(200).json(result);
  }),
);

router.post(
  "/attestors",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const parseResult = registerAttestorSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpError(400, formatZodError(parseResult.error));
    }
    const registered = registerAttestor(parseResult.data);
    res.status(201).json(registered);
  }),
);

router.get(
  "/attestors",
  asyncHandler(async (req, res) => {
    const { coverageArea, minScore, active } = req.query as Record<string, string | undefined>;
    const minScoreNum = minScore ? Number(minScore) : undefined;
    const activeOnly = active !== undefined ? active === "true" : true;
    const attestors = listAttestors({
      coverageArea,
      minScore: !isNaN(minScoreNum!) ? minScoreNum : undefined,
      activeOnly,
    });
    res.json(attestors);
  }),
);

router.get(
  "/attestors/:id",
  asyncHandler(async (req, res) => {
    const attestor = getAttestorById(String(req.params.id));
    if (!attestor) {
      throw new HttpError(404, `Attestor ${req.params.id} not found`);
    }
    res.json(attestor);
  }),
);

function serialize(order: OrderRow) {
  const attestors: string[] = order.attestors
    ? JSON.parse(order.attestors)
    : [order.attestor_address];
  const confirmations: string[] = order.confirmations ? JSON.parse(order.confirmations) : [];

  return {
    id: order.id,
    contractId: order.contract_id,
    buyerAddress: order.buyer_address,
    sellerAddress: order.seller_address,
    attestorAddress: order.attestor_address,
    attestors,
    threshold: order.threshold ?? 1,
    confirmations,
    arbiterAddress: order.arbiter_address ?? null,
    tokenContractId: order.token_contract_id,
    amountStroops: order.amount,
    deadline: order.deadline,
    status: order.status,
    lifecycle: lifecycleLabel(order),
    evidenceHash: order.evidence_hash ?? null,
    tokens: {
      buyer: order.buyer_token ?? null,
      seller: order.seller_token ?? null,
      attestor: order.attestor_token ?? null,
      arbiter: order.arbiter_token ?? null,
    },
    webhookUrl: order.webhook_url ?? null,
    txHashes: {
      create: order.create_tx_hash,
      attest: order.attest_tx_hash,
      claim: order.claim_tx_hash,
      reclaim: order.reclaim_tx_hash,
      cancel: order.cancel_tx_hash ?? null,
      dispute: order.dispute_tx_hash ?? null,
      resolve: order.resolve_tx_hash ?? null,
    },
    createdAt: order.created_at,
  };
}

function isUnsignedRequested(req: Request): boolean {
  return (
    req.query.unsigned === "true" ||
    req.query.mode === "unsigned" ||
    req.header("x-unsigned") === "true" ||
    Boolean(
      req.body &&
      typeof req.body === "object" &&
      (req.body as Record<string, unknown>).unsigned === true,
    )
  );
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

router.post(
  "/orders",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const rawIdempotencyKey = req.header("idempotency-key") || req.header("x-idempotency-key");
    const idempotencyKey =
      typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : undefined;

    const parseResult = createOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpError(400, formatZodError(parseResult.error));
    }
    const {
      sellerAddress,
      buyerAddress,
      attestorAddress,
      attestorId,
      attestors,
      threshold,
      arbiterAddress,
      amountStroops,
      deadlineSeconds,
      tokenContractId,
      webhookUrl,
    } = parseResult.data;
    const normalizedPayload = JSON.stringify({
      sellerAddress,
      buyerAddress,
      attestorAddress,
      attestorId,
      attestors,
      threshold,
      arbiterAddress,
      amountStroops,
      deadlineSeconds,
      tokenContractId,
      webhookUrl,
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

    if (isUnsignedRequested(req)) {
      const { unsignedTxXdr, order } = await buildUnsignedCreateOrder(
        {
          sellerAddress,
          buyerAddress,
          attestorAddress,
          attestorId,
          attestors,
          threshold,
          arbiterAddress,
          amountStroops: BigInt(amountStroops),
          deadlineSeconds: BigInt(deadlineSeconds),
          tokenContractId,
          webhookUrl,
        },
        idempotencyKey,
        normalizedPayload,
      );
      res.status(201).json({
        unsignedTxXdr,
        action: "create",
        order: serialize(order),
      });
      return;
    }

    const order = await createOrder(
      {
        sellerAddress,
        buyerAddress,
        attestorAddress,
        attestorId,
        attestors,
        threshold,
        arbiterAddress,
        amountStroops: BigInt(amountStroops),
        deadlineSeconds: BigInt(deadlineSeconds),
        tokenContractId,
        webhookUrl,
      },
      idempotencyKey,
      normalizedPayload,
    );
    res.status(201).json(serialize(order));
  }),
);

router.get(
  "/orders",
  asyncHandler(async (req, res) => {
    let orders = getAllOrders();
    const { role, address, buyer, seller, attestor, arbiter, status } = req.query as Record<
      string,
      string | undefined
    >;

    if (status) {
      orders = orders.filter((o) => o.status.toLowerCase() === status.toLowerCase());
    }

    if (buyer) {
      orders = orders.filter((o) => o.buyer_address === buyer);
    }
    if (seller) {
      orders = orders.filter((o) => o.seller_address === seller);
    }
    if (attestor) {
      orders = orders.filter((o) => {
        if (o.attestor_address === attestor) return true;
        try {
          const list = JSON.parse(o.attestors || "[]");
          return Array.isArray(list) && list.includes(attestor);
        } catch {
          return false;
        }
      });
    }
    if (arbiter) {
      orders = orders.filter((o) => o.arbiter_address === arbiter);
    }

    if (role && address) {
      if (role === "buyer") {
        orders = orders.filter((o) => o.buyer_address === address);
      } else if (role === "seller") {
        orders = orders.filter((o) => o.seller_address === address);
      } else if (role === "attestor") {
        orders = orders.filter((o) => {
          if (o.attestor_address === address) return true;
          try {
            const list = JSON.parse(o.attestors || "[]");
            return Array.isArray(list) && list.includes(address);
          } catch {
            return false;
          }
        });
      } else if (role === "arbiter") {
        orders = orders.filter((o) => o.arbiter_address === address);
      }
    } else if (address) {
      orders = orders.filter((o) => {
        if (
          o.buyer_address === address ||
          o.seller_address === address ||
          o.attestor_address === address ||
          o.arbiter_address === address
        ) {
          return true;
        }
        try {
          const list = JSON.parse(o.attestors || "[]");
          return Array.isArray(list) && list.includes(address);
        } catch {
          return false;
        }
      });
    }

    res.json(orders.map(serialize));
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
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const orderId = String(req.params.id);
    const order = getOrderById(orderId);
    verifyRole(req, order, "attestor");

    let attestorAddress: string | undefined;
    if (req.body && Object.keys(req.body).length > 0) {
      const parseResult = attestOrderSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new HttpError(400, formatZodError(parseResult.error));
      }
      attestorAddress = parseResult.data.attestorAddress;
    }

    if (isUnsignedRequested(req)) {
      const result = await buildUnsignedAttest(orderId, attestorAddress);
      res.json(result);
      return;
    }

    res.json(serialize(await attestOrder(orderId, attestorAddress)));
  }),
);

router.post(
  "/orders/:id/claim",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const orderId = String(req.params.id);
    const order = getOrderById(orderId);
    verifyRole(req, order, "seller");

    if (isUnsignedRequested(req)) {
      const result = await buildUnsignedClaim(orderId);
      res.json(result);
      return;
    }
    res.json(serialize(await claimOrder(orderId)));
  }),
);

router.post(
  "/orders/:id/reclaim",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const orderId = String(req.params.id);
    const order = getOrderById(orderId);
    verifyRole(req, order, "buyer");

    if (isUnsignedRequested(req)) {
      const result = await buildUnsignedReclaim(orderId);
      res.json(result);
      return;
    }
    res.json(serialize(await reclaimOrder(orderId)));
  }),
);

router.post(
  "/orders/:id/cancel",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const orderId = String(req.params.id);
    const order = getOrderById(orderId);
    verifyRole(req, order, ["buyer", "seller"]);

    if (isUnsignedRequested(req)) {
      const callerAddress =
        typeof req.body === "object" && req.body && typeof req.body.callerAddress === "string"
          ? req.body.callerAddress
          : undefined;
      const result = await buildUnsignedCancel(orderId, callerAddress);
      res.json(result);
      return;
    }
    res.json(serialize(await cancelOrder(orderId)));
  }),
);

router.post(
  "/orders/:id/dispute",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const orderId = String(req.params.id);
    const order = getOrderById(orderId);
    verifyRole(req, order, "buyer");

    let evidenceHash: string | undefined;
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      const parseResult = disputeOrderSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new HttpError(400, formatZodError(parseResult.error));
      }
      evidenceHash = parseResult.data.evidenceHash;
    }

    if (isUnsignedRequested(req)) {
      const buyerAddress =
        typeof req.body === "object" && req.body && typeof req.body.buyerAddress === "string"
          ? req.body.buyerAddress
          : undefined;
      const result = await buildUnsignedDispute(orderId, buyerAddress, evidenceHash);
      res.json(result);
      return;
    }
    res.json(serialize(await disputeOrder(orderId, evidenceHash)));
  }),
);

router.post(
  "/orders/:id/resolve",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const orderId = String(req.params.id);
    const order = getOrderById(orderId);
    verifyRole(req, order, "arbiter");

    const parseResult = resolveDisputeSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpError(400, formatZodError(parseResult.error));
    }

    if (isUnsignedRequested(req)) {
      const arbiterAddress =
        typeof req.body === "object" && req.body && typeof req.body.arbiterAddress === "string"
          ? req.body.arbiterAddress
          : undefined;
      const result = await buildUnsignedResolve(
        orderId,
        parseResult.data.releaseToSeller,
        arbiterAddress,
      );
      res.json(result);
      return;
    }

    res.json(serialize(await resolveDispute(orderId, parseResult.data.releaseToSeller)));
  }),
);

router.post(
  "/orders/:id/build-tx",
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const orderId = String(req.params.id);
    const order = getOrderById(orderId);

    const parseResult = buildTxSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpError(400, formatZodError(parseResult.error));
    }
    const { action, attestorAddress, callerAddress, evidenceHash, releaseToSeller } =
      parseResult.data;

    switch (action) {
      case "attest":
        verifyRole(req, order, "attestor");
        res.json(await buildUnsignedAttest(orderId, attestorAddress));
        break;
      case "claim":
        verifyRole(req, order, "seller");
        res.json(await buildUnsignedClaim(orderId));
        break;
      case "reclaim":
        verifyRole(req, order, "buyer");
        res.json(await buildUnsignedReclaim(orderId));
        break;
      case "cancel":
        verifyRole(req, order, ["buyer", "seller"]);
        res.json(await buildUnsignedCancel(orderId, callerAddress));
        break;
      case "dispute":
        verifyRole(req, order, "buyer");
        res.json(await buildUnsignedDispute(orderId, callerAddress, evidenceHash));
        break;
      case "resolve":
        verifyRole(req, order, "arbiter");
        if (releaseToSeller === undefined) {
          throw new HttpError(400, "releaseToSeller is required when action is resolve");
        }
        res.json(await buildUnsignedResolve(orderId, releaseToSeller, callerAddress));
        break;
    }
  }),
);

router.post(
  ["/tx/submit", "/orders/:id/submit"],
  mutatingRateLimiter,
  asyncHandler(async (req, res) => {
    const parseResult = submitSignedTxSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new HttpError(400, formatZodError(parseResult.error));
    }
    const orderId = parseResult.data.orderId ?? (req.params.id ? String(req.params.id) : undefined);
    if (orderId) {
      const order = getOrderById(orderId);
      const action = parseResult.data.action;
      if (action === "attest") {
        verifyRole(req, order, "attestor");
      } else if (action === "claim") {
        verifyRole(req, order, "seller");
      } else if (action === "reclaim" || action === "dispute") {
        verifyRole(req, order, "buyer");
      } else if (action === "cancel") {
        verifyRole(req, order, ["buyer", "seller"]);
      } else if (action === "resolve") {
        verifyRole(req, order, "arbiter");
      } else {
        verifyRole(req, order, ["buyer", "seller", "attestor", "arbiter"]);
      }
    }
    const result = await submitSignedTx(
      parseResult.data.signedXdr,
      orderId,
      parseResult.data.action,
    );
    res.json({
      txHash: result.txHash,
      status: result.status,
      order: result.order ? serialize(result.order) : undefined,
    });
  }),
);
