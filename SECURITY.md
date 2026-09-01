# Security Policy

## Status

This repository is experimental, testnet-only, and unaudited. It must not be used to custody real
funds or operate a public mint.

## Reporting a vulnerability

Use the repository host's private security-advisory channel when one is available. If it is not,
contact the maintainer privately and request an encrypted reporting channel before sending secrets,
proofs, keys, or exploit details.

Do not include any of the following in a public issue:

- spendable Cashu proofs or mint secrets;
- Starknet signer or viewing keys;
- private note plaintext or recipient data;
- prover, RPC, registry, or database credentials;
- an exploit that can duplicate payouts, mint without backing, or strand pending proofs.

Include affected versions, prerequisites, impact, a minimal reproduction, and suggested remediation
when possible. Use synthetic or testnet-only values.

## Priority areas

The highest-impact classes are:

- unbacked issuance or quote theft;
- duplicate or misdirected STRK20 payouts;
- incorrect pending-proof recovery;
- amount, fee, or unit conversion errors;
- reorg/finality mistakes;
- bearer-proof leakage;
- viewing-key or signer compromise;
- false privacy, custody, or solvency claims.

The maintained threat inventory is in `docs/security/threat-model.md`.

## Supported versions

There is no supported production release yet. Security fixes apply to the current development line.
