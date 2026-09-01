# Custody and Privacy Disclosure

This is the minimum disclosure baseline for documentation and future user interfaces. It is not
legal advice.

## Plain-language disclosure

When you convert STRK20 USDC into Cashu, you exchange a private onchain claim for bearer ecash issued
by a mint. The mint holds the backing and can refuse redemption, lose funds, or become unavailable.
Anyone who obtains your Cashu proofs can spend them.

Cashu blind signatures reduce the mint's ability to link issuance to later ecash, but the mint still
sees online interactions and may correlate timing, amount, denomination, network, device, or payout
metadata. STRK20 viewing access covers the Starknet funding and redemption edges; it does not reveal
the Cashu payments made between them.

Receiving Cashu without contacting the mint does not prove that the proofs are unspent. Treat an
offline receipt as provisional until it is checked or redeemed.

## Visibility matrix

| Actor | Funding edge | Cashu circulation | Redemption edge |
|---|---|---|---|
| Starknet public observer | Sees public chain activity under STRK20's privacy design | Sees nothing inherent to Cashu | Sees public chain activity under STRK20's privacy design |
| STRK20 scoped viewer | Sees the edge permitted by the viewing scope | Cannot trace offchain Cashu hops | Sees the edge permitted by the viewing scope |
| Cashu mint | Sees paid quote, amount, and settlement evidence | Sees online swaps/checks plus metadata, but blind issuance breaks the direct cryptographic link | Sees melt proofs, amount, and payout target |
| Network observer | May correlate endpoints and timing | May correlate wallet/mint traffic | May correlate endpoints and timing |
| Merchant | Sees the token or payment request it receives | Sees its own receipt and later spend | Sees a redemption only if it performs one |

## Reserve and liabilities

A public reserve proves, at most, that an address or contract controls assets under stated
assumptions. It does not prove the mint has issued no additional Cashu liabilities. A useful
transparency surface must display reserve evidence and liability evidence separately, including
timestamp, asset, network, signer, method, and known coverage gaps.

Do not use labels such as "fully backed" or "proof of solvency" until a reviewed mechanism supports
that exact claim.

## Operational limits before production

- Testnet only.
- No public deposit endpoint with real USDC.
- No mainnet signer or viewing key.
- No unattended payout process with material value.
- No offline-final language.
- No guarantee that a late payment can be privately refunded.
- No reliance on a single dashboard as solvency evidence.

## Data handling

Collect only data needed for quote settlement, fraud prevention, accounting, and recovery. Define a
retention period before storing IP addresses, device identifiers, payment descriptions, recipient
metadata, or decrypted note information. Viewing-key access must be logged and scoped.

Cashu proofs, private keys, viewing keys, and decrypted notes must never enter analytics systems.

## Incident communication

Pause affected mint and melt methods when backing, signer safety, finality, payout uniqueness, or
state reconciliation cannot be established. State what is known, which assets and time ranges are
affected, what users should avoid, and whether pending proofs or payouts remain ambiguous. Do not
claim funds are safe before evidence supports it.
