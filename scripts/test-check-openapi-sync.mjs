#!/usr/bin/env node

/**
 * test-check-openapi-sync.mjs
 *
 * Test harness for scripts/check-openapi-sync.mjs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOpenApiRoutes,
  extractExpressRoutes,
  normalizeExpressPath,
  compareRoutes,
  runOpenApiSyncCheck,
} from './check-openapi-sync.mjs';

describe('check-openapi-sync test harness', () => {
  describe('extractOpenApiRoutes', () => {
    it('returns empty array for empty, null, or undefined input', () => {
      assert.deepStrictEqual(extractOpenApiRoutes(''), []);
      assert.deepStrictEqual(extractOpenApiRoutes(null), []);
      assert.deepStrictEqual(extractOpenApiRoutes(undefined), []);
    });

    it('extracts path endpoints and methods correctly', () => {
      const yaml = `
openapi: 3.0.3
info:
  title: Test API
paths:
  /orders:
    get:
      summary: List orders
    post:
      summary: Create order
  /orders/{id}:
    get:
      summary: Get order
    delete:
      summary: Cancel order
components:
  schemas:
    Order:
      type: object
`;
      const routes = extractOpenApiRoutes(yaml);
      assert.deepStrictEqual(routes, [
        { method: 'GET', path: '/orders' },
        { method: 'POST', path: '/orders' },
        { method: 'GET', path: '/orders/{id}' },
        { method: 'DELETE', path: '/orders/{id}' },
      ]);
    });

    it('ignores non-paths sections and comments', () => {
      const yaml = `
# Comment
info:
  title: Test API
servers:
  - url: http://localhost:3000
paths:
  /health:
    get:
      summary: Health check
components:
  schemas:
    Health:
      type: object
`;
      const routes = extractOpenApiRoutes(yaml);
      assert.deepStrictEqual(routes, [{ method: 'GET', path: '/health' }]);
    });
  });

  describe('extractExpressRoutes & normalizeExpressPath', () => {
    it('normalizes Express path params :param to OpenAPI {param}', () => {
      assert.strictEqual(normalizeExpressPath('/orders/:id'), '/orders/{id}');
      assert.strictEqual(normalizeExpressPath('/orders/:orderId/items/:itemId'), '/orders/{orderId}/items/{itemId}');
      assert.strictEqual(normalizeExpressPath('/health'), '/health');
      assert.strictEqual(normalizeExpressPath(''), '');
    });

    it('extracts standard Express router registrations', () => {
      const code = `
router.get("/health", (req, res) => {});
router.post('/orders', asyncHandler(async (req, res) => {}));
router.get("/orders/:id", asyncHandler(async (req, res) => {}));
router.delete("/orders/:id", asyncHandler(async (req, res) => {}));
`;
      const routes = extractExpressRoutes(code);
      assert.deepStrictEqual(routes, [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/orders' },
        { method: 'GET', path: '/orders/{id}' },
        { method: 'DELETE', path: '/orders/{id}' },
      ]);
    });

    it('extracts array of routes properly', () => {
      const code = `
router.post(
  ["/tx/submit", "/orders/:id/submit"],
  asyncHandler(async (req, res) => {}),
);
`;
      const routes = extractExpressRoutes(code);
      assert.deepStrictEqual(routes, [
        { method: 'POST', path: '/tx/submit' },
        { method: 'POST', path: '/orders/{id}/submit' },
      ]);
    });
  });

  describe('compareRoutes', () => {
    it('returns ok: true when code and spec match perfectly', () => {
      const codeRoutes = [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/orders' },
      ];
      const specRoutes = [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/orders' },
      ];

      const result = compareRoutes(codeRoutes, specRoutes);
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.missingInSpec, []);
      assert.deepStrictEqual(result.missingInCode, []);
    });

    it('detects routes missing from the OpenAPI spec', () => {
      const codeRoutes = [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/orders' },
      ];
      const specRoutes = [{ method: 'POST', path: '/orders' }];

      const result = compareRoutes(codeRoutes, specRoutes);
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.missingInSpec, ['GET /health']);
      assert.deepStrictEqual(result.missingInCode, []);
    });

    it('detects spec paths with no implementing route in code', () => {
      const codeRoutes = [{ method: 'POST', path: '/orders' }];
      const specRoutes = [
        { method: 'POST', path: '/orders' },
        { method: 'DELETE', path: '/orders/{id}' },
      ];

      const result = compareRoutes(codeRoutes, specRoutes);
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.missingInSpec, []);
      assert.deepStrictEqual(result.missingInCode, ['DELETE /orders/{id}']);
    });

    it('detects bidirectional mismatches', () => {
      const codeRoutes = [{ method: 'GET', path: '/health' }];
      const specRoutes = [{ method: 'POST', path: '/legacy' }];

      const result = compareRoutes(codeRoutes, specRoutes);
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.missingInSpec, ['GET /health']);
      assert.deepStrictEqual(result.missingInCode, ['POST /legacy']);
    });
  });

  describe('runOpenApiSyncCheck gate execution', () => {
    it('passes (exitCode 0) against the current workspace files', () => {
      const exitCode = runOpenApiSyncCheck();
      assert.strictEqual(exitCode, 0);
    });

    it('returns error (exitCode 1) if spec file does not exist', () => {
      const exitCode = runOpenApiSyncCheck({
        openapiPath: './non-existent-spec.yaml',
      });
      assert.strictEqual(exitCode, 1);
    });
  });
});
