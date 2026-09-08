/**
 * app.js - Main Application Controller for Soroban Escrow & Delivery Hub
 */

import {
  getWalletState,
  subscribeWallet,
  connectFreighter,
  connectSimulated,
  disconnectWallet,
} from "./wallet.js";

import {
  getOrders,
  getOrder,
  createOrder,
  attestOrder,
  claimOrder,
} from "./api.js";

// Application State
let currentTab = "buyer";
let allOrders = [];
let roleTokens = JSON.parse(localStorage.getItem("escrow_role_tokens") || "{}");

export function saveRoleToken(orderId, role, token) {
  if (!roleTokens[orderId]) roleTokens[orderId] = {};
  roleTokens[orderId][role] = token;
  localStorage.setItem("escrow_role_tokens", JSON.stringify(roleTokens));
}

export function getRoleToken(orderId, role) {
  return roleTokens[orderId]?.[role];
}

export function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div style="font-size: 1.1rem;">
      ${type === "success" ? "✓" : type === "error" ? "✕" : "ℹ"}
    </div>
    <div style="font-size: 0.85rem; flex: 1;">${message}</div>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(20px)";
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

export function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });
  refreshOrders();
}

export async function refreshOrders() {
  const wallet = getWalletState();
  try {
    if (currentTab === "buyer" && wallet.connected) {
      allOrders = await getOrders({ role: "buyer", address: wallet.address });
      renderBuyerOrders(allOrders);
    } else if (currentTab === "attestor" && wallet.connected) {
      allOrders = await getOrders({
        role: "attestor",
        address: wallet.address,
      });
      renderAttestorOrders(allOrders);
    } else if (currentTab === "seller" && wallet.connected) {
      allOrders = await getOrders({ role: "seller", address: wallet.address });
      renderSellerOrders(allOrders);
    } else {
      allOrders = await getOrders();
      renderExplorerOrders(allOrders);
    }
  } catch (err) {
    console.error("Failed to load orders:", err);
    showToast(`Failed to load orders: ${err.message}`, "error");
  }
}

function renderBadge(status) {
  const s = (status || "").toLowerCase();
  let badgeClass = "badge-created";
  if (s === "attested") badgeClass = "badge-attested";
  else if (s === "claimed") badgeClass = "badge-claimed";
  else if (s === "reclaimed") badgeClass = "badge-reclaimed";
  else if (s === "cancelled") badgeClass = "badge-cancelled";
  else if (s === "disputed") badgeClass = "badge-disputed";

  return `<span class="badge ${badgeClass}">${status}</span>`;
}

function formatDeadline(seconds) {
  if (!seconds) return "N/A";
  const d = new Date(Number(seconds) * 1000);
  const now = Date.now();
  const diff = d.getTime() - now;
  const isPast = diff < 0;
  return `${d.toLocaleString()} ${isPast ? "(Expired)" : ""}`;
}

