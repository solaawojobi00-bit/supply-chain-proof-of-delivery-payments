#!/usr/bin/env node

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson,
  parseNpmAuditReport,
  parseCargoAuditReport,
  evaluateFindings,
} from './audit-deps.mjs';

describe('audit-deps test harness', () => {
  describe('extractJson', () => {
    it('returns null for null, undefined, or non-string input', () => {
      assert.strictEqual(extractJson(null), null);
      assert.strictEqual(extractJson(undefined), null);
      assert.strictEqual(extractJson(12345), null);
    });

    it('extracts JSON when surrounded by extraneous terminal text', () => {
      const text = 'npm WARN config global `--global`, `--local` are deprecated\n{"success":true,"count":0}\nDone.';
      const result = extractJson(text);
      assert.deepStrictEqual(result, { success: true, count: 0 });
    });

    it('returns null when text contains invalid JSON', () => {
      assert.strictEqual(extractJson('random { invalid json text }'), null);
    });
  });

  describe('npm audit parsing', () => {
    it('passes cleanly when no vulnerabilities are found', () => {
      const stdout = JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        },
      });

      const res = parseNpmAuditReport({ stdout });
      assert.strictEqual(res.status, 'pass');
      assert.strictEqual(res.highOrCritical.length, 0);
      assert.strictEqual(res.counts.total, 0);
    });

    it('treats low and moderate vulnerabilities as non-blocking pass', () => {
      const stdout = JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          qs: {
            name: 'qs',
            severity: 'moderate',
            via: [{ title: 'prototype pollution', url: 'https://example.com' }],
          },
          minimist: {
            name: 'minimist',
            severity: 'low',
            via: ['minimist'],
          },
        },
        metadata: {
          vulnerabilities: { info: 0, low: 1, moderate: 1, high: 0, critical: 0, total: 2 },
        },
      });

      const res = parseNpmAuditReport({ stdout });
      assert.strictEqual(res.status, 'pass');
      assert.strictEqual(res.highOrCritical.length, 0);
      assert.strictEqual(res.counts.moderate, 1);
      assert.strictEqual(res.counts.low, 1);
    });

    it('identifies and fails on high and critical vulnerabilities', () => {
      const stdout = JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          axios: {
            name: 'axios',
            severity: 'high',
            range: '<0.21.2',
            via: [{ title: 'SSRF in axios', url: 'https://github.com/advisories/GHSA-1' }],
            fixAvailable: true,
          },
          lodash: {
            name: 'lodash',
            severity: 'critical',
            range: '<4.17.21',
            via: [{ title: 'Command Injection in lodash', url: 'https://github.com/advisories/GHSA-2' }],
            fixAvailable: false,
          },
        },
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 1, total: 2 },
        },
      });

      const res = parseNpmAuditReport({ stdout });
      assert.strictEqual(res.status, 'fail');
      assert.strictEqual(res.highOrCritical.length, 2);
      assert.strictEqual(res.highOrCritical[0].package, 'axios');
      assert.strictEqual(res.highOrCritical[0].severity, 'HIGH');
      assert.strictEqual(res.highOrCritical[1].package, 'lodash');
      assert.strictEqual(res.highOrCritical[1].severity, 'CRITICAL');
    });

    it('returns warn-pass when npm registry returns an error payload', () => {
      const stdout = JSON.stringify({
        error: {
          code: 'ENOTFOUND',
          summary: 'registry.npmjs.org lookup failed',
          detail: 'DNS query timeout',
        },
      });

      const res = parseNpmAuditReport({ stdout });
      assert.strictEqual(res.status, 'warn-pass');
      assert.strictEqual(res.reason, 'registry.npmjs.org lookup failed');
      assert.strictEqual(res.highOrCritical.length, 0);
    });

    it('returns warn-pass on network connection or fetch failure', () => {
      const res = parseNpmAuditReport({
        stdout: '',
        stderr: 'npm ERR! code ECONNREFUSED\nnpm ERR! Fetch error reaching registry',
        status: 1,
      });

      assert.strictEqual(res.status, 'warn-pass');
      assert.strictEqual(res.reason, 'Registry outage / network failure');
      assert.strictEqual(res.highOrCritical.length, 0);
    });

    it('returns warn-pass on spawn error', () => {
      const res = parseNpmAuditReport({
        error: new Error('spawn npm ENOENT'),
      });

      assert.strictEqual(res.status, 'warn-pass');
      assert.strictEqual(res.highOrCritical.length, 0);
    });
  });

  describe('cargo audit parsing', () => {
    it('passes cleanly when no vulnerabilities are found', () => {
      const stdout = JSON.stringify({
        vulnerabilities: {
          found: false,
          count: 0,
          list: [],
        },
        warnings: {},
      });

      const res = parseCargoAuditReport({ stdout });
      assert.strictEqual(res.status, 'pass');
      assert.strictEqual(res.highOrCritical.length, 0);
      assert.strictEqual(res.counts.vulnerabilities, 0);
    });

    it('treats low / medium severity advisories below CVSS 7.0 as non-blocking pass', () => {
      const stdout = JSON.stringify({
        vulnerabilities: {
          found: true,
          count: 2,
          list: [
            {
              advisory: {
                id: 'RUSTSEC-2023-0001',
                package: 'some-crate',
                title: 'Minor timing side channel',
                severity: 'low',
                cvss: 3.1,
              },
            },
            {
              advisory: {
                id: 'RUSTSEC-2023-0002',
                package: 'other-crate',
                title: 'Moderate memory leak',
                severity: 'medium',
                cvss: 5.5,
              },
            },
          ],
        },
        warnings: { unmaintained: [{ package: 'old-crate' }] },
      });

      const res = parseCargoAuditReport({ stdout });
      assert.strictEqual(res.status, 'pass');
      assert.strictEqual(res.highOrCritical.length, 0);
      assert.strictEqual(res.counts.vulnerabilities, 2);
      assert.strictEqual(res.counts.warnings, 1);
    });

    it('identifies and fails on high and critical severity advisories', () => {
      const stdout = JSON.stringify({
        vulnerabilities: {
          found: true,
          count: 2,
          list: [
            {
              advisory: {
                id: 'RUSTSEC-2024-0010',
                package: 'hyper',
                title: 'High severity HTTP/2 vulnerability',
                severity: 'high',
                cvss: 7.5,
                url: 'https://rustsec.org/advisories/RUSTSEC-2024-0010',
              },
            },
            {
              advisory: {
                id: 'RUSTSEC-2024-0020',
                package: 'openssl',
                title: 'Critical RCE flaw',
                severity: 'critical',
                cvss: 9.8,
                url: 'https://rustsec.org/advisories/RUSTSEC-2024-0020',
              },
            },
          ],
        },
      });

      const res = parseCargoAuditReport({ stdout });
      assert.strictEqual(res.status, 'fail');
      assert.strictEqual(res.highOrCritical.length, 2);
      assert.strictEqual(res.highOrCritical[0].package, 'hyper');
      assert.strictEqual(res.highOrCritical[0].severity, 'HIGH');
      assert.strictEqual(res.highOrCritical[1].package, 'openssl');
      assert.strictEqual(res.highOrCritical[1].severity, 'CRITICAL');
    });

    it('flags advisories with CVSS >= 7.0 as high even if severity label is missing', () => {
      const stdout = JSON.stringify({
        vulnerabilities: {
          found: true,
          count: 1,
          list: [
            {
              advisory: {
                id: 'RUSTSEC-2024-0030',
                package: 'tokio',
                title: 'Severe flaw with CVSS score only',
                cvss: 8.2,
              },
            },
          ],
        },
      });

      const res = parseCargoAuditReport({ stdout });
      assert.strictEqual(res.status, 'fail');
      assert.strictEqual(res.highOrCritical.length, 1);
      assert.strictEqual(res.highOrCritical[0].package, 'tokio');
      assert.strictEqual(res.highOrCritical[0].severity, 'CVSS 8.2');
    });

    it('returns warn-pass when cargo-audit is not installed', () => {
      const res = parseCargoAuditReport({
        stdout: 'error: no such command: `audit`',
        stderr: 'error: no such command: `audit`',
        status: 1,
      });

      assert.strictEqual(res.status, 'warn-pass');
      assert.strictEqual(res.reason, 'cargo-audit not installed');
      assert.strictEqual(res.highOrCritical.length, 0);
    });

    it('returns warn-pass when advisory database cannot be fetched', () => {
      const res = parseCargoAuditReport({
        stdout: '',
        stderr: "error: couldn't fetch advisory database: https://github.com/rustsec/advisory-db",
        status: 1,
      });

      assert.strictEqual(res.status, 'warn-pass');
      assert.strictEqual(res.reason, 'Advisory database fetch / execution warning');
      assert.strictEqual(res.highOrCritical.length, 0);
    });
  });

  describe('evaluateFindings (gate evaluation)', () => {
    it('passes (exitCode 0) when both npm and cargo audit pass', () => {
      const npmResult = { status: 'pass', highOrCritical: [] };
      const cargoResult = { status: 'pass', highOrCritical: [] };

      const evalRes = evaluateFindings(npmResult, cargoResult);
      assert.strictEqual(evalRes.passed, true);
      assert.strictEqual(evalRes.exitCode, 0);
      assert.strictEqual(evalRes.highOrCritical.length, 0);
    });

    it('passes (exitCode 0) when one or both produce warn-pass', () => {
      const npmResult = { status: 'warn-pass', highOrCritical: [] };
      const cargoResult = { status: 'pass', highOrCritical: [] };

      const evalRes = evaluateFindings(npmResult, cargoResult);
      assert.strictEqual(evalRes.passed, true);
      assert.strictEqual(evalRes.exitCode, 0);
    });

    it('blocks (exitCode 1) when npm finds high/critical advisories', () => {
      const npmResult = {
        status: 'fail',
        highOrCritical: [{ ecosystem: 'npm', package: 'bad-pkg', severity: 'HIGH' }],
      };
      const cargoResult = { status: 'pass', highOrCritical: [] };

      const evalRes = evaluateFindings(npmResult, cargoResult);
      assert.strictEqual(evalRes.passed, false);
      assert.strictEqual(evalRes.exitCode, 1);
      assert.strictEqual(evalRes.highOrCritical.length, 1);
    });

    it('blocks (exitCode 1) when cargo finds high/critical advisories', () => {
      const npmResult = { status: 'pass', highOrCritical: [] };
      const cargoResult = {
        status: 'fail',
        highOrCritical: [{ ecosystem: 'cargo', package: 'bad-crate', severity: 'CRITICAL' }],
      };

      const evalRes = evaluateFindings(npmResult, cargoResult);
      assert.strictEqual(evalRes.passed, false);
      assert.strictEqual(evalRes.exitCode, 1);
      assert.strictEqual(evalRes.highOrCritical.length, 1);
    });
  });
});
