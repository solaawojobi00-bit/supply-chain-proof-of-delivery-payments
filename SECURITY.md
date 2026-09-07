# Security Policy

## Supported Versions

| Version / Scope | Supported          |
| --------------- | ------------------ |
| Phase 1 (`main` branch) | :white_check_mark: |
| Older releases / branches | :x:                |

Only the current Phase 1 implementation on the `main` branch is actively supported and maintained for security updates.

## Secret Management & Key Safety

- **Never Commit Secret Keys**: Although keys configured for this project operate on Stellar Testnet, testnet secret keys (`S...` Stellar seeds or private keys) must never be committed to the repository.
- **Environment Configuration**: Real secrets belong exclusively in untracked `.env` files (which are gitignored). Only placeholder templates (such as `backend/.env.example`) should appear in version control.
- **Automated Scanning**: All pull requests and pushes to `main` are continuously scanned for secret leaks via Gitleaks CI (`.github/workflows/gitleaks.yml`).

## Reporting a Vulnerability

Because this project interfaces with an escrow smart contract that holds and manages funds on the Stellar Testnet, please **do NOT** report security vulnerabilities through public GitHub issues or discussions.

If you discover a security vulnerability, please report it privately:

- **Email**: `sola.awojobi00@gmail.com`
- **Subject line**: `[SECURITY] Supply Chain Proof of Delivery - <Brief Description>`

Please include as much detail as possible to help us reproduce and understand the vulnerability:
- A description of the issue and its potential impact.
- Steps to reproduce the issue or proof-of-concept code/transactions.
- Affected contracts, endpoints, or components.

### Expected Response Times

- **Initial Acknowledgement**: Within 48 hours of receipt.
- **Triage & Assessment**: Within 7 business days.
- **Resolution & Disclosure**: Updates will be coordinated privately until a patch is deployed.
