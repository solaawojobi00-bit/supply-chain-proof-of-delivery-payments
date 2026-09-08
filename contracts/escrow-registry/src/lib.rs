#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Vec,
};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RotateAttestorEvent {
    pub order_id: u64,
    pub old_attestor: Address,
    pub new_attestor: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtendDeadlineEvent {
    pub order_id: u64,
    pub old_deadline: u64,
    pub new_deadline: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeEvent {
    pub order_id: u64,
    pub evidence_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Created,
    Attested,
    Disputed,
    Claimed,
    Reclaimed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub order_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub attestors: Vec<Address>,
    pub threshold: u32,
    pub confirmations: Vec<Address>,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub deadline: u64,
    pub status: OrderStatus,
    pub evidence_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Order(u64),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    OrderAlreadyExists = 1,
    OrderNotFound = 2,
    AmountNotPositive = 3,
    DeadlineNotInFuture = 4,
    WrongStatus = 5,
    DeadlineNotYetPassed = 6,
    DeadlinePassed = 7,
    ThresholdNotPositive = 8,
    ThresholdExceedsAttestors = 9,
    AttestorNotAuthorized = 10,
    AlreadyConfirmed = 11,
    AttestorNotFound = 12,
    AttestorAlreadyExists = 13,
    DeadlineNotExtended = 14,
}

const LEDGERS_PER_DAY: u32 = 17280; // ~5s ledger close time
const STORAGE_TTL_DAYS: u32 = 30;
const STORAGE_TTL_LEDGERS: u32 = LEDGERS_PER_DAY * STORAGE_TTL_DAYS;
const STORAGE_TTL_THRESHOLD: u32 = STORAGE_TTL_LEDGERS - LEDGERS_PER_DAY;

#[contract]
pub struct EscrowRegistryContract;

#[contractimpl]
impl EscrowRegistryContract {
    /// Creates and funds a new order within the shared escrow registry.
    /// Pulls `amount` of `token` from `buyer` into the registry contract.
    pub fn create_order(
        env: Env,
        order_id: u64,
        buyer: Address,
        seller: Address,
        attestors: Vec<Address>,
        threshold: u32,
        arbiter: Address,
        token: Address,
        amount: i128,
        deadline: u64,
    ) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::OrderAlreadyExists);
        }
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::DeadlineNotInFuture);
        }
        if threshold == 0 {
            return Err(Error::ThresholdNotPositive);
        }
        if threshold > attestors.len() {
            return Err(Error::ThresholdExceedsAttestors);
        }

        buyer.require_auth();

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        let order = Order {
            order_id,
            buyer,
            seller,
            attestors,
            threshold,
            confirmations: Vec::new(&env),
            arbiter,
            token,
            amount,
            deadline,
            status: OrderStatus::Created,
            evidence_hash: None,
        };

        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// An authorized attestor confirms delivery for a given `order_id`. Must be signed before the deadline.
    /// Transitions status to `Attested` once `threshold` distinct confirmations are reached.
    pub fn attest(env: Env, order_id: u64, attestor: Address) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status != OrderStatus::Created {
            return Err(Error::WrongStatus);
        }
        if env.ledger().timestamp() >= order.deadline {
            return Err(Error::DeadlinePassed);
        }
        if !order.attestors.contains(&attestor) {
            return Err(Error::AttestorNotAuthorized);
        }
        if order.confirmations.contains(&attestor) {
            return Err(Error::AlreadyConfirmed);
        }

        attestor.require_auth();

        order.confirmations.push_back(attestor);

        if order.confirmations.len() >= order.threshold {
            order.status = OrderStatus::Attested;
        }

        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// Rotates an attestor's key for a given `order_id` before the order is attested/settled.
    /// Callable by the arbiter only.
    /// Replaces `old_attestor` in `order.attestors` with `new_attestor`.
    /// If `old_attestor` had previously confirmed, its confirmation is dropped so
    /// the new key must independently confirm; confirmations from other attestors are preserved.
    pub fn rotate_attestor(
        env: Env,
        order_id: u64,
        old_attestor: Address,
        new_attestor: Address,
    ) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status != OrderStatus::Created {
            return Err(Error::WrongStatus);
        }
        if env.ledger().timestamp() >= order.deadline {
            return Err(Error::DeadlinePassed);
        }

        order.arbiter.require_auth();

        if order.attestors.contains(&new_attestor) {
            return Err(Error::AttestorAlreadyExists);
        }

        let mut old_idx_opt = None;
        for i in 0..order.attestors.len() {
            if order.attestors.get(i).unwrap() == old_attestor {
                old_idx_opt = Some(i);
                break;
            }
        }

        let old_idx = match old_idx_opt {
            Some(idx) => idx,
            None => return Err(Error::AttestorNotFound),
        };

        order.attestors.set(old_idx, new_attestor.clone());

        // If old attestor had already confirmed, drop its confirmation
        let mut new_confirmations = Vec::new(&env);
        for conf in order.confirmations.iter() {
            if conf != old_attestor {
                new_confirmations.push_back(conf);
            }
        }
        order.confirmations = new_confirmations;

        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        RotateAttestorEvent {
            order_id,
            old_attestor,
            new_attestor,
        }
        .publish(&env);

        Ok(())
    }

    /// Extends the deadline for an order in the escrow registry.
    /// Requires authorization from both `buyer` and `seller`.
    /// `new_deadline` must be strictly greater than the current `deadline`.
    /// Valid only while the order is in a pre-terminal status (not `Claimed`, `Reclaimed`, or `Cancelled`).
    pub fn extend_deadline(env: Env, order_id: u64, new_deadline: u64) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status == OrderStatus::Claimed
            || order.status == OrderStatus::Reclaimed
            || order.status == OrderStatus::Cancelled
        {
            return Err(Error::WrongStatus);
        }

        if new_deadline <= order.deadline {
            return Err(Error::DeadlineNotExtended);
        }

        order.buyer.require_auth();
        order.seller.require_auth();

        let old_deadline = order.deadline;
        order.deadline = new_deadline;

        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        ExtendDeadlineEvent {
            order_id,
            old_deadline,
            new_deadline,
        }
        .publish(&env);

        Ok(())
    }

    /// Buyer raises a dispute against an attested delivery for a given `order_id` before the seller claims.
    /// Only valid while `status == Attested`. Pauses the claim.
    pub fn dispute(
        env: Env,
        order_id: u64,
        evidence_hash: Option<BytesN<32>>,
    ) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status != OrderStatus::Attested {
            return Err(Error::WrongStatus);
        }

        order.buyer.require_auth();

        order.status = OrderStatus::Disputed;
        order.evidence_hash = evidence_hash.clone();
        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        DisputeEvent {
            order_id,
            evidence_hash,
        }
        .publish(&env);

        Ok(())
    }

    /// Designated arbiter resolves a contested attestation for a given `order_id`.
    /// Only valid while `status == Disputed`.
    /// If `release_to_seller == true`: transfers funds to seller and sets status to `Claimed`.
    /// If `release_to_seller == false`: transfers funds to buyer and sets status to `Reclaimed`.
    pub fn resolve_dispute(env: Env, order_id: u64, release_to_seller: bool) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status != OrderStatus::Disputed {
            return Err(Error::WrongStatus);
        }

        order.arbiter.require_auth();

        let token_client = token::Client::new(&env, &order.token);
        if release_to_seller {
            token_client.transfer(&env.current_contract_address(), &order.seller, &order.amount);
            order.status = OrderStatus::Claimed;
        } else {
            token_client.transfer(&env.current_contract_address(), &order.buyer, &order.amount);
            order.status = OrderStatus::Reclaimed;
        }

        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// Claim escrowed payment for a given `order_id`. Must be signed by the designated seller after attestation.
    pub fn claim(env: Env, order_id: u64) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status != OrderStatus::Attested {
            return Err(Error::WrongStatus);
        }

        order.seller.require_auth();

        let token_client = token::Client::new(&env, &order.token);
        token_client.transfer(&env.current_contract_address(), &order.seller, &order.amount);

        order.status = OrderStatus::Claimed;
        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// Reclaim escrowed payment for a given `order_id`. Must be signed by the designated buyer after deadline has passed without attestation.
    pub fn reclaim(env: Env, order_id: u64) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status != OrderStatus::Created {
            return Err(Error::WrongStatus);
        }
        if env.ledger().timestamp() < order.deadline {
            return Err(Error::DeadlineNotYetPassed);
        }

        order.buyer.require_auth();

        let token_client = token::Client::new(&env, &order.token);
        token_client.transfer(&env.current_contract_address(), &order.buyer, &order.amount);

        order.status = OrderStatus::Reclaimed;
        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// Buyer and seller mutually agree to cancel an order before attestation.
    /// Requires authorization from both `buyer` and `seller`.
    /// Valid only while `status == Created`.
    /// Returns funds to the buyer and transitions status to `Cancelled`.
    pub fn cancel(env: Env, order_id: u64) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status != OrderStatus::Created {
            return Err(Error::WrongStatus);
        }

        order.buyer.require_auth();
        order.seller.require_auth();

        let token_client = token::Client::new(&env, &order.token);
        token_client.transfer(&env.current_contract_address(), &order.buyer, &order.amount);

        order.status = OrderStatus::Cancelled;
        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// Returns the order for a given `order_id`.
    pub fn get_order(env: Env, order_id: u64) -> Result<Order, Error> {
        Self::load(&env, order_id)
    }

    fn load(env: &Env, order_id: u64) -> Result<Order, Error> {
        let key = DataKey::Order(order_id);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::OrderNotFound)
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod fuzz_test;
