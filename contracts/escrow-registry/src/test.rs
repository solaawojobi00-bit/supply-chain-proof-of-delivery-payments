#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Env;

fn create_token(
    env: &Env,
    admin: &Address,
) -> (Address, token::StellarAssetClient<'static>, token::Client<'static>) {
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
    attestor: Address,
    token: Address,
    token_client: token::Client<'static>,
    amount: i128,
}

fn setup() -> TestSetup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor = Address::generate(&env);

    let (token, asset_client, token_client) = create_token(&env, &admin);
    let amount: i128 = 1_000_000_000; // 100 XLM in stroops
    asset_client.mint(&buyer, &(amount * 10));

    let contract_id = env.register(EscrowRegistryContract, ());
    let client = EscrowRegistryContractClient::new(&env, &contract_id);

    TestSetup {
        env,
        contract_id,
        client,
        buyer,
        seller,
        attestor,
        token,
        token_client,
        amount,
    }
}

#[test]
fn test_registry_full_happy_path_multiple_orders() {
    let s = setup();

    let order_id_1: u64 = 101;
    let order_id_2: u64 = 102;
    let deadline = s.env.ledger().timestamp() + 1000;

    // Create Order 1
    s.client.create_order(
        &order_id_1,
        &s.buyer,
        &s.seller,
        &s.attestor,
        &s.token,
        &s.amount,
        &deadline,
    );

    // Create Order 2
    s.client.create_order(
        &order_id_2,
        &s.buyer,
        &s.seller,
        &s.attestor,
        &s.token,
        &(s.amount * 2),
        &deadline,
    );

    assert_eq!(s.token_client.balance(&s.contract_id), s.amount * 3);

    // Verify initial states
    let o1 = s.client.get_order(&order_id_1);
    assert_eq!(o1.status, OrderStatus::Created);
    assert_eq!(o1.amount, s.amount);

    let o2 = s.client.get_order(&order_id_2);
    assert_eq!(o2.status, OrderStatus::Created);
    assert_eq!(o2.amount, s.amount * 2);

    // Attest Order 1
    s.client.attest(&order_id_1);
    assert_eq!(s.client.get_order(&order_id_1).status, OrderStatus::Attested);
    assert_eq!(s.client.get_order(&order_id_2).status, OrderStatus::Created);

    // Claim Order 1
    s.client.claim(&order_id_1);
    assert_eq!(s.client.get_order(&order_id_1).status, OrderStatus::Claimed);
    assert_eq!(s.token_client.balance(&s.seller), s.amount);
    assert_eq!(s.token_client.balance(&s.contract_id), s.amount * 2);

    // Attest & Claim Order 2
    s.client.attest(&order_id_2);
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
        &s.attestor,
        &s.token,
        &s.amount,
        &deadline,
    );

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
        &s.attestor,
        &s.token,
        &s.amount,
        &deadline,
    );

    let dup_res = s.client.try_create_order(
        &order_id,
        &s.buyer,
        &s.seller,
        &s.attestor,
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
        &s.attestor,
        &s.token,
        &s.amount,
        &deadline,
    );

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
        &s.attestor,
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
        &s.attestor,
        &s.token,
        &s.amount,
        &deadline,
    );

    s.env.ledger().with_mut(|l| l.timestamp += 1000);
    let res = s.client.try_attest(&order_id);
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
        &s.attestor,
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
        &s.attestor,
        &s.token,
        &s.amount,
        &0,
    );
    assert_eq!(res2, Err(Ok(Error::DeadlineNotInFuture)));
}
