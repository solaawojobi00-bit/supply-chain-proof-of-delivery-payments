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

#[test]
fn test_rotate_attestor_success() {
    let t = setup(86400);

    let new_attestor = Address::generate(&t.env);
    t.client.rotate_attestor(&t.attestor3, &new_attestor);

    let order = t.client.get_order();
    assert!(!order.attestors.contains(&t.attestor3));
    assert!(order.attestors.contains(&new_attestor));
    assert_eq!(order.attestors.len(), 3);

    // Old attestor can no longer attest
    let res = t.client.try_attest(&t.attestor3);
    assert_eq!(res, Err(Ok(Error::AttestorNotAuthorized)));

    // Attestor1 and new_attestor confirm to reach 2-of-3 threshold
    t.client.attest(&t.attestor1);
    t.client.attest(&new_attestor);
    assert_eq!(t.client.get_order().status, OrderStatus::Attested);
}

#[test]
fn test_rotate_attestor_drops_old_confirmation_and_preserves_others() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor1 = Address::generate(&env);
    let attestor2 = Address::generate(&env);
    let attestor3 = Address::generate(&env);
    let arbiter = Address::generate(&env);

    let (token, asset_client, _) = create_token(&env, &admin);
    let amount: i128 = 1_000_000_000;
    asset_client.mint(&buyer, &(amount * 10));

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let deadline = env.ledger().timestamp() + 86400;
    let attestors = vec![&env, attestor1.clone(), attestor2.clone(), attestor3.clone()];
    // 3-of-3 threshold
    client.create(
        &buyer,
        &seller,
        &attestors,
        &3,
        &arbiter,
        &token,
        &amount,
        &deadline,
    );

    // Attestor1 and Attestor2 confirm
    client.attest(&attestor1);
    client.attest(&attestor2);
    let order_before = client.get_order();
    assert_eq!(order_before.confirmations.len(), 2);
    assert_eq!(order_before.status, OrderStatus::Created);

    // Rotate Attestor1 (who had confirmed) with new Attestor4
    let new_attestor = Address::generate(&env);
    client.rotate_attestor(&attestor1, &new_attestor);

    let order_after = client.get_order();
    // Attestor1's confirmation was dropped, Attestor2's confirmation survived
    assert_eq!(order_after.confirmations.len(), 1);
    assert_eq!(order_after.confirmations.get(0).unwrap(), attestor2);

    // New attestor and Attestor3 confirm to reach 3-of-3 threshold
    client.attest(&new_attestor);
    client.attest(&attestor3);
    assert_eq!(client.get_order().status, OrderStatus::Attested);
}

