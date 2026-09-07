#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Created,
    Attested,
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
    pub attestor: Address,
    pub token: Address,
    pub amount: i128,
    pub deadline: u64,
    pub status: OrderStatus,
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
        attestor: Address,
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

        buyer.require_auth();

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        let order = Order {
            order_id,
            buyer,
            seller,
            attestor,
            token,
            amount,
            deadline,
            status: OrderStatus::Created,
        };

        env.storage().persistent().set(&key, &order);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// Attest delivery for a given `order_id`. Must be signed by the designated attestor before the deadline.
    pub fn attest(env: Env, order_id: u64) -> Result<(), Error> {
        let key = DataKey::Order(order_id);
        let mut order = Self::load(&env, order_id)?;

        if order.status != OrderStatus::Created {
            return Err(Error::WrongStatus);
        }
        if env.ledger().timestamp() >= order.deadline {
            return Err(Error::DeadlinePassed);
        }

        order.attestor.require_auth();

        order.status = OrderStatus::Attested;
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
