#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{vec, Env, Vec};

fn create_token(
    env: &Env,
    admin: &Address,
) -> (
    Address,
    token::StellarAssetClient<'static>,
    token::Client<'static>,
) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset_client = token::StellarAssetClient::new(env, &sac.address());
    let token_client = token::Client::new(env, &sac.address());
    (sac.address(), asset_client, token_client)
}

#[allow(dead_code)]
struct TestSetup {
    env: Env,
    contract_id: Address,
    client: EscrowContractClient<'static>,
    buyer: Address,
    seller: Address,
    attestor1: Address,
    attestor2: Address,
    attestor3: Address,
    attestors: Vec<Address>,
    threshold: u32,
    arbiter: Address,
    token: Address,
    token_client: token::Client<'static>,
    amount: i128,
}

fn setup(deadline_offset_secs: u64) -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor1 = Address::generate(&env);
    let attestor2 = Address::generate(&env);
    let attestor3 = Address::generate(&env);
    let arbiter = Address::generate(&env);

    let (token, asset_client, token_client) = create_token(&env, &admin);
    let amount: i128 = 1_000_000_000; // 100 XLM in stroops
    asset_client.mint(&buyer, &(amount * 10));

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let deadline = env.ledger().timestamp() + deadline_offset_secs;
    let attestors = vec![&env, attestor1.clone(), attestor2.clone(), attestor3.clone()];
    let threshold = 2; // 2-of-3 threshold
    client.create(
        &buyer,
        &seller,
        &attestors,
        &threshold,
        &arbiter,
        &token,
        &amount,
        &deadline,
    );

    TestSetup {
        env,
        contract_id,
        client,
        buyer,
        seller,
        attestor1,
        attestor2,
        attestor3,
        attestors,
        threshold,
        arbiter,
        token,
        token_client,
        amount,
    }
}

#[test]
fn test_full_happy_path_2_of_3_attest_then_claim() {
    let s = setup(1000);

    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Created);
    assert_eq!(s.token_client.balance(&s.contract_id), s.amount);
    assert_eq!(order.confirmations.len(), 0);

    // First attestation: still Created (1 of 2 threshold)
    s.client.attest(&s.attestor1);
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Created);
    assert_eq!(order.confirmations.len(), 1);

    // Second attestation: transitions to Attested (2 of 2 threshold)
    s.client.attest(&s.attestor3);
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Attested);
    assert_eq!(order.confirmations.len(), 2);

    s.client.claim();
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Claimed);
    assert_eq!(s.token_client.balance(&s.seller), s.amount);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_single_attestor_confirming_twice_fails() {
    let s = setup(1000);

    s.client.attest(&s.attestor1);
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Created);
    assert_eq!(order.confirmations.len(), 1);

    // Duplicate attestation by same attestor
    let result = s.client.try_attest(&s.attestor1);
    assert_eq!(result, Err(Ok(Error::AlreadyConfirmed)));

    // Order status remains Created and confirmations count is still 1
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Created);
    assert_eq!(order.confirmations.len(), 1);
}

#[test]
fn test_unauthorized_attestor_rejected() {
    let s = setup(1000);
    let outsider = Address::generate(&s.env);

    let result = s.client.try_attest(&outsider);
    assert_eq!(result, Err(Ok(Error::AttestorNotAuthorized)));
}

