use std::str::FromStr;

use cdk_common::mint::{MeltPaymentRequest, MeltQuote};
use cdk_common::nuts::{
    MeltQuoteCustomRequest, MeltQuoteCustomResponse, MintQuoteCustomRequest,
    MintQuoteCustomResponse,
};
use cdk_common::payment::{
    CustomIncomingPaymentOptions, IncomingPaymentOptions, MakePaymentResponse,
    OutgoingPaymentOptions, PaymentIdentifier,
};
use cdk_common::{Amount, CurrencyUnit, MeltQuoteState, PaymentMethod, QuoteId};
use cdk_starknet::{CURRENCY_UNIT, PAYMENT_METHOD};
use serde_json::{Value, json};

const VECTOR: &str = include_str!("../../../docs/specs/vectors/cdk-0.17.6-strk20.json");

#[test]
fn custom_quote_wire_shapes_match_the_published_vector() {
    let vector: Value = serde_json::from_str(VECTOR).expect("valid compatibility vector");
    assert_eq!(vector["name"], "cashu-strk20-cdk-custom-wire");
    assert_eq!(vector["version"], 1);
    assert_eq!(vector["status"], "candidate");
    assert_eq!(
        vector["cdk"],
        json!({
            "crate": "cdk-common",
            "version": "0.17.6",
            "crateChecksum": "b67475b79db0e001bfe0843697f177e44be8cd589f48c3f993e76a5317b6fac1",
            "sourceCommit": "43129596752412ed4b30f8fb8f49ec63650a5f6e",
            "paymentProcessorProtocol": "3.0.0",
            "customRequestExtraLimitBytes": 1024,
            "scope": "outer-cdk-wire-only"
        })
    );
    let unit = CurrencyUnit::from_str(CURRENCY_UNIT).expect("custom unit");
    let mint_request = MintQuoteCustomRequest {
        amount: Amount::from(2_000_u64),
        unit: unit.clone(),
        description: Some("private USDC funding".to_string()),
        pubkey: None,
        extra: json!({
            "network": "SN_SEPOLIA",
            "attribution": { "profile": "signed_payer" }
        }),
    };
    let mint_response = MintQuoteCustomResponse {
        quote: "fixture-mint-quote-id".to_string(),
        request: vector["nut04"]["response"]["request"]
            .as_str()
            .expect("mint payment request")
            .to_string(),
        amount: Some(Amount::from(2_000_u64)),
        amount_paid: Amount::ZERO,
        amount_issued: Amount::ZERO,
        unit: Some(unit.clone()),
        expiry: Some(2_000_000_300),
        pubkey: None,
        extra: json!({
            "network": "SN_SEPOLIA",
            "token_contract": "0x456",
            "amount_base_units": "20000000",
            "payment_request_id": "payment_request_fixture_0001",
            "attribution_profile": "signed_payer"
        }),
    };
    let melt_request = MeltQuoteCustomRequest {
        method: PAYMENT_METHOD.to_string(),
        request: vector["nut05"]["request"]["request"]
            .as_str()
            .expect("melt payment request")
            .to_string(),
        unit: unit.clone(),
        extra: json!({ "network": "SN_SEPOLIA" }),
    };
    let melt_response = MeltQuoteCustomResponse {
        quote: "fixture-melt-quote-id".to_string(),
        amount: Amount::from(2_000_u64),
        fee_reserve: Some(Amount::from(3_u64)),
        state: MeltQuoteState::Unpaid,
        expiry: 2_000_000_300,
        payment_preimage: None,
        change: None,
        request: Some(melt_request.request.clone()),
        unit: Some(unit),
        extra: json!({
            "network": "SN_SEPOLIA",
            "token_contract": "0x456",
            "amount_base_units": "20000000"
        }),
    };

    assert_eq!(
        serde_json::to_value(mint_request).unwrap(),
        vector["nut04"]["request"]
    );
    assert_eq!(
        serde_json::to_value(mint_response).unwrap(),
        vector["nut04"]["response"]
    );
    assert_eq!(
        serde_json::to_value(melt_request).unwrap(),
        vector["nut05"]["request"]
    );
    assert_eq!(
        serde_json::to_value(melt_response).unwrap(),
        vector["nut05"]["response"]
    );
}

#[test]
fn stored_custom_melt_restores_the_quote_id_and_response_metadata() {
    let vector: Value = serde_json::from_str(VECTOR).expect("valid compatibility vector");
    let unit = CurrencyUnit::from_str(CURRENCY_UNIT).expect("custom unit");
    let quote_id = QuoteId::new();
    let request = vector["nut05"]["request"]["request"]
        .as_str()
        .expect("melt payment request")
        .to_string();
    let response_metadata = json!({
        "network": "SN_SEPOLIA",
        "token_contract": "0x456",
        "amount_base_units": "20000000"
    });
    let quote = MeltQuote::new(
        Some(quote_id.clone()),
        MeltPaymentRequest::Custom {
            method: PAYMENT_METHOD.to_string(),
            request: request.clone(),
        },
        unit.clone(),
        Amount::new(2_000, unit.clone()),
        Amount::new(3, unit.clone()),
        2_000_000_300,
        Some(PaymentIdentifier::CustomId("fixture-lookup-id".to_string())),
        None,
        PaymentMethod::Custom(PAYMENT_METHOD.to_string()),
        Some(response_metadata.clone()),
        None,
    );

    let options =
        OutgoingPaymentOptions::from_melt_quote_with_fee(quote).expect("custom outgoing options");
    let OutgoingPaymentOptions::Custom(options) = options else {
        panic!("expected custom outgoing options");
    };

    assert_eq!(options.method, PAYMENT_METHOD);
    assert_eq!(options.request, request);
    assert_eq!(options.quote_id, quote_id);
    assert_eq!(options.max_fee_amount, Some(Amount::new(3, unit)));
    assert_eq!(options.extra_json, Some(response_metadata.to_string()));
}

#[test]
fn custom_boundary_exposes_the_required_unit_and_async_states() {
    let unit = CurrencyUnit::from_str(CURRENCY_UNIT).expect("custom unit");
    assert_eq!(unit.to_string(), CURRENCY_UNIT);

    let incoming = IncomingPaymentOptions::Custom(Box::new(CustomIncomingPaymentOptions {
        method: PAYMENT_METHOD.to_string(),
        description: None,
        amount: Amount::new(2_000, unit.clone()),
        unix_expiry: Some(2_000_000_300),
        extra_json: Some("{\"network\":\"SN_SEPOLIA\"}".to_string()),
    }));
    let IncomingPaymentOptions::Custom(incoming) = incoming else {
        panic!("expected custom incoming options");
    };
    assert_eq!(incoming.method, PAYMENT_METHOD);
    assert_eq!(incoming.amount.unit(), &unit);

    for (state, wire_value) in [
        (MeltQuoteState::Unpaid, "UNPAID"),
        (MeltQuoteState::Pending, "PENDING"),
        (MeltQuoteState::Unknown, "UNKNOWN"),
        (MeltQuoteState::Paid, "PAID"),
        (MeltQuoteState::Failed, "FAILED"),
    ] {
        assert_eq!(state.to_string(), wire_value);
    }

    let pending = MakePaymentResponse {
        payment_lookup_id: PaymentIdentifier::CustomId("fixture-lookup-id".to_string()),
        payment_proof: None,
        status: MeltQuoteState::Pending,
        total_spent: Amount::new(0, unit),
    };
    assert_eq!(pending.status, MeltQuoteState::Pending);
    assert_eq!(pending.total_spent.value(), 0);
}