// Buyer View Renderer
export function renderBuyerOrders(orders) {
  const container = document.getElementById("buyer-orders-list");
  if (!container) return;

  if (!orders || orders.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📦</div>
        <h3>No Buyer Orders Yet</h3>
        <p class="form-help">Create your first escrow order using the form on the left.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = orders
    .map(
      (order) => `
    <div class="order-card" data-order-id="${order.id}">
      <div class="order-card-header">
        <span class="order-numeric-id">Order #${order.numericId || order.id.slice(0, 8)}</span>
        ${renderBadge(order.status)}
      </div>
      <div class="order-meta-grid">
        <div>
          <div class="meta-item-label">Amount</div>
          <div class="meta-item-value" style="color: var(--primary); font-weight: 600;">
            ${(Number(order.amountStroops) / 10000000).toFixed(2)} XLM
          </div>
        </div>
        <div>
          <div class="meta-item-label">Seller</div>
          <div class="meta-item-value" title="${order.sellerAddress}">${order.sellerAddress.slice(0, 6)}...${order.sellerAddress.slice(-4)}</div>
        </div>
        <div>
          <div class="meta-item-label">Attestor</div>
          <div class="meta-item-value" title="${order.attestorAddress}">${order.attestorAddress.slice(0, 6)}...${order.attestorAddress.slice(-4)}</div>
        </div>
        <div>
          <div class="meta-item-label">Deadline</div>
          <div class="meta-item-value">${formatDeadline(order.deadline)}</div>
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
        <button class="btn btn-secondary btn-sm btn-view-details" data-id="${order.id}">Inspect</button>
      </div>
    </div>
  `,
    )
    .join("");

  attachInspectButtons(container);
}

// Attestor View Renderer
export function renderAttestorOrders(orders) {
  const container = document.getElementById("attestor-orders-list");
  if (!container) return;

  if (!orders || orders.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🚚</div>
        <h3>No Attestation Requests</h3>
        <p class="form-help">You have no pending deliveries assigned to your wallet address.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = orders
    .map((order) => {
      const isCreated = order.status === "Created";
      return `
      <div class="order-card" data-order-id="${order.id}">
        <div class="order-card-header">
          <span class="order-numeric-id">Order #${order.numericId || order.id.slice(0, 8)}</span>
          ${renderBadge(order.status)}
        </div>
        <div class="order-meta-grid">
          <div>
            <div class="meta-item-label">Escrow Value</div>
            <div class="meta-item-value" style="color: var(--accent-purple); font-weight: 600;">
              ${(Number(order.amountStroops) / 10000000).toFixed(2)} XLM
            </div>
          </div>
          <div>
            <div class="meta-item-label">Buyer</div>
            <div class="meta-item-value" title="${order.buyerAddress}">${order.buyerAddress.slice(0, 6)}...${order.buyerAddress.slice(-4)}</div>
          </div>
          <div>
            <div class="meta-item-label">Seller</div>
            <div class="meta-item-value" title="${order.sellerAddress}">${order.sellerAddress.slice(0, 6)}...${order.sellerAddress.slice(-4)}</div>
          </div>
          <div>
            <div class="meta-item-label">Deadline</div>
            <div class="meta-item-value">${formatDeadline(order.deadline)}</div>
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; align-items: center;">
          <button class="btn btn-secondary btn-sm btn-view-details" data-id="${order.id}">Details</button>
          ${
            isCreated
              ? `<button class="btn btn-success btn-sm btn-attest" data-id="${order.id}">
                  ✓ Confirm Delivery (Sign)
                </button>`
              : `<span style="font-size: 0.75rem; color: var(--text-subtle);">Attestation Complete</span>`
          }
        </div>
      </div>
    `;
    })
    .join("");

  attachInspectButtons(container);
  attachAttestButtons(container);
}

// Seller View Renderer
export function renderSellerOrders(orders) {
  const container = document.getElementById("seller-orders-list");
  if (!container) return;

  if (!orders || orders.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💰</div>
        <h3>No Seller Orders</h3>
        <p class="form-help">No orders designate your connected wallet as the seller.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = orders
    .map((order) => {
      const canClaim = order.status === "Attested";
      return `
      <div class="order-card" data-order-id="${order.id}">
        <div class="order-card-header">
          <span class="order-numeric-id">Order #${order.numericId || order.id.slice(0, 8)}</span>
          ${renderBadge(order.status)}
        </div>
        <div class="order-meta-grid">
          <div>
            <div class="meta-item-label">Claimable Amount</div>
            <div class="meta-item-value" style="color: var(--accent-green); font-weight: 600;">
              ${(Number(order.amountStroops) / 10000000).toFixed(2)} XLM
            </div>
          </div>
          <div>
            <div class="meta-item-label">Buyer</div>
            <div class="meta-item-value" title="${order.buyerAddress}">${order.buyerAddress.slice(0, 6)}...${order.buyerAddress.slice(-4)}</div>
          </div>
          <div>
            <div class="meta-item-label">Attestor</div>
            <div class="meta-item-value" title="${order.attestorAddress}">${order.attestorAddress.slice(0, 6)}...${order.attestorAddress.slice(-4)}</div>
          </div>
          <div>
            <div class="meta-item-label">Status</div>
            <div class="meta-item-value">${order.lifecycle || order.status}</div>
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; align-items: center;">
          <button class="btn btn-secondary btn-sm btn-view-details" data-id="${order.id}">Details</button>
          ${
            canClaim
              ? `<button class="btn btn-primary btn-sm btn-claim" data-id="${order.id}">
                  💰 Claim Funds (Sign)
                </button>`
              : order.status === "Claimed"
                ? `<span style="font-size: 0.75rem; color: var(--accent-green); font-weight: 600;">Funds Claimed ✓</span>`
                : `<span style="font-size: 0.75rem; color: var(--text-subtle);">Awaiting Attestation</span>`
          }
        </div>
      </div>
    `;
    })
    .join("");

  attachInspectButtons(container);
  attachClaimButtons(container);
}

// Explorer View Renderer
export function renderExplorerOrders(orders) {
  const container = document.getElementById("explorer-orders-list");
  if (!container) return;

  if (!orders || orders.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <h3>No Orders Found</h3>
        <p class="form-help">No matching orders in the system.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = orders
    .map(
      (order) => `
    <div class="order-card" data-order-id="${order.id}">
      <div class="order-card-header">
        <span class="order-numeric-id">Order #${order.numericId || order.id.slice(0, 8)}</span>
        ${renderBadge(order.status)}
      </div>
      <div class="order-meta-grid">
        <div>
          <div class="meta-item-label">Amount</div>
          <div class="meta-item-value">${(Number(order.amountStroops) / 10000000).toFixed(2)} XLM</div>
        </div>
        <div>
          <div class="meta-item-label">Buyer</div>
          <div class="meta-item-value" title="${order.buyerAddress}">${order.buyerAddress.slice(0, 6)}...${order.buyerAddress.slice(-4)}</div>
        </div>
        <div>
          <div class="meta-item-label">Seller</div>
          <div class="meta-item-value" title="${order.sellerAddress}">${order.sellerAddress.slice(0, 6)}...${order.sellerAddress.slice(-4)}</div>
        </div>
        <div>
          <div class="meta-item-label">Attestor</div>
          <div class="meta-item-value" title="${order.attestorAddress}">${order.attestorAddress.slice(0, 6)}...${order.attestorAddress.slice(-4)}</div>
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
        <button class="btn btn-secondary btn-sm btn-view-details" data-id="${order.id}">Inspect Full State</button>
      </div>
    </div>
  `,
    )
    .join("");

  attachInspectButtons(container);
}

function attachInspectButtons(container) {
  container.querySelectorAll(".btn-view-details").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      try {
        const details = await getOrder(id);
        openDetailsModal(details);
      } catch (err) {
        showToast(`Failed to load order details: ${err.message}`, "error");
      }
    });
  });
}