#[test]
fn test_reclaim_after_deadline_with_partial_attestation() {
    let s = setup(1000);

    // 1 of 2 attestations provided
    s.client.attest(&s.attestor2);
    assert_eq!(s.client.get_order().status, OrderStatus::Created);

    // Advance ledger past deadline
    s.env.ledger().with_mut(|l| l.timestamp += 2000);

    // Buyer reclaims
    s.client.reclaim();
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Reclaimed);
    assert_eq!(s.token_client.balance(&s.buyer), s.amount * 10);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_claim_before_threshold_attestation_fails() {
    let s = setup(1000);
    // 1 of 2 confirmations
    s.client.attest(&s.attestor1);

    let result = s.client.try_claim();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_reclaim_before_deadline_fails() {
    let s = setup(1000);
    let result = s.client.try_reclaim();
    assert_eq!(result, Err(Ok(Error::DeadlineNotYetPassed)));
}

#[test]
fn test_attest_after_deadline_fails() {
    let s = setup(1000);
    s.env.ledger().with_mut(|l| l.timestamp += 2000);
    let result = s.client.try_attest(&s.attestor1);
    assert_eq!(result, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn test_attest_after_threshold_already_reached_fails() {
    let s = setup(1000);
    s.client.attest(&s.attestor1);
    s.client.attest(&s.attestor2);
    assert_eq!(s.client.get_order().status, OrderStatus::Attested);

    // Order is now Attested; subsequent attestation by 3rd attestor rejected
    let result = s.client.try_attest(&s.attestor3);
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_reclaim_after_claim_fails() {
    let s = setup(1000);
    s.client.attest(&s.attestor1);
    s.client.attest(&s.attestor2);
    s.client.claim();
    s.env.ledger().with_mut(|l| l.timestamp += 2000);
    let result = s.client.try_reclaim();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_create_rejects_zero_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let (token, _asset_client, _token_client) = create_token(&env, &admin);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let deadline = env.ledger().timestamp() + 1000;
    let attestors = vec![&env, attestor];

    let result =
        client.try_create(&buyer, &seller, &attestors, &0, &arbiter, &token, &100, &deadline);
    assert_eq!(result, Err(Ok(Error::ThresholdNotPositive)));
}

#[test]
fn test_create_rejects_threshold_greater_than_attestors() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let (token, _asset_client, _token_client) = create_token(&env, &admin);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let deadline = env.ledger().timestamp() + 1000;
    let attestors = vec![&env, attestor];

    let result =
        client.try_create(&buyer, &seller, &attestors, &2, &arbiter, &token, &100, &deadline);
    assert_eq!(result, Err(Ok(Error::ThresholdExceedsAttestors)));
}

#[test]
fn test_create_rejects_non_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let (token, _asset_client, _token_client) = create_token(&env, &admin);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let deadline = env.ledger().timestamp() + 1000;
    let attestors = vec![&env, attestor];

    let result =
        client.try_create(&buyer, &seller, &attestors, &1, &arbiter, &token, &0, &deadline);
    assert_eq!(result, Err(Ok(Error::AmountNotPositive)));
}

#[test]
fn test_create_rejects_deadline_in_the_past() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let (token, _asset_client, _token_client) = create_token(&env, &admin);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let attestors = vec![&env, attestor];

    let result =
        client.try_create(&buyer, &seller, &attestors, &1, &arbiter, &token, &100, &0);
    assert_eq!(result, Err(Ok(Error::DeadlineNotInFuture)));
}

#[test]
fn test_mutual_cancel_success() {
    let s = setup(1000);

    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Created);
    assert_eq!(s.token_client.balance(&s.contract_id), s.amount);

    s.client.cancel();
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Cancelled);
    assert_eq!(s.token_client.balance(&s.buyer), s.amount * 10);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_cancel_after_attestation_fails() {
    let s = setup(1000);
    s.client.attest(&s.attestor1);
    s.client.attest(&s.attestor2);
    let result = s.client.try_cancel();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_cancel_after_claim_fails() {
    let s = setup(1000);
    s.client.attest(&s.attestor1);
    s.client.attest(&s.attestor2);
    s.client.claim();
    let result = s.client.try_cancel();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_cancel_after_reclaim_fails() {
    let s = setup(1000);
    s.env.ledger().with_mut(|l| l.timestamp += 2000);
    s.client.reclaim();
    let result = s.client.try_cancel();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_dispute_before_attestation_fails() {
    let s = setup(1000);
    let result = s.client.try_dispute();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_dispute_after_claim_fails() {
    let s = setup(1000);
    s.client.attest(&s.attestor1);
    s.client.attest(&s.attestor2);
    s.client.claim();
    let result = s.client.try_dispute();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_dispute_blocks_seller_claim() {
    let s = setup(1000);
    s.client.attest(&s.attestor1);
    s.client.attest(&s.attestor2);
    assert_eq!(s.client.get_order().status, OrderStatus::Attested);

    // Buyer raises dispute
    s.client.dispute();
    assert_eq!(s.client.get_order().status, OrderStatus::Disputed);

    // Seller claim is blocked
    let claim_res = s.client.try_claim();
    assert_eq!(claim_res, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_resolve_dispute_release_to_seller() {
    let s = setup(1000);
    s.client.attest(&s.attestor1);
    s.client.attest(&s.attestor2);
    s.client.dispute();
    assert_eq!(s.client.get_order().status, OrderStatus::Disputed);

    // Arbiter resolves in favor of seller
    s.client.resolve_dispute(&true);
    assert_eq!(s.client.get_order().status, OrderStatus::Claimed);
    assert_eq!(s.token_client.balance(&s.seller), s.amount);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_resolve_dispute_release_to_buyer() {
    let s = setup(1000);
    s.client.attest(&s.attestor1);
    s.client.attest(&s.attestor2);
    s.client.dispute();
    assert_eq!(s.client.get_order().status, OrderStatus::Disputed);

    // Arbiter resolves in favor of buyer (refund)
    s.client.resolve_dispute(&false);
    assert_eq!(s.client.get_order().status, OrderStatus::Reclaimed);
    assert_eq!(s.token_client.balance(&s.buyer), s.amount * 10);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_cancel_requires_both_auths() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    let env = Env::default();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor = Address::generate(&env);
    let arbiter = Address::generate(&env);

    let (token, asset_client, _token_client) = create_token(&env, &admin);
    let amount: i128 = 1_000_000_000;

    env.mock_all_auths();
    asset_client.mint(&buyer, &(amount * 10));

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let deadline = env.ledger().timestamp() + 1000;
    let attestors = vec![&env, attestor];

    client.create(
        &buyer, &seller, &attestors, &1, &arbiter, &token, &amount, &deadline,
    );

    // Mock ONLY buyer authorization
    env.mock_auths(&[MockAuth {
        address: &buyer,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "cancel",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);

    // Should fail because seller did not authorize
    let result = client.try_cancel();
    assert!(result.is_err());

    // Mock ONLY seller authorization
    env.mock_auths(&[MockAuth {
        address: &seller,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "cancel",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);

    // Should fail because buyer did not authorize
    let result = client.try_cancel();
    assert!(result.is_err());

    // Mock BOTH buyer and seller authorization
    env.mock_auths(&[
        MockAuth {
            address: &buyer,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &seller,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        },
    ]);

    // Should succeed
    let result = client.try_cancel();
    assert!(result.is_ok());
    assert_eq!(client.get_order().status, OrderStatus::Cancelled);
}
