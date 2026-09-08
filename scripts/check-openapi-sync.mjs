#!/usr/bin/env node

/**
 * check-openapi-sync.mjs
 *
 * CI check to ensure backend/openapi.yaml remains in strict parity with
 * backend/src/routes.ts route registrations.
 *
 * Design:
 *   - Extracts registered Express routes from backend/src/routes.ts.
 *   - Extracts paths and methods from backend/openapi.yaml.
 *   - Detects parity mismatches in both directions:
 *       1. Routes implemented in code but missing from openapi.yaml
 *       2. Endpoints declared in openapi.yaml but missing from code
 *   - Emits structured terminal logs and GitHub Actions annotations on failure.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Extract paths and HTTP methods declared in OpenAPI YAML content.
 * @param {string} yamlContent
 * @returns {Array<{ method: string, path: string }>}
 */
export function extractOpenApiRoutes(yamlContent) {
  if (!yamlContent || typeof yamlContent !== 'string') return [];

  const routes = [];
  const lines = yamlContent.split('\n');
  let inPaths = false;
  let currentPath = null;

  for (const line of lines) {
    // Detect top-level "paths:" key
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      currentPath = null;
      continue;
    }

    // Any other root-level key ends the "paths:" block
    if (inPaths && /^[a-zA-Z0-9_-]+:\s*/.test(line) && !/^paths:\s*$/.test(line)) {
      inPaths = false;
      currentPath = null;
      continue;
    }

    if (!inPaths) continue;

    // Detect path entries under paths, e.g. "  /orders/{id}:"
    const pathMatch = line.match(/^  (\/[^\s:#]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1].trim();
      continue;
    }

    // Detect method under the current path, e.g. "    get:" or "    post:"
    if (currentPath) {
      const methodMatch = line.match(/^    (get|post|put|delete|patch|options|head):\s*$/i);
      if (methodMatch) {
        routes.push({
          method: methodMatch[1].toUpperCase(),
          path: currentPath,
        });
      }
    }
  }

  return routes;
}

/**
 * Extract registered routes from Express routes.ts source code.
 * @param {string} sourceCode
 * @returns {Array<{ method: string, path: string }>}
 */
export function extractExpressRoutes(sourceCode) {
  if (!sourceCode || typeof sourceCode !== 'string') return [];

  const routes = [];
  // Matches router.get(...), router.post(...), etc. with string or array path argument
  const routerPattern = /(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*(\[[^\]]+\]|['"`][^'"`]+['"`])/g;

  let match;
  while ((match = routerPattern.exec(sourceCode)) !== null) {
    const method = match[1].toUpperCase();
    const rawPathArg = match[2].trim();

    if (rawPathArg.startsWith('[')) {
      // Parse array of paths, e.g. ["/tx/submit", "/orders/:id/submit"]
      const inner = rawPathArg.slice(1, -1);
      const stringMatches = inner.matchAll(/['"`]([^'"`]+)['"`]/g);
      for (const strMatch of stringMatches) {
        const normalized = normalizeExpressPath(strMatch[1]);
        routes.push({ method, path: normalized });
      }
    } else {
      const pathValue = rawPathArg.replace(/^['"`]|['"`]$/g, '');
      const normalized = normalizeExpressPath(pathValue);
      routes.push({ method, path: normalized });
    }
  }

  return routes;
}

/**
 * Normalizes an Express route path parameter syntax (:id) to OpenAPI ({id}).
 * @param {string} path
 * @returns {string}
 */
export function normalizeExpressPath(path) {
  if (!path) return '';
  return path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
}

/**
 * Compare code routes against OpenAPI spec routes.
 * @param {Array<{ method: string, path: string }>} codeRoutes
 * @param {Array<{ method: string, path: string }>} specRoutes
 * @returns {{ ok: boolean, missingInSpec: string[], missingInCode: string[] }}
 */
export function compareRoutes(codeRoutes, specRoutes) {
  const codeKeySet = new Set(codeRoutes.map((r) => `${r.method} ${r.path}`));
  const specKeySet = new Set(specRoutes.map((r) => `${r.method} ${r.path}`));

  const missingInSpec = [...codeKeySet].filter((routeKey) => !specKeySet.has(routeKey)).sort();
  const missingInCode = [...specKeySet].filter((routeKey) => !codeKeySet.has(routeKey)).sort();

  return {
    ok: missingInSpec.length === 0 && missingInCode.length === 0,
    missingInSpec,
    missingInCode,
  };
}

/**
 * Executes the OpenAPI sync check.
 */
export function runOpenApiSyncCheck({
  openapiPath = resolve(__dirname, '../backend/openapi.yaml'),
  routesPath = resolve(__dirname, '../backend/src/routes.ts'),
} = {}) {
  console.log('====================================================');
  console.log('📋  OpenAPI Route Synchronization Check');
  console.log('====================================================');

  let openapiContent = '';
  let routesContent = '';

  try {
    openapiContent = readFileSync(openapiPath, 'utf8');
  } catch (err) {
    console.error(`❌ Failed to read OpenAPI spec at ${openapiPath}: ${err.message}`);
    return 1;
  }

  try {
    routesContent = readFileSync(routesPath, 'utf8');
  } catch (err) {
    console.error(`❌ Failed to read routes source at ${routesPath}: ${err.message}`);
    return 1;
  }

  const specRoutes = extractOpenApiRoutes(openapiContent);
  const codeRoutes = extractExpressRoutes(routesContent);

  console.log(`🔍 Discovered ${codeRoutes.length} route(s) registered in routes.ts`);
  console.log(`📖 Discovered ${specRoutes.length} endpoint(s) declared in openapi.yaml\n`);

  const { ok, missingInSpec, missingInCode } = compareRoutes(codeRoutes, specRoutes);

  if (missingInSpec.length > 0) {
    console.error('❌ Routes implemented in code but missing from backend/openapi.yaml:');
    for (const route of missingInSpec) {
      console.error(`   - ${route}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::error file=backend/openapi.yaml::Missing endpoint in OpenAPI spec: ${route}`);
      }
    }
    console.log();
  }

  if (missingInCode.length > 0) {
    console.error('❌ Endpoints declared in backend/openapi.yaml but missing from routes.ts:');
    for (const route of missingInCode) {
      console.error(`   - ${route}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::error file=backend/src/routes.ts::Endpoint declared in spec but not implemented: ${route}`);
      }
    }
    console.log();
  }

  if (!ok) {
    console.error('💥 OpenAPI route parity check failed. Keep openapi.yaml and routes.ts synchronized.\n');
    return 1;
  }

  console.log('✅ All backend routes are fully synchronized with backend/openapi.yaml.\n');
  return 0;
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('check-openapi-sync.mjs'));

if (isDirectExecution) {
  const exitCode = runOpenApiSyncCheck();
  process.exit(exitCode);
}
