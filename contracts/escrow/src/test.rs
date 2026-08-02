#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Env;

fn create_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'static>, token::Client<'static>) {
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
    attestor: Address,
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
    let attestor = Address::generate(&env);

    let (token, asset_client, token_client) = create_token(&env, &admin);
    let amount: i128 = 1_000_000_000; // 100 XLM in stroops
    asset_client.mint(&buyer, &(amount * 10));

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let deadline = env.ledger().timestamp() + deadline_offset_secs;
    client.create(&buyer, &seller, &attestor, &token, &amount, &deadline);

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
fn test_full_happy_path_attest_then_claim() {
    let s = setup(1000);

    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Created);
    assert_eq!(s.token_client.balance(&s.contract_id), s.amount);

    s.client.attest();
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Attested);

    s.client.claim();
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Claimed);
    assert_eq!(s.token_client.balance(&s.seller), s.amount);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_reclaim_after_deadline_with_no_attestation() {
    let s = setup(1000);

    s.env.ledger().with_mut(|l| l.timestamp += 2000);

    s.client.reclaim();
    let order = s.client.get_order();
    assert_eq!(order.status, OrderStatus::Reclaimed);
    assert_eq!(s.token_client.balance(&s.buyer), s.amount * 10);
    assert_eq!(s.token_client.balance(&s.contract_id), 0);
}

#[test]
fn test_claim_before_attestation_fails() {
    let s = setup(1000);
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
    let result = s.client.try_attest();
    assert_eq!(result, Err(Ok(Error::DeadlinePassed)));
}

#[test]
fn test_double_attest_fails() {
    let s = setup(1000);
    s.client.attest();
    let result = s.client.try_attest();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_reclaim_after_claim_fails() {
    let s = setup(1000);
    s.client.attest();
    s.client.claim();
    s.env.ledger().with_mut(|l| l.timestamp += 2000);
    let result = s.client.try_reclaim();
    assert_eq!(result, Err(Ok(Error::WrongStatus)));
}

#[test]
fn test_create_rejects_non_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let attestor = Address::generate(&env);
    let (token, _asset_client, _token_client) = create_token(&env, &admin);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let deadline = env.ledger().timestamp() + 1000;

    let result = client.try_create(&buyer, &seller, &attestor, &token, &0, &deadline);
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
    let (token, _asset_client, _token_client) = create_token(&env, &admin);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create(&buyer, &seller, &attestor, &token, &100, &0);
    assert_eq!(result, Err(Ok(Error::DeadlineNotInFuture)));
}
