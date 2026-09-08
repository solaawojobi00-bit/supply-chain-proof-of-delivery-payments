/**
 * wallet.js - Client-Side Wallet Integration for Soroban Escrow Frontend
 *
 * Supports:
 *  1. Freighter browser extension (via standard freighter-api interface)
 *  2. Simulated / Local Test Keypair (client-side in-memory signing for testing & demos)
 *
 * Security Guarantee:
 *  - Secret keys are strictly maintained client-side in memory and NEVER sent to any backend API.
 *  - All on-chain actions use client-side signed XDR transactions submitted to the network.
 */

export const NETWORK_PASSPHRASE_TESTNET =
  "Test SDF Future Network ; October 2022";
export const NETWORK_PASSPHRASE_LOCAL = "Standalone Network ; February 2017";

let currentWallet = {
  connected: false,
  address: null,
  type: null, // "freighter" | "simulated"
  secretKey: null, // Only stored locally in memory if using simulated keypair mode
};

const walletListeners = new Set();

export function subscribeWallet(listener) {
  walletListeners.add(listener);
  listener(getWalletState());
  return () => walletListeners.delete(listener);
}

function notifyWalletListeners() {
  const state = getWalletState();
  for (const listener of walletListeners) {
    try {
      listener(state);
    } catch (err) {
      console.error("Error in wallet listener:", err);
    }
  }
}

export function getWalletState() {
  return {
    connected: currentWallet.connected,
    address: currentWallet.address,
    type: currentWallet.type,
    shortAddress: currentWallet.address
      ? `${currentWallet.address.slice(0, 4)}...${currentWallet.address.slice(-4)}`
      : null,
  };
}

/**
 * Check if the Freighter extension is available in the browser window
 */
export async function isFreighterAvailable() {
  if (typeof window === "undefined") return false;
  if (window.freighter) return true;
  try {
    const { isConnected } = await import("@stellar/freighter-api");
    const res = await isConnected();
    return Boolean(res && (res.isConnected ?? res));
  } catch {
    return false;
  }
}

/**
 * Connect to Freighter extension
 */
export async function connectFreighter() {
  if (typeof window === "undefined") {
    throw new Error("Freighter is only available in browser environments.");
  }

  try {
    const freighter = await import("@stellar/freighter-api");
    const isConn = await freighter.isConnected();
    if (!isConn) {
      throw new Error(
        "Freighter extension not detected. Please install Freighter or use Simulated Wallet mode.",
      );
    }

    const access = await freighter.setAllowed();
    if (!access && !access?.isAllowed) {
      throw new Error("Freighter connection access was rejected by user.");
    }

    const addrRes = await freighter.getAddress();
    const address = typeof addrRes === "string" ? addrRes : addrRes?.address;
    if (!address) {
      throw new Error("Unable to retrieve public key address from Freighter.");
    }

    currentWallet = {
      connected: true,
      address,
      type: "freighter",
      secretKey: null,
    };

    notifyWalletListeners();
    return getWalletState();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Freighter connection failed: ${msg}`);
  }
}

/**
 * Connect using a simulated/test keypair (for development and local testing)
 * Accepts either a public address (read-only / mock sign) or a Stellar secret key (S...).
 */
export async function connectSimulated(inputKey) {
  const trimmed = (inputKey || "").trim();
  if (!trimmed) {
    throw new Error(
      "Please enter a valid Stellar Public Key (G...) or Secret Key (S...).",
    );
  }

  if (trimmed.startsWith("S")) {
    try {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const kp = Keypair.fromSecret(trimmed);
      currentWallet = {
        connected: true,
        address: kp.publicKey(),
        type: "simulated",
        secretKey: trimmed,
      };
      notifyWalletListeners();
      return getWalletState();
    } catch (err) {
      throw new Error(`Invalid Stellar secret key: ${err.message}`);
    }
  }

  if (trimmed.startsWith("G") && trimmed.length === 56) {
    currentWallet = {
      connected: true,
      address: trimmed,
      type: "simulated",
      secretKey: null,
    };
    notifyWalletListeners();
    return getWalletState();
  }

  throw new Error(
    "Key must start with G (Public Key) or S (Secret Key) and be 56 characters.",
  );
}

/**
 * Disconnect the current wallet
 */
export function disconnectWallet() {
  currentWallet = {
    connected: false,
    address: null,
    type: null,
    secretKey: null,
  };
  notifyWalletListeners();
}

/**
 * Sign an unsigned transaction XDR client-side
 * @param {string} unsignedXdr - Unsigned transaction envelope XDR
 * @param {object} [options] - Signing options
 * @returns {Promise<string>} Signed transaction XDR
 */
export async function signTransactionClientSide(unsignedXdr, options = {}) {
  if (!currentWallet.connected || !currentWallet.address) {
    throw new Error(
      "Wallet not connected. Connect your wallet to sign transactions.",
    );
  }

  const networkPassphrase =
    options.networkPassphrase ||
    (typeof window !== "undefined" && window.__NETWORK_PASSPHRASE__) ||
    NETWORK_PASSPHRASE_TESTNET;

  if (currentWallet.type === "freighter") {
    const freighter = await import("@stellar/freighter-api");
    const signResult = await freighter.signTransaction(unsignedXdr, {
      networkPassphrase,
    });

    const signedXdr =
      typeof signResult === "string"
        ? signResult
        : signResult?.signedTxXdr || signResult?.xdr;

    if (!signedXdr) {
      throw new Error(
        "User declined to sign transaction or signing failed in Freighter.",
      );
    }
    return signedXdr;
  }

  if (currentWallet.type === "simulated") {
    if (currentWallet.secretKey) {
      const { Keypair, TransactionBuilder, Networks } =
        await import("@stellar/stellar-sdk");
      const kp = Keypair.fromSecret(currentWallet.secretKey);
      const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
      tx.sign(kp);
      return tx.toXDR();
    }

    // If simulated with only public key (e.g. mock test mode in unit tests), return signed simulation blob
    return `${unsignedXdr}-signed-by-${currentWallet.address}`;
  }

  throw new Error(`Unsupported wallet type: ${currentWallet.type}`);
}