function attachAttestButtons(container) {
  container.querySelectorAll(".btn-attest").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const wallet = getWalletState();
      if (!wallet.connected) {
        showToast("Please connect your attestor wallet first.", "error");
        return;
      }

      btn.disabled = true;
      btn.textContent = "Signing & Submitting...";
      try {
        const token = getRoleToken(id, "attestor");
        await attestOrder(id, {
          attestorAddress: wallet.address,
          roleToken: token,
          unsigned: true,
        });
        showToast("Delivery successfully attested on-chain!", "success");
        refreshOrders();
      } catch (err) {
        console.error("Attestation error:", err);
        showToast(`Attestation failed: ${err.message}`, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "✓ Confirm Delivery (Sign)";
      }
    });
  });
}

function attachClaimButtons(container) {
  container.querySelectorAll(".btn-claim").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const wallet = getWalletState();
      if (!wallet.connected) {
        showToast("Please connect your seller wallet first.", "error");
        return;
      }

      btn.disabled = true;
      btn.textContent = "Signing & Claiming...";
      try {
        const token = getRoleToken(id, "seller");
        await claimOrder(id, {
          roleToken: token,
          unsigned: true,
        });
        showToast("Escrow funds successfully claimed on-chain!", "success");
        refreshOrders();
      } catch (err) {
        console.error("Claim error:", err);
        showToast(`Claim failed: ${err.message}`, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "💰 Claim Funds (Sign)";
      }
    });
  });
}