#[test]
fn test_rotate_attestor_rejects_unauthorized_and_invalid_inputs() {
    let t = setup(86400);

    let new_attestor = Address::generate(&t.env);
    let unknown_attestor = Address::generate(&t.env);

    // Rotating an attestor not in the set fails
    let res = t.client.try_rotate_attestor(&unknown_attestor, &new_attestor);
    assert_eq!(res, Err(Ok(Error::AttestorNotFound)));

    // Rotating to an address already in the attestor set fails
    let res = t.client.try_rotate_attestor(&t.attestor1, &t.attestor2);
    assert_eq!(res, Err(Ok(Error::AttestorAlreadyExists)));

    // Rotate after status is Attested fails
    t.client.attest(&t.attestor1);
    t.client.attest(&t.attestor2);
    assert_eq!(t.client.get_order().status, OrderStatus::Attested);

    let res = t.client.try_rotate_attestor(&t.attestor3, &new_attestor);
    assert_eq!(res, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_rotate_attestor_after_deadline_fails() {
    let t = setup(100);

    t.env.ledger().set_timestamp(t.env.ledger().timestamp() + 101);
    let new_attestor = Address::generate(&t.env);
    let res = t.client.try_rotate_attestor(&t.attestor1, &new_attestor);
    assert_eq!(res, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn test_rotate_attestor_requires_arbiter_auth() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor1 = Address::generate(&env);
    let attestor2 = Address::generate(&env);
    let attestor3 = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let new_attestor = Address::generate(&env);

    let (token, asset_client, _) = create_token(&env, &admin);
    let amount: i128 = 1_000_000_000;
    asset_client.mint(&buyer, &amount);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let attestors = vec![&env, attestor1.clone(), attestor2.clone(), attestor3.clone()];
    client.create(
        &buyer,
        &seller,
        &attestors,
        &2,
        &arbiter,
        &token,
        &amount,
        &(env.ledger().timestamp() + 86400),
    );

    // Try rotating with only buyer auth -> fails
    env.mock_auths(&[MockAuth {
        address: &buyer,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "rotate_attestor",
            args: (&attestor1, &new_attestor).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_rotate_attestor(&attestor1, &new_attestor).is_err());

    // Try rotating with arbiter auth -> succeeds
    env.mock_auths(&[MockAuth {
        address: &arbiter,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "rotate_attestor",
            args: (&attestor1, &new_attestor).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_rotate_attestor(&attestor1, &new_attestor).is_ok());
}

#[test]
fn test_extend_deadline_success() {
    let t = setup(1000);
    let initial_deadline = t.client.get_order().deadline;
    let new_deadline = initial_deadline + 5000;

    t.client.extend_deadline(&new_deadline);
    assert_eq!(t.client.get_order().deadline, new_deadline);
}

#[test]
fn test_extend_deadline_requires_both_buyer_and_seller_auth() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor1 = Address::generate(&env);
    let attestor2 = Address::generate(&env);
    let attestor3 = Address::generate(&env);
    let arbiter = Address::generate(&env);

    let (token, asset_client, _) = create_token(&env, &admin);
    let amount: i128 = 1_000_000_000;
    asset_client.mint(&buyer, &amount);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let initial_deadline = env.ledger().timestamp() + 1000;
    let attestors = vec![&env, attestor1.clone(), attestor2.clone(), attestor3.clone()];
    client.create(
        &buyer,
        &seller,
        &attestors,
        &2,
        &arbiter,
        &token,
        &amount,
        &initial_deadline,
    );

    let new_deadline = initial_deadline + 5000;

    // Buyer auth only -> fails
    env.mock_auths(&[MockAuth {
        address: &buyer,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "extend_deadline",
            args: (new_deadline,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_extend_deadline(&new_deadline).is_err());

    // Seller auth only -> fails
    env.mock_auths(&[MockAuth {
        address: &seller,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "extend_deadline",
            args: (new_deadline,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_extend_deadline(&new_deadline).is_err());

    // Both buyer and seller auth -> succeeds
    env.mock_auths(&[
        MockAuth {
            address: &buyer,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "extend_deadline",
                args: (new_deadline,).into_val(&env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &seller,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "extend_deadline",
                args: (new_deadline,).into_val(&env),
                sub_invokes: &[],
            },
        },
    ]);
    assert!(client.try_extend_deadline(&new_deadline).is_ok());
    assert_eq!(client.get_order().deadline, new_deadline);
}

#[test]
fn test_extend_deadline_rejects_shorter_or_equal_deadline() {
    let t = setup(1000);
    let initial_deadline = t.client.get_order().deadline;

    // Equal deadline -> fails
    let res = t.client.try_extend_deadline(&initial_deadline);
    assert_eq!(res, Err(Ok(Error::DeadlineNotExtended)));

    // Shorter deadline -> fails
    let res = t.client.try_extend_deadline(&(initial_deadline - 100));
    assert_eq!(res, Err(Ok(Error::DeadlineNotExtended)));
}

#[test]
fn test_extend_deadline_rejects_terminal_status() {
    let t = setup(1000);
    t.client.attest(&t.attestor1);
    t.client.attest(&t.attestor2);
    t.client.claim();
    assert_eq!(t.client.get_order().status, OrderStatus::Claimed);

    let res = t.client.try_extend_deadline(&(t.client.get_order().deadline + 5000));
    assert_eq!(res, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_extend_deadline_allows_attestation_in_extended_window() {
    let t = setup(1000);
    let initial_deadline = t.client.get_order().deadline;
    let new_deadline = initial_deadline + 5000;

    t.client.extend_deadline(&new_deadline);

    // Advance past initial deadline but before new deadline
    t.env.ledger().set_timestamp(initial_deadline + 500);

    // Attestation succeeds
    t.client.attest(&t.attestor1);
    t.client.attest(&t.attestor2);
    assert_eq!(t.client.get_order().status, OrderStatus::Attested);
}



