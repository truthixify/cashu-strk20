/// Internal state for an incoming STRK20 funding request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IncomingState {
    /// Funding instructions exist without matching payment evidence.
    Created,
    /// Matching evidence exists but is not final.
    Observed,
    /// Matching evidence is canonical and may authorize Cashu issuance.
    Paid,
    /// CDK completed issuance for the quote.
    Issued,
    /// The request expired without accepted payment.
    Expired,
    /// Value arrived outside the accepted expiry policy.
    LatePayment,
    /// Candidate evidence was invalid or reorged before payment.
    Rejected,
    /// Automation cannot establish a safe next state.
    OperatorRequired,
}

impl IncomingState {
    /// Returns whether the requested transition is permitted by the draft state machine.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Created,
                Self::Observed | Self::Expired | Self::Rejected | Self::OperatorRequired
            ) | (
                Self::Observed,
                Self::Created | Self::Paid | Self::Rejected | Self::OperatorRequired
            ) | (Self::Paid, Self::Issued | Self::OperatorRequired)
                | (Self::Expired, Self::LatePayment | Self::OperatorRequired)
                | (Self::LatePayment | Self::Rejected, Self::OperatorRequired)
                | (Self::Rejected, Self::Created)
        )
    }
}

/// Internal state for an outgoing STRK20 payout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OutgoingState {
    /// Melt quote exists without a payout intent.
    Unpaid,
    /// A durable unique intent exists before external submission.
    IntentRecorded,
    /// Submission or finality is in progress.
    Pending,
    /// Execution cannot currently be established.
    Unknown,
    /// Exactly one payout is canonical and final.
    Paid,
    /// Non-execution is proven and Cashu recovery is safe.
    Failed,
    /// Automation cannot establish a safe next state.
    OperatorRequired,
}

impl OutgoingState {
    /// Returns whether the requested transition is permitted by the draft state machine.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Unpaid, Self::IntentRecorded | Self::OperatorRequired)
                | (
                    Self::IntentRecorded,
                    Self::Pending | Self::Unknown | Self::Failed | Self::OperatorRequired
                )
                | (
                    Self::Pending,
                    Self::Unknown | Self::Paid | Self::Failed | Self::OperatorRequired
                )
                | (
                    Self::Unknown,
                    Self::Pending | Self::Paid | Self::Failed | Self::OperatorRequired
                )
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incoming_payment_requires_observation() {
        assert!(!IncomingState::Created.can_transition_to(IncomingState::Paid));
        assert!(IncomingState::Created.can_transition_to(IncomingState::Observed));
        assert!(IncomingState::Observed.can_transition_to(IncomingState::Paid));
    }

    #[test]
    fn issued_quotes_are_terminal() {
        assert!(!IncomingState::Issued.can_transition_to(IncomingState::Paid));
        assert!(!IncomingState::Issued.can_transition_to(IncomingState::Created));
    }

    #[test]
    fn outgoing_payment_requires_a_durable_intent() {
        assert!(!OutgoingState::Unpaid.can_transition_to(OutgoingState::Pending));
        assert!(OutgoingState::Unpaid.can_transition_to(OutgoingState::IntentRecorded));
    }

    #[test]
    fn ambiguous_payment_can_be_reconciled() {
        assert!(OutgoingState::Pending.can_transition_to(OutgoingState::Unknown));
        assert!(OutgoingState::Unknown.can_transition_to(OutgoingState::Pending));
        assert!(OutgoingState::Unknown.can_transition_to(OutgoingState::Paid));
    }

    #[test]
    fn final_outgoing_states_are_terminal() {
        assert!(!OutgoingState::Paid.can_transition_to(OutgoingState::Pending));
        assert!(!OutgoingState::Failed.can_transition_to(OutgoingState::Pending));
    }
}
