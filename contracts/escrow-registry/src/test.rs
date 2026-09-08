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

struct TestSetup {
    env: Env,
    contract_id: Address,
    client: EscrowRegistryContractClient<'static>,
    buyer: Address,
    seller: Address,
    attestor1: Address,
    attestor2: Address,
    attestor3: Address,
    attestors: Vec<Address>,
    threshold: u32,
    token: Address,
    token_client: token::Client<'static>,
    amount: i128,
    arbiter: Address,
}

fn setup() -> TestSetup {
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

    let contract_id = env.register(EscrowRegistryContract, ());
    let client = EscrowRegistryContractClient::new(&env, &contract_id);
    let attestors = vec![&env, attestor1.clone(), attestor2.clone(), attestor3.clone()];
    let threshold = 2;

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
        token,
        token_client,
        amount,
        arbiter,
    }
}

#[test]
fn test_registry_full_happy_path_multiple_orders() {
    let s = setup();

    let order_id_1: u64 = 101;
    let order_id_2: u64 = 102;
    let deadline = s.env.ledger().timestamp() + 1000;

    // Create Order 1 (threshold 2-of-3)
    s.client.create_order(
        &order_id_1,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    // Create Order 2 (threshold 2-of-3)
    s.client.create_order(
        &order_id_2,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &(s.amount * 2),
        &deadline,
    );

    assert_eq!(s.token_client.balance(&s.contract_id), s.amount * 3);

    // Verify initial states
    let o1 = s.client.get_order(&order_id_1);
    assert_eq!(o1.status, OrderStatus::Created);
    assert_eq!(o1.amount, s.amount);
    assert_eq!(o1.confirmations.len(), 0);

    let o2 = s.client.get_order(&order_id_2);
    assert_eq!(o2.status, OrderStatus::Created);
    assert_eq!(o2.amount, s.amount * 2);

    // Attest Order 1: 1 of 2 confirmations -> still Created
    s.client.attest(&order_id_1, &s.attestor1);
    assert_eq!(s.client.get_order(&order_id_1).status, OrderStatus::Created);

    // Attest Order 1: 2 of 2 confirmations -> Attested
    s.client.attest(&order_id_1, &s.attestor2);
    assert_eq!(s.client.get_order(&order_id_1).status, OrderStatus::Attested);
    assert_eq!(s.client.get_order(&order_id_2).status, OrderStatus::Created);

    // Claim Order 1
    s.client.claim(&order_id_1);
    assert_eq!(s.client.get_order(&order_id_1).status, OrderStatus::Claimed);
    assert_eq!(s.token_client.balance(&s.seller), s.amount);
    assert_eq!(s.token_client.balance(&s.contract_id), s.amount * 2);

    // Attest & Claim Order 2 (using attestor2 and attestor3)
    s.client.attest(&order_id_2, &s.attestor2);
    s.client.attest(&order_id_2, &s.attestor3);
    assert_eq!(s.client.get_order(&order_id_2).status, OrderStatus::Attested);

    s.client.claim(&order_id_2);
    assert_eq!(s.client.get_order(&order_id_2).status, OrderStatus::Claimed);
    assert_eq!(s.token_client.balance(&s.seller), s.amount * 3);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_registry_reclaim_after_deadline() {
    let s = setup();
    let order_id: u64 = 201;
    let deadline = s.env.ledger().timestamp() + 500;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    // 1 of 2 confirmations provided
    s.client.attest(&order_id, &s.attestor1);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Created);

    s.env.ledger().with_mut(|l| l.timestamp += 1000);

    s.client.reclaim(&order_id);
    let order = s.client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Reclaimed);
    assert_eq!(s.token_client.balance(&s.buyer), s.amount * 10);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_registry_duplicate_order_id_rejected() {
    let s = setup();
    let order_id: u64 = 301;
    let deadline = s.env.ledger().timestamp() + 1000;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    let dup_res = s.client.try_create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );
    assert_eq!(dup_res, Err(Ok(Error::OrderAlreadyExists)));
}

#[test]
fn test_registry_order_not_found() {
    let s = setup();
    let res = s.client.try_get_order(&999);
    assert_eq!(res, Err(Ok(Error::OrderNotFound)));
}

