import { describe, expect, it } from "vitest";

import { canTransitionIncoming, canTransitionOutgoing } from "./states.js";

describe("incoming state transitions", () => {
  it("requires observation before payment", () => {
    expect(canTransitionIncoming("CREATED", "PAID")).toBe(false);
    expect(canTransitionIncoming("CREATED", "OBSERVED")).toBe(true);
    expect(canTransitionIncoming("OBSERVED", "PAID")).toBe(true);
  });

  it("does not automatically issue a late payment", () => {
    expect(canTransitionIncoming("EXPIRED", "PAID")).toBe(false);
    expect(canTransitionIncoming("EXPIRED", "LATE_PAYMENT")).toBe(true);
  });

  it("makes issued quotes terminal", () => {
    expect(canTransitionIncoming("ISSUED", "PAID")).toBe(false);
    expect(canTransitionIncoming("ISSUED", "CREATED")).toBe(false);
  });
});

describe("outgoing state transitions", () => {
  it("records a durable intent before pending settlement", () => {
    expect(canTransitionOutgoing("UNPAID", "PENDING")).toBe(false);
    expect(canTransitionOutgoing("UNPAID", "INTENT_RECORDED")).toBe(true);
  });

  it("keeps ambiguous settlement recoverable", () => {
    expect(canTransitionOutgoing("PENDING", "UNKNOWN")).toBe(true);
    expect(canTransitionOutgoing("UNKNOWN", "PENDING")).toBe(true);
    expect(canTransitionOutgoing("UNKNOWN", "PAID")).toBe(true);
  });

  it("makes paid and failed settlements terminal", () => {
    expect(canTransitionOutgoing("PAID", "PENDING")).toBe(false);
    expect(canTransitionOutgoing("FAILED", "PENDING")).toBe(false);
  });
});
