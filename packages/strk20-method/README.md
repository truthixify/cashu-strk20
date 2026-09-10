# STRK20 Method Models

Dependency-light TypeScript constants, amount conversion, envelopes, and state vocabulary for the
draft Cashu `strk20` custom method.

The package is private while Draft 0.1 is experimental. It intentionally contains no Starknet SDK,
CDK, network, signer, or persistence dependency.

`PaymentObservation` is the dependency-light evidence vocabulary between the SDK adapter and the
settlement domain. It carries the request attribution identity, opaque evidence and block
references, note and transaction references, verifier version, named finality policy, and an
explicit pending, final, reorged, or provider-conflicted status. It does not carry Cashu quote IDs,
bearer proofs, viewing keys, or decrypted private-note plaintext.
