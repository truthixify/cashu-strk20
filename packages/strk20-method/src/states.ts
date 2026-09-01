export const INCOMING_STATES = [
  "CREATED",
  "OBSERVED",
  "PAID",
  "ISSUED",
  "EXPIRED",
  "LATE_PAYMENT",
  "REJECTED",
  "OPERATOR_REQUIRED",
] as const;

export type IncomingState = (typeof INCOMING_STATES)[number];

export const OUTGOING_STATES = [
  "UNPAID",
  "INTENT_RECORDED",
  "PENDING",
  "UNKNOWN",
  "PAID",
  "FAILED",
  "OPERATOR_REQUIRED",
] as const;

export type OutgoingState = (typeof OUTGOING_STATES)[number];

const incomingTransitions: Readonly<Record<IncomingState, readonly IncomingState[]>> = {
  CREATED: ["OBSERVED", "EXPIRED", "REJECTED", "OPERATOR_REQUIRED"],
  OBSERVED: ["CREATED", "PAID", "REJECTED", "OPERATOR_REQUIRED"],
  PAID: ["ISSUED", "OPERATOR_REQUIRED"],
  ISSUED: [],
  EXPIRED: ["LATE_PAYMENT", "OPERATOR_REQUIRED"],
  LATE_PAYMENT: ["OPERATOR_REQUIRED"],
  REJECTED: ["CREATED", "OPERATOR_REQUIRED"],
  OPERATOR_REQUIRED: [],
};

const outgoingTransitions: Readonly<Record<OutgoingState, readonly OutgoingState[]>> = {
  UNPAID: ["INTENT_RECORDED", "OPERATOR_REQUIRED"],
  INTENT_RECORDED: ["PENDING", "UNKNOWN", "FAILED", "OPERATOR_REQUIRED"],
  PENDING: ["UNKNOWN", "PAID", "FAILED", "OPERATOR_REQUIRED"],
  UNKNOWN: ["PENDING", "PAID", "FAILED", "OPERATOR_REQUIRED"],
  PAID: [],
  FAILED: [],
  OPERATOR_REQUIRED: [],
};

export function canTransitionIncoming(from: IncomingState, to: IncomingState): boolean {
  return incomingTransitions[from].includes(to);
}

export function canTransitionOutgoing(from: OutgoingState, to: OutgoingState): boolean {
  return outgoingTransitions[from].includes(to);
}
