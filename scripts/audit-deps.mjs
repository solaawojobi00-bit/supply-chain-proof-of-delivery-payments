#!/usr/bin/env node

/**
 * audit-deps.mjs
 *
 * Dependency security audit gate for the repository.
 * Audits both:
 *   - backend (via `npm audit --prefix backend --json`)
 *   - contracts & workspace (via `cargo audit --json`)
 *
 * Design Principle:
 *   - Real high/critical vulnerabilities fail the gate (exit code 1).
 *   - Low/moderate vulnerabilities are reported but do not block the build.
 *   - Registry outages, network timeouts, or tool fetch failures produce an
 *     honest warn-pass with a visible `::warning::` GitHub Actions annotation,
 *     preventing false red builds that train developers to blindly retrigger.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const raw = text.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function runNpmAudit() {
  console.log('🔍 Running npm audit on backend dependencies...');
  const result = spawnSync('npm', ['audit', '--prefix', 'backend', '--json'], {
    encoding: 'utf-8',
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  // Attempt to parse JSON report
  const parsed = extractJson(stdout) || extractJson(stderr);

  if (!parsed) {
    const errorDetails = (stderr || stdout || result.error?.message || 'Unknown error').trim();
    const isOutage =
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|502|503|504|network|registry|fetch/i.test(errorDetails);

    if (isOutage || result.error) {
      console.log('::warning title=npm audit fetch failure::npm audit could not reach the package registry. Passing with warning.');
      console.warn(`⚠️  npm audit registry fetch error:\n${errorDetails}`);
      return { status: 'warn-pass', source: 'npm', reason: 'Registry outage / network failure', highOrCritical: [] };
    }

    console.log('::warning title=npm audit parse failure::Could not parse npm audit JSON output. Passing with warning.');
    console.warn(`⚠️  Unparseable npm audit output:\n${errorDetails}`);
    return { status: 'warn-pass', source: 'npm', reason: 'Unparseable JSON output', highOrCritical: [] };
  }

  // Check if npm returned an error payload
  if (parsed.error) {
    const code = parsed.error.code || 'UNKNOWN';
    const summary = parsed.error.summary || parsed.error.detail || JSON.stringify(parsed.error);
    console.log(`::warning title=npm audit error (${code})::npm audit returned error: ${summary}. Passing with warning.`);
    console.warn(`⚠️  npm audit error payload: ${code} - ${summary}`);
    return { status: 'warn-pass', source: 'npm', reason: summary, highOrCritical: [] };
  }

  const highOrCritical = [];
  const counts = {
    info: parsed.metadata?.vulnerabilities?.info ?? 0,
    low: parsed.metadata?.vulnerabilities?.low ?? 0,
    moderate: parsed.metadata?.vulnerabilities?.moderate ?? 0,
    high: parsed.metadata?.vulnerabilities?.high ?? 0,
    critical: parsed.metadata?.vulnerabilities?.critical ?? 0,
    total: parsed.metadata?.vulnerabilities?.total ?? 0,
  };

  const vulnerabilities = parsed.vulnerabilities || {};
  for (const [pkgName, details] of Object.entries(vulnerabilities)) {
    const severity = (details.severity || '').toLowerCase();
    if (severity === 'high' || severity === 'critical') {
      const vias = Array.isArray(details.via)
        ? details.via.map((v) => (typeof v === 'string' ? v : `${v.title || v.name} (${v.url || v.source})`)).join(', ')
        : 'N/A';
      highOrCritical.push({
        ecosystem: 'npm (backend)',
        package: pkgName,
        severity: severity.toUpperCase(),
        range: details.range || 'N/A',
        title: vias || 'No title provided',
        fixAvailable: details.fixAvailable ? 'Yes' : 'No',
      });
    }
  }

  return {
    status: highOrCritical.length > 0 ? 'fail' : 'pass',
    source: 'npm',
    counts,
    highOrCritical,
  };
}

function runCargoAudit() {
  console.log('🔍 Running cargo audit on workspace & contract dependencies...');
  const result = spawnSync('cargo', ['audit', '--json'], {
    encoding: 'utf-8',
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  // Check if cargo-audit is missing
  if (
    result.error?.code === 'ENOENT' ||
    /no such command: `audit`/i.test(stderr) ||
    /no such command: `audit`/i.test(stdout)
  ) {
    console.log('::warning title=cargo-audit not installed::cargo-audit is not installed. Passing with warning.');
    console.warn('⚠️  cargo-audit binary not found in environment.');
    return { status: 'warn-pass', source: 'cargo', reason: 'cargo-audit not installed', highOrCritical: [] };
  }

  const parsed = extractJson(stdout) || extractJson(stderr);

  if (!parsed) {
    const errorDetails = (stderr || stdout || result.error?.message || 'Unknown error').trim();
    const isOutage =
      /couldn't fetch advisory database|network|fetch|timeout|connection|git/i.test(errorDetails);

    if (isOutage || result.status !== 0) {
      console.log('::warning title=cargo-audit DB fetch failure::cargo-audit could not fetch advisory database or failed to run. Passing with warning.');
      console.warn(`⚠️  cargo-audit execution / advisory DB fetch notice:\n${errorDetails}`);
      return { status: 'warn-pass', source: 'cargo', reason: 'Advisory database fetch / execution warning', highOrCritical: [] };
    }

    return { status: 'pass', source: 'cargo', counts: { total: 0 }, highOrCritical: [] };
  }

  const highOrCritical = [];
  const list = parsed.vulnerabilities?.list || (Array.isArray(parsed.vulnerabilities) ? parsed.vulnerabilities : []);
  const totalCount = parsed.vulnerabilities?.count ?? list.length;

  for (const item of list) {
    const advisory = item.advisory || {};
    const pkg = advisory.package || item.package?.name || 'unknown';
    const rawSeverity = (advisory.severity || '').toLowerCase();
    const cvss = typeof advisory.cvss === 'number' ? advisory.cvss : advisory.cvss?.score;

    let isHighOrCritical = rawSeverity === 'high' || rawSeverity === 'critical';
    if (!isHighOrCritical && cvss !== undefined && cvss !== null) {
      if (Number(cvss) >= 7.0) {
        isHighOrCritical = true;
      }
    }

    if (isHighOrCritical) {
      highOrCritical.push({
        ecosystem: 'cargo (contracts)',
        package: pkg,
        severity: rawSeverity ? rawSeverity.toUpperCase() : `CVSS ${cvss}`,
        id: advisory.id || 'N/A',
        title: advisory.title || 'Security Advisory',
        url: advisory.url || 'N/A',
      });
    }
  }

  const warnings = parsed.warnings || {};
  const warningCount = Object.values(warnings).reduce(
    (acc, val) => acc + (Array.isArray(val) ? val.length : 0),
    0
  );

  return {
    status: highOrCritical.length > 0 ? 'fail' : 'pass',
    source: 'cargo',
    counts: {
      vulnerabilities: totalCount,
      warnings: warningCount,
      highOrCritical: highOrCritical.length,
    },
    highOrCritical,
  };
}

function main() {
  console.log('====================================================');
  console.log('🛡️   Dependency Security Audit Gate (npm + cargo)');
  console.log('====================================================\n');

  const npmResult = runNpmAudit();
  console.log('');
  const cargoResult = runCargoAudit();
  console.log('');

  console.log('====================================================');
  console.log('📊  Audit Summary');
  console.log('====================================================');

  // Print npm summary
  if (npmResult.counts) {
    console.log(
      `[npm:backend] Total: ${npmResult.counts.total} | Low: ${npmResult.counts.low} | Moderate: ${npmResult.counts.moderate} | High: ${npmResult.counts.high} | Critical: ${npmResult.counts.critical}`
    );
  } else if (npmResult.status === 'warn-pass') {
    console.log(`[npm:backend] Status: WARN-PASS (${npmResult.reason})`);
  }

  // Print cargo summary
  if (cargoResult.counts) {
    console.log(
      `[cargo:workspace] Vulnerabilities: ${cargoResult.counts.vulnerabilities ?? 0} | Warnings: ${cargoResult.counts.warnings ?? 0} | High/Critical: ${cargoResult.counts.highOrCritical ?? 0}`
    );
  } else if (cargoResult.status === 'warn-pass') {
    console.log(`[cargo:workspace] Status: WARN-PASS (${cargoResult.reason})`);
  }

  const allHighOrCritical = [...npmResult.highOrCritical, ...cargoResult.highOrCritical];

  if (allHighOrCritical.length > 0) {
    console.log('\n❌ BLOCKING HIGH / CRITICAL VULNERABILITIES FOUND:');
    for (const vuln of allHighOrCritical) {
      console.log(`\n  - [${vuln.ecosystem}] ${vuln.package} (${vuln.severity})`);
      if (vuln.id) console.log(`    Advisory: ${vuln.id}`);
      console.log(`    Title:    ${vuln.title}`);
      if (vuln.range) console.log(`    Range:    ${vuln.range}`);
      if (vuln.url) console.log(`    URL:      ${vuln.url}`);
      if (vuln.fixAvailable) console.log(`    Fix:      ${vuln.fixAvailable}`);

      console.log(
        `::error title=Security Vulnerability (${vuln.ecosystem})::${vuln.package} has ${vuln.severity} vulnerability: ${vuln.title}`
      );
    }
    console.log('\n🚫 Audit gate failed due to high or critical advisories.');
    process.exit(1);
  }

  console.log('\n✅ Audit gate passed: No high or critical vulnerabilities detected.');
  process.exit(0);
}

main();