#[test]
fn test_registry_claim_before_attestation_fails() {
    let s = setup();
    let order_id: u64 = 401;
    let deadline = s.env.ledger().timestamp() + 1000;
    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    // 1 of 2 confirmations
    s.client.attest(&order_id, &s.attestor1);

    let res = s.client.try_claim(&order_id);
    assert_eq!(res, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_registry_reclaim_before_deadline_fails() {
    let s = setup();
    let order_id: u64 = 501;
    let deadline = s.env.ledger().timestamp() + 1000;
    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    let res = s.client.try_reclaim(&order_id);
    assert_eq!(res, Err(Ok(Error::DeadlineNotYetPassed)));
}

#[test]
fn test_registry_attest_after_deadline_fails() {
    let s = setup();
    let order_id: u64 = 601;
    let deadline = s.env.ledger().timestamp() + 500;
    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    s.env.ledger().with_mut(|l| l.timestamp += 1000);
    let res = s.client.try_attest(&order_id, &s.attestor1);
    assert_eq!(res, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn test_registry_invalid_parameters() {
    let s = setup();
    let deadline = s.env.ledger().timestamp() + 500;

    // Non positive amount
    let res1 = s.client.try_create_order(
        &701,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &0,
        &deadline,
    );
    assert_eq!(res1, Err(Ok(Error::AmountNotPositive)));

    // Past deadline
    let res2 = s.client.try_create_order(
        &702,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &0,
    );
    assert_eq!(res2, Err(Ok(Error::DeadlineNotInFuture)));

    // Zero threshold
    let res3 = s.client.try_create_order(
        &703,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &0,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );
    assert_eq!(res3, Err(Ok(Error::ThresholdNotPositive)));

    // Threshold exceeding attestors count
    let res4 = s.client.try_create_order(
        &704,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &4,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );
    assert_eq!(res4, Err(Ok(Error::ThresholdExceedsAttestors)));
}

#[test]
fn test_registry_mutual_cancel_success() {
    let s = setup();
    let order_id: u64 = 801;
    let deadline = s.env.ledger().timestamp() + 1000;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    let order = s.client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Created);
    assert_eq!(s.token_client.balance(&s.contract_id), s.amount);

    s.client.cancel(&order_id);
    let order = s.client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Cancelled);
    assert_eq!(s.token_client.balance(&s.buyer), s.amount * 10);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_registry_cancel_after_attestation_fails() {
    let s = setup();
    let order_id: u64 = 802;
    let deadline = s.env.ledger().timestamp() + 1000;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    s.client.attest(&order_id, &s.attestor1);
    s.client.attest(&order_id, &s.attestor2);
    let res = s.client.try_cancel(&order_id);
    assert_eq!(res, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_registry_cancel_requires_both_auths() {
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

    let contract_id = env.register(EscrowRegistryContract, ());
    let client = EscrowRegistryContractClient::new(&env, &contract_id);
    let deadline = env.ledger().timestamp() + 1000;
    let order_id: u64 = 803;
    let attestors = vec![&env, attestor];

    client.create_order(
        &order_id,
        &buyer,
        &seller,
        &attestors,
        &1,
        &arbiter,
        &token,
        &amount,
        &deadline,
    );

    // Mock ONLY buyer authorization
    env.mock_auths(&[MockAuth {
        address: &buyer,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "cancel",
            args: (order_id,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_cancel(&order_id);
    assert!(res.is_err());

    // Mock ONLY seller authorization
    env.mock_auths(&[MockAuth {
        address: &seller,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "cancel",
            args: (order_id,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_cancel(&order_id);
    assert!(res.is_err());

    // Mock BOTH buyer and seller authorization
    env.mock_auths(&[
        MockAuth {
            address: &buyer,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel",
                args: (order_id,).into_val(&env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &seller,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel",
                args: (order_id,).into_val(&env),
                sub_invokes: &[],
            },
        },
    ]);

    let res = client.try_cancel(&order_id);
    assert!(res.is_ok());
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Cancelled);
}

#[test]
fn test_registry_dispute_and_resolve_to_seller() {
    let s = setup();
    let order_id: u64 = 901;
    let deadline = s.env.ledger().timestamp() + 1000;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    // Dispute before attestation fails
    let res = s.client.try_dispute(&order_id);
    assert_eq!(res, Err(Ok(Error::WrongStatus)));

    // Reach threshold attestation
    s.client.attest(&order_id, &s.attestor1);
    s.client.attest(&order_id, &s.attestor2);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Attested);

    // Buyer disputes
    s.client.dispute(&order_id);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Disputed);

    // Seller cannot claim while disputed
    let claim_res = s.client.try_claim(&order_id);
    assert_eq!(claim_res, Err(Ok(Error::WrongStatus)));

    // Arbiter resolves releasing to seller
    s.client.resolve_dispute(&order_id, &true);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Claimed);
    assert_eq!(s.token_client.balance(&s.seller), s.amount);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_registry_dispute_and_resolve_to_buyer() {
    let s = setup();
    let order_id: u64 = 902;
    let deadline = s.env.ledger().timestamp() + 1000;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    // Reach threshold attestation
    s.client.attest(&order_id, &s.attestor1);
    s.client.attest(&order_id, &s.attestor2);

    // Buyer disputes
    s.client.dispute(&order_id);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Disputed);

    // Arbiter resolves releasing to buyer (refund)
    s.client.resolve_dispute(&order_id, &false);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Reclaimed);
    assert_eq!(s.token_client.balance(&s.buyer), s.amount * 10);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_registry_rotate_attestor_success() {
    let s = setup();
    let order_id: u64 = 1001;
    let deadline = s.env.ledger().timestamp() + 1000;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    let new_attestor = Address::generate(&s.env);
    s.client.rotate_attestor(&order_id, &s.attestor3, &new_attestor);

    let order = s.client.get_order(&order_id);
    assert!(!order.attestors.contains(&s.attestor3));
    assert!(order.attestors.contains(&new_attestor));
    assert_eq!(order.attestors.len(), 3);

    // Old attestor can no longer attest
    let res = s.client.try_attest(&order_id, &s.attestor3);
    assert_eq!(res, Err(Ok(Error::AttestorNotAuthorized)));

    // Attestor1 and new_attestor confirm to reach 2-of-3 threshold
    s.client.attest(&order_id, &s.attestor1);
    s.client.attest(&order_id, &new_attestor);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Attested);
}

#[test]
fn test_registry_rotate_attestor_drops_old_confirmation_and_preserves_others() {
    let s = setup();
    let order_id: u64 = 1002;
    let deadline = s.env.ledger().timestamp() + 1000;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &3, // 3-of-3 threshold
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    // Attestor1 and Attestor2 confirm
    s.client.attest(&order_id, &s.attestor1);
    s.client.attest(&order_id, &s.attestor2);
    let order_before = s.client.get_order(&order_id);
    assert_eq!(order_before.confirmations.len(), 2);
    assert_eq!(order_before.status, OrderStatus::Created);

    // Rotate Attestor1 (who confirmed) with new Attestor4
    let new_attestor = Address::generate(&s.env);
    s.client.rotate_attestor(&order_id, &s.attestor1, &new_attestor);

    let order_after = s.client.get_order(&order_id);
    // Attestor1's confirmation was dropped, Attestor2's confirmation survived
    assert_eq!(order_after.confirmations.len(), 1);
    assert_eq!(order_after.confirmations.get(0).unwrap(), s.attestor2);

    // New attestor and Attestor3 confirm to reach 3-of-3 threshold
    s.client.attest(&order_id, &new_attestor);
    s.client.attest(&order_id, &s.attestor3);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Attested);
}

#[test]
fn test_registry_rotate_attestor_rejects_unauthorized_and_invalid_inputs() {
    let s = setup();
    let order_id: u64 = 1003;
    let deadline = s.env.ledger().timestamp() + 1000;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    let new_attestor = Address::generate(&s.env);
    let unknown_attestor = Address::generate(&s.env);

    // Rotating an attestor not in the set fails
    let res = s.client.try_rotate_attestor(&order_id, &unknown_attestor, &new_attestor);
    assert_eq!(res, Err(Ok(Error::AttestorNotFound)));

    // Rotating to an address already in the attestor set fails
    let res = s.client.try_rotate_attestor(&order_id, &s.attestor1, &s.attestor2);
    assert_eq!(res, Err(Ok(Error::AttestorAlreadyExists)));

    // Rotate after status is Attested fails
    s.client.attest(&order_id, &s.attestor1);
    s.client.attest(&order_id, &s.attestor2);
    assert_eq!(s.client.get_order(&order_id).status, OrderStatus::Attested);

    let res = s.client.try_rotate_attestor(&order_id, &s.attestor3, &new_attestor);
    assert_eq!(res, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_registry_rotate_attestor_after_deadline_fails() {
    let s = setup();
    let order_id: u64 = 1004;
    let deadline = s.env.ledger().timestamp() + 100;

    s.client.create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestors,
        &s.threshold,
        &s.arbiter,
        &s.token,
        &s.amount,
        &deadline,
    );

    s.env.ledger().with_mut(|l| l.timestamp += 101);
    let new_attestor = Address::generate(&s.env);
    let res = s.client.try_rotate_attestor(&order_id, &s.attestor1, &new_attestor);
    assert_eq!(res, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn test_registry_rotate_attestor_requires_arbiter_auth() {
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

    let contract_id = env.register(EscrowRegistryContract, ());
    let client = EscrowRegistryContractClient::new(&env, &contract_id);

    let attestors = vec![&env, attestor1.clone(), attestor2.clone(), attestor3.clone()];
    let order_id: u64 = 1005;
    client.create_order(
        &order_id,
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
            args: (order_id, &attestor1, &new_attestor).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_rotate_attestor(&order_id, &attestor1, &new_attestor).is_err());

    // Try rotating with arbiter auth -> succeeds
    env.mock_auths(&[MockAuth {
        address: &arbiter,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "rotate_attestor",
            args: (order_id, &attestor1, &new_attestor).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_rotate_attestor(&order_id, &attestor1, &new_attestor).is_ok());
}