function openDetailsModal(order) {
  const modal = document.getElementById("details-modal");
  const body = document.getElementById("modal-details-body");
  if (!modal || !body) return;

  body.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 0.85rem; font-size: 0.85rem;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Order ID:</strong>
        <span style="font-family: monospace;">${order.id}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Status:</strong>
        ${renderBadge(order.status)}
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Lifecycle:</strong>
        <span style="color: var(--primary);">${order.lifecycle || "in-transit"}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Contract ID:</strong>
        <span style="font-family: monospace; font-size: 0.75rem;">${order.contractId}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Amount:</strong>
        <span>${(Number(order.amountStroops) / 10000000).toFixed(2)} XLM (${order.amountStroops} stroops)</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Buyer:</strong>
        <span style="font-family: monospace; font-size: 0.75rem;">${order.buyerAddress}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Seller:</strong>
        <span style="font-family: monospace; font-size: 0.75rem;">${order.sellerAddress}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong>Attestor:</strong>
        <span style="font-family: monospace; font-size: 0.75rem;">${order.attestorAddress}</span>
      </div>
      ${
        order.txHashes?.create
          ? `<div style="display: flex; justify-content: space-between; align-items: center;">
              <strong>Create Tx:</strong>
              <span style="font-family: monospace; font-size: 0.75rem; color: var(--accent-green);">${order.txHashes.create.slice(0, 16)}...</span>
            </div>`
          : ""
      }
      ${
        order.txHashes?.attest
          ? `<div style="display: flex; justify-content: space-between; align-items: center;">
              <strong>Attest Tx:</strong>
              <span style="font-family: monospace; font-size: 0.75rem; color: var(--accent-purple);">${order.txHashes.attest.slice(0, 16)}...</span>
            </div>`
          : ""
      }
      ${
        order.txHashes?.claim
          ? `<div style="display: flex; justify-content: space-between; align-items: center;">
              <strong>Claim Tx:</strong>
              <span style="font-family: monospace; font-size: 0.75rem; color: var(--accent-green);">${order.txHashes.claim.slice(0, 16)}...</span>
            </div>`
          : ""
      }
    </div>
  `;

  modal.classList.add("active");
}

// Initialization & Event Binding
export function initApp() {
  // Tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Wallet Subscription
  subscribeWallet((wallet) => {
    const btn = document.getElementById("btn-wallet-connect");
    const info = document.getElementById("wallet-address-pill");
    if (!btn) return;

    if (wallet.connected) {
      btn.textContent = `Disconnect (${wallet.shortAddress})`;
      btn.classList.replace("btn-primary", "btn-secondary");
      if (info)
        info.textContent = `${wallet.type === "freighter" ? "Freighter" : "Simulated"}: ${wallet.shortAddress}`;
    } else {
      btn.textContent = "Connect Wallet";
      btn.classList.replace("btn-secondary", "btn-primary");
      if (info) info.textContent = "Not connected";
    }
    refreshOrders();
  });

  // Wallet Connect Button Click
  const walletBtn = document.getElementById("btn-wallet-connect");
  if (walletBtn) {
    walletBtn.addEventListener("click", () => {
      const wallet = getWalletState();
      if (wallet.connected) {
        disconnectWallet();
        showToast("Wallet disconnected.", "info");
      } else {
        const modal = document.getElementById("wallet-modal");
        if (modal) modal.classList.add("active");
      }
    });
  }

  // Freighter Option
  const freighterBtn = document.getElementById("btn-connect-freighter");
  if (freighterBtn) {
    freighterBtn.addEventListener("click", async () => {
      try {
        await connectFreighter();
        document.getElementById("wallet-modal")?.classList.remove("active");
        showToast("Freighter wallet connected successfully!", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // Simulated Option
  const simBtn = document.getElementById("btn-connect-simulated");
  if (simBtn) {
    simBtn.addEventListener("click", async () => {
      const input = document.getElementById("simulated-key-input");
      const key = input ? input.value : "";
      try {
        await connectSimulated(key);
        document.getElementById("wallet-modal")?.classList.remove("active");
        showToast("Simulated wallet connected for testing!", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // Close modals
  document.querySelectorAll(".modal-close").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.target.closest(".modal-overlay")?.classList.remove("active");
    });
  });

  // Create Order Form
  const form = document.getElementById("create-order-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const wallet = getWalletState();
      if (!wallet.connected) {
        showToast(
          "Please connect your wallet first to sign the order creation transaction.",
          "error",
        );
        return;
      }

      const sellerAddress = document
        .getElementById("order-seller")
        ?.value?.trim();
      const attestorAddress = document
        .getElementById("order-attestor")
        ?.value?.trim();
      const amountXlm = document.getElementById("order-amount")?.value?.trim();
      const deadlineHours = document
        .getElementById("order-deadline")
        ?.value?.trim();
      const webhookUrl =
        document.getElementById("order-webhook")?.value?.trim() || undefined;

      if (!sellerAddress || !attestorAddress || !amountXlm) {
        showToast("Please fill in all required fields.", "error");
        return;
      }

      const amountStroops = String(Math.floor(Number(amountXlm) * 10000000));
      const deadlineSeconds = String(
        Math.floor(Date.now() / 1000) + Number(deadlineHours || 24) * 3600,
      );

      const submitBtn = form.querySelector("button[type='submit']");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Signing & Deploying Escrow...";
      }

      try {
        const order = await createOrder(
          {
            buyerAddress: wallet.address,
            sellerAddress,
            attestorAddress,
            amountStroops,
            deadlineSeconds,
            webhookUrl,
          },
          { unsigned: true },
        );

        if (order.tokens) {
          if (order.tokens.buyer)
            saveRoleToken(order.id, "buyer", order.tokens.buyer);
          if (order.tokens.seller)
            saveRoleToken(order.id, "seller", order.tokens.seller);
          if (order.tokens.attestor)
            saveRoleToken(order.id, "attestor", order.tokens.attestor);
        }

        showToast(
          `Escrow order #${order.numericId || order.id.slice(0, 8)} created successfully!`,
          "success",
        );
        form.reset();
        refreshOrders();
      } catch (err) {
        console.error("Order creation failed:", err);
        showToast(`Creation failed: ${err.message}`, "error");
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Lock Funds in Escrow";
        }
      }
    });
  }

  refreshOrders();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initApp);
}
