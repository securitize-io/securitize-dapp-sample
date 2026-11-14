# Securitize dApp Builder Skill

## Purpose

Use this skill when building dApps that interact with Securitize tokenized real-world assets (RWAs). It covers asset discovery, on-chain contract interaction (swap/redeem), compliance checking, and multi-chain considerations.

---

## Architecture Overview

Securitize tokenized assets follow the **DS Protocol** — a compliance-first token standard built on ERC-20.

```
┌─────────────────────────────────────────────────────────┐
│                     DS Protocol Stack                   │
│                                                         │
│  DSToken (ERC-20 + compliance)                          │
│    ├── Registry Service   (KYC'd investor wallets)      │
│    ├── Compliance Service (transfer rules)              │
│    └── Trust Service      (role/permission management)  │
│                                                         │
│  DSApps (permissioned extension contracts)              │
│    ├── OnRamp DSApp       (subscribe / swap)            │
│    ├── OffRamp DSApp      (redeem via contract)         │
│    └── Bridge DSApp       (cross-chain transfers)       │
└─────────────────────────────────────────────────────────┘
```

**Key principle:** The DSToken itself is minimal. All flows (subscribe, redeem, bridge) are handled by **DSApps** — separate smart contracts that receive narrowly scoped permissions from the token. Never interact with the token directly for subscriptions or redemptions; always go through the appropriate DSApp.

---

## Step 1 — Discover Assets and Contract Addresses

All contract addresses come from the public feed. **Always fetch at runtime; never hardcode.**

```
GET https://public-feed.securitize.io/asset-info
→ { "symbol": ["BUIDL", "ACRED", "VBILL", "STAC", "HLSCOPE", "AAPL", "TSLA", ...] }
```

**The symbol list now includes ISTs and CETs** (stock tokens like AAPL, TSLA alongside fund tokens). Filter them out before iterating:

```
GET https://public-feed.securitize.io/asset-info?filter=ist   → IST entries
GET https://public-feed.securitize.io/asset-info?filter=cet   → CET entries
```

Build an exclusion set from both filter endpoints, then remove those symbols from the main list. Belt-and-suspenders: also check the `InstrumentType` field on each fetched asset (`"IST"` or `"CET"`).

```js
// Step 1: build exclusion set
const excludeSymbols = new Set();
for (const filter of ['ist', 'cet']) {
  const res = await fetch(`${BASE}/asset-info?filter=${filter}`);
  if (res.ok) {
    const json = await res.json();
    (json.data || []).forEach(d => { if (d.symbol) excludeSymbols.add(d.symbol); });
  }
}

// Step 2: filter the main list
const allSymbols = (await fetch(`${BASE}/asset-info`).then(r => r.json())).symbol || [];
const fundSymbols = allSymbols.filter(s => !excludeSymbols.has(s));
```

```
GET https://public-feed.securitize.io/asset-info?symbol=BUIDL
→ { "message": "Query executed successfully", "data": [...] }
```

### Sub-tokens / share classes

Some fund queries return entries for related share classes on the same chain. For example, `?symbol=BUIDL` returns entries for both `BUIDL` and `BUIDL-I` on Ethereum. Each share class has its own `TokenAddress` and its own on-ramp/off-ramp contracts.

When normalizing, detect sub-tokens (entries whose `symbol` differs from the queried symbol), merge their ramps into the parent chain entry, and annotate each merged ramp with `tokenAddress` and `tokenSymbol` so the swap flow approves and receives the correct ERC-20:

```js
const isSubToken = entry.symbol !== queriedSymbol;
const annotateRamp = (r) => isSubToken
  ? { ...r, tokenAddress: entry.TokenAddress, tokenSymbol: entry.symbol }
  : r;
// Merge: chainMap[chainId].onramp.push(...rawOnramps.map(annotateRamp));
```

See `fetchLiveAssetInfo()` in `SamplePage.jsx` for the complete implementation.

**CORS:** The public feed does not serve CORS headers. Fetch it from a backend proxy or server-side route — not directly from the browser. Cache the result to a local JSON file so the app works on cold starts if the fetch fails.

```js
// Server-side proxy pattern — client hits your own endpoint
useEffect(() => {
  fetch('/api/asset-info')          // your server proxies to public-feed.securitize.io
    .then(r => r.json())
    .then(fresh => { if (fresh?.assets) setAssetData(fresh); })
    .catch(() => { /* silently use cached data */ });
}, []);
```

**Normalize the raw API response** before storing. The raw `data` array should be transformed server-side into a shape keyed by symbol with a structured `chains` array. Sub-token ramps carry `tokenAddress` and `tokenSymbol` annotations:

```js
// Suggested normalized shape
{
  assets: {
    BUIDL: {
      symbol: "BUIDL",
      name: "BlackRock USD Institutional Digital Liquidity Fund...",
      icon: "https://...",
      decimals: 6,
      purchaseUrl: "https://id.securitize.io/primary-market/opportunities/341",
      chains: [
        {
          blockchain: "ethereum",
          chainId: 1,
          tokenAddress: "0x7712c...",
          redemptionAddress: "0x8780D...",     // from RedemptionWalletAddress
          onramp: [
            // Sub-token ramp — annotated with tokenAddress/tokenSymbol
            { address: "0x5f94...", coin: "USDC", tokenAddress: "0x6a9D...", tokenSymbol: "BUIDL-I" }
          ],
          offramp: [
            { address: "0x4580...", coin: "USDtb" },   // parent token ramp (no annotation)
            { address: "0x04FB...", coin: "RLUSD" },
            { address: "0x6a4D...", coin: "USDC", tokenAddress: "0x6a9D...", tokenSymbol: "BUIDL-I" }
          ],
        },
        // ...one entry per supported chain
      ]
    }
  }
}
```

**Guard for polymorphic onramp/offramp** — the raw feed returns either `""` or `object[]`:
```js
const onramps  = Array.isArray(raw.onramp)  ? raw.onramp  : [];
const offramps = Array.isArray(raw.offramp) ? raw.offramp : [];
```

---

## Step 2 — Chain Metadata

Maintain a static map of EVM chain metadata for UI display and chain switching. Non-EVM chains (Solana, Aptos) are absent and require separate handling.

```js
const CHAIN_META = {
  1:     { name: 'Ethereum',  hex: '0x1',    color: '#627EEA' },
  10:    { name: 'Optimism',  hex: '0xa',    color: '#FF0420' },
  56:    { name: 'BNB Chain', hex: '0x38',   color: '#F0B90B' },
  137:   { name: 'Polygon',   hex: '0x89',   color: '#8247E5' },
  42161: { name: 'Arbitrum',  hex: '0xa4b1', color: '#12AAFF' },
  43114: { name: 'Avalanche', hex: '0xa86a', color: '#E84142' },
  1329:  { name: 'Sei',       hex: '0x531',  color: '#9B1D1D' },
  4217:  { name: 'Tempo',     hex: '0x1079', color: '#00B2FF' },
  57073: { name: 'Ink',       hex: '0xdf11', color: '#7B61FF' },
};

// Filter to EVM-only chains for wallet interaction
const evmChains = asset.chains.filter(ch => CHAIN_META[ch.chainId]);
```

---

## Step 3 — Wallet Connection

```js
const browserProvider = new ethers.BrowserProvider(window.ethereum);
const accounts        = await browserProvider.send('eth_requestAccounts', []);
const network         = await browserProvider.getNetwork();
const signer          = await browserProvider.getSigner();
const connectedChainId = Number(network.chainId);
```

Listen for chain and account changes and re-check whitelist status on both:

```js
window.ethereum.on('chainChanged',    (hex) => setConnectedChainId(parseInt(hex, 16)));
window.ethereum.on('accountsChanged', (accounts) => {
  if (accounts.length === 0) { /* disconnected */ }
  else setWalletAddress(accounts[0]);
});
```

Switch chain programmatically:

```js
async function switchChain(chainId) {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN_META[chainId].hex }],
    });
  } catch (err) {
    if (err.code === 4902) {
      // Chain not in wallet — user must add it manually
    }
  }
}
```

---

## Step 4 — Check DS Registry (On-Chain Whitelist)

Check whether the connected wallet is registered in the DSToken's Registry Service before enabling swap/redeem. This is a **pure on-chain read** — no backend required.

```js
const DS_TOKEN_ABI = [
  'function getDSService(uint16 serviceId) view returns (address)',
  'function registryService() view returns (address)', // fallback for older token versions
];
const DS_REGISTRY_ABI = [
  'function getInvestor(address wallet) view returns (string)',
];

async function checkDSRegistry(tokenAddress, walletAddress, provider) {
  const dsToken = new ethers.Contract(tokenAddress, DS_TOKEN_ABI, provider);

  // getDSService(1) returns the registry address; fall back to registryService()
  let registryAddress;
  try {
    registryAddress = await dsToken.getDSService(1);
  } catch {
    try { registryAddress = await dsToken.registryService(); }
    catch { return false; }
  }

  if (!registryAddress || registryAddress === ethers.ZeroAddress) return false;

  const registry = new ethers.Contract(registryAddress, DS_REGISTRY_ABI, provider);
  try {
    const investorId = await registry.getInvestor(walletAddress);
    return investorId && investorId.length > 0;
  } catch { return false; }
}
```

**UX based on result:**
- `true` → show swap and redeem panels
- `false` + `purchaseUrl` available → redirect user to Securitize ID to complete onboarding
- `false` + no `purchaseUrl` → show a "contact the issuer" message

Re-run this check whenever the wallet address or chain changes.

---

## Step 5 — Resolve Stablecoin Address and Decimals

The ramp contracts expose their own stablecoin address. Query the contract first; fall back to a static map.

```js
async function resolveStablecoinAddress(rampAddress, coinName, chainId, provider) {
  const ramp = new ethers.Contract(rampAddress, ONRAMP_ABI, provider);
  for (const fn of ['liquidity', 'liquidityToken']) {
    try {
      const addr = await ramp[fn]();
      if (addr && addr !== ethers.ZeroAddress) return addr;
    } catch {}
  }
  return KNOWN_STABLES[coinName]?.[chainId]?.address ?? null;
}

// Fallback stablecoin addresses — prefer querying the contract
const KNOWN_STABLES = {
  USDC: {
    1:     { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    10:    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    56:    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }, // ⚠ 18 on BNB
    137:   { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    42161: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    43114: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
  },
};
```

**Always call `decimals()` on the stablecoin contract** — do not assume 6. USDC on BNB Chain is 18 decimals. Only DSTokens are guaranteed to use 6 decimals across all chains.

```js
async function getTokenDecimals(address, provider) {
  try {
    const c = new ethers.Contract(address, ['function decimals() view returns (uint8)'], provider);
    return Number(await c.decimals());
  } catch { return 6; }
}
```

---

## Step 6 — On-Ramp: Buy (Swap)

`swap` is the headless path — no platform signature required. Available only to wallets already registered in the DS Registry.

```js
async function buyAsset(signer, rampAddress, stableAddress, stableDecimals, amount) {
  const rawAmount      = ethers.parseUnits(amount, stableDecimals);
  const stableContract = new ethers.Contract(stableAddress, ERC20_ABI, signer);
  const onramp         = new ethers.Contract(rampAddress, ONRAMP_ABI, signer);
  const walletAddress  = await signer.getAddress();

  // 1. Approve stablecoin spend
  const allowance = await stableContract.allowance(walletAddress, rampAddress);
  if (allowance < rawAmount) {
    const appTx = await stableContract.approve(rampAddress, rawAmount);
    await appTx.wait();
  }

  // 2. Estimate output, apply 1% slippage using BigInt arithmetic
  const [estimated] = await onramp.calculateDsTokenAmount(rawAmount);
  const minOut = estimated * 99n / 100n;

  // 3. Execute swap
  const tx = await onramp.swap(rawAmount, minOut);
  return tx.wait();
}
```

**Preview before execution** — call `calculateDsTokenAmount` on user input (debounce ≥400ms):
```js
// Returns tuple (uint256 dsTokenAmount, uint256, uint256) — use index 0 only
const [dsTokenOut] = await onramp.calculateDsTokenAmount(rawAmount);
```

---

## Step 7 — Off-Ramp: Sell / Redeem

There are **two distinct redemption paths** depending on whether an OffRamp contract is deployed on the chain. Check before deciding which to use:

```js
const hasOfframpContract = Array.isArray(chainData.offramp) && chainData.offramp.length > 0;
```

### Path A — OffRamp contract (atomic, immediate stablecoin output)

Used when `offramp` has entries. Approve the contract to spend DSTokens; it returns stablecoins in the same transaction.

**Sub-token ramps:** If the ramp entry has `tokenAddress` and `tokenSymbol` fields, use `rampEntry.tokenAddress` instead of the parent's `tokenAddress` for approval and balance checks. This happens when a share class (e.g. BUIDL-I) provides the liquidity path.

```js
async function redeemViaContract(signer, rampEntry, tokenAddress, amount) {
  // Use sub-token address if annotated, otherwise the parent token
  const activeToken   = rampEntry.tokenAddress || tokenAddress;
  const rawAmount     = ethers.parseUnits(amount, 6); // DSToken always 6 decimals
  const tokenContract = new ethers.Contract(activeToken, ERC20_ABI, signer);
  const offramp       = new ethers.Contract(rampEntry.address, OFFRAMP_ABI, signer);
  const walletAddress = await signer.getAddress();

  // 1. Approve DSToken spend
  const allowance = await tokenContract.allowance(walletAddress, rampEntry.address);
  if (allowance < rawAmount) {
    const appTx = await tokenContract.approve(rampEntry.address, rawAmount);
    await appTx.wait();
  }

  // 2. Estimate output, apply slippage
  const estimated = await offramp.calculateLiquidityTokenAmount(rawAmount);
  const minOut    = estimated * 99n / 100n;

  // 3. Redeem
  const tx = await offramp.redeem(rawAmount, minOut);
  return tx.wait();
}
```

### Path B — Transfer to RedemptionWalletAddress (off-chain processing)

Used when no OffRamp contract is deployed (`offramp` is empty). The investor sends DSTokens directly to the fund's redemption wallet. The fund manager processes the redemption off-chain and returns stablecoins separately.

```js
async function redeemViaTransfer(signer, tokenAddress, redemptionAddress, amount) {
  if (!redemptionAddress) throw new Error('No redemption address configured for this chain');
  const rawAmount     = ethers.parseUnits(amount, 6);
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const tx = await tokenContract.transfer(redemptionAddress, rawAmount);
  return tx.wait();
}
```

Always inform the user in the UI when using Path B: the DSTokens leave their wallet immediately but stablecoins arrive via a separate off-chain process with no guaranteed timeframe.

---

## ABIs

```js
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const DS_TOKEN_ABI = [
  'function getDSService(uint16 serviceId) view returns (address)',
  'function registryService() view returns (address)',
];

const DS_REGISTRY_ABI = [
  'function getInvestor(address wallet) view returns (string)',
];

const ONRAMP_ABI = [
  'function swap(uint256 liquidityAmount, uint256 minOutAmount) external',
  'function calculateDsTokenAmount(uint256 _liquidityAmount) view returns (uint256, uint256, uint256)',
  'function liquidity() view returns (address)',
  'function liquidityToken() view returns (address)',
];

const OFFRAMP_ABI = [
  'function redeem(uint256 assetAmount, uint256 minOutputAmount) external',
  'function calculateLiquidityTokenAmount(uint256 assetAmount) view returns (uint256)',
  'function liquidity() view returns (address)',
  'function liquidityToken() view returns (address)',
];
```

---

## Multi-Chain Reference

| Chain | chainId | Notes |
|---|---|---|
| Ethereum | `1` | Widest ramp coverage; USDC (via BUIDL-I), USDtb, RLUSD |
| Polygon | `137` | USDC onramp for BUIDL, ACRED, HLSCOPE |
| Avalanche | `43114` | USDC onramp for ACRED, VBILL |
| Arbitrum | `42161` | BUIDL only |
| Optimism | `10` | BUIDL, HLSCOPE |
| BNB | `56` | BUIDL, VBILL — no ramps; transfer-only redemption |
| Sei | `1329` | ACRED; USDC auto-bridged to Ethereum via Wormhole/CCTPv2 |
| Tempo | `4217` | BUIDL, BRSRV — new chain added 2026 |
| Ink | `57073` | ACRED |
| Solana | `"mainnet-beta"` | Solana mainnet cluster (not a beta network); needs separate wallet adapter |
| Aptos | absent | `chainId`, `rpcURL`, `nativeCurrency` fields missing from feed |

---

## Token Decimals

All Securitize DSTokens use **6 decimals** on every chain. The `decimals` field in the public feed returns `"6.0"` as a string — parse with `parseInt()`.

Do not assume 6 decimals for stablecoins. Always call `decimals()` on the stablecoin contract.

---

## Known Edge Cases

| Issue | Detail |
|---|---|
| CORS on public feed | No CORS headers — proxy from backend, not directly from browser |
| IST/CET in symbol list | The main `/asset-info` list now includes stock tokens (AAPL, TSLA, etc.). Use `?filter=ist` and `?filter=cet` to build an exclusion set; also check `InstrumentType` field per entry |
| Sub-tokens / share classes | `?symbol=BUIDL` returns entries for both BUIDL and BUIDL-I. Merge sub-token ramps into the parent chain entry and annotate with `tokenAddress`/`tokenSymbol` for the swap flow |
| Sub-token approval target | When a ramp entry has `tokenAddress` (sub-token), approve and interact with THAT token contract, not the parent DSToken |
| `onramp`/`offramp` polymorphism | Either `""` or `object[]` — always check `Array.isArray()` |
| BNB USDC decimals | 18, not 6 — always query `decimals()` from the stablecoin contract |
| Empty `RedemptionWalletAddress` | Observed on VBILL/BNB — guard before use |
| `calculateDsTokenAmount` return type | Tuple `(uint256, uint256, uint256)` — use only the first value |
| `getDSService` vs `registryService` | Try `getDSService(1)` first; older token versions expose `registryService()` |
| Aptos missing fields | `chainId`, `nativeCurrency`, `rpcURL` absent — filter out for EVM wallet UIs |
| `nativeCurrencySymbol` on Aptos | Contains asset ticker instead of gas token symbol — ignore |
| ACRED `name` inconsistency | Two different name strings across chains — use `blockchain` + `TokenAddress` as stable identity |
| Infura RPC URLs | End with `/v3/` — append project ID before use |
| Compliance revert on `swap` | Wallet not in DS Registry — redirect to `purchaseUrl` for onboarding |

---

## dApp Checklist

- [ ] Fetch asset data via a server-side proxy (not directly from browser — CORS)
- [ ] Filter out IST/CET symbols using `?filter=ist` and `?filter=cet` exclusion sets
- [ ] Handle sub-token entries (e.g. BUIDL-I): merge ramps into parent chain, annotate with `tokenAddress`/`tokenSymbol`
- [ ] Cache asset data to JSON for cold-start resilience
- [ ] Normalize raw feed data: flatten chains, rename fields, guard onramp/offramp
- [ ] Query stablecoin `decimals()` from the contract — do not assume 6
- [ ] Resolve stablecoin address from ramp contract first; use static map as fallback
- [ ] Check DS Registry on-chain before enabling swap/redeem UI
- [ ] Re-check registry on chain change and account change
- [ ] Redirect non-whitelisted users to `purchaseUrl` for KYC onboarding
- [ ] Approve stablecoin spend before `swap`; approve DSToken spend before OffRamp `redeem`
- [ ] Use `calculateDsTokenAmount` / `calculateLiquidityTokenAmount` to preview output
- [ ] Debounce estimate calls on user input (≥400ms)
- [ ] Apply slippage with BigInt arithmetic (`estimated * 99n / 100n`)
- [ ] Handle both redemption paths (OffRamp contract vs. direct transfer) with appropriate UI messaging
- [ ] Show "no ramp available" state when a chain has neither onramp nor offramp
- [ ] Does NOT hardcode contract addresses — all sourced from the public feed

---

## Key URLs

| Resource | URL |
|---|---|
| Public feed — symbol list | `https://public-feed.securitize.io/asset-info` |
| Public feed — asset info | `https://public-feed.securitize.io/asset-info?symbol={SYMBOL}` |
| Public feed — IST filter | `https://public-feed.securitize.io/asset-info?filter=ist` |
| Public feed — CET filter | `https://public-feed.securitize.io/asset-info?filter=cet` |
| Securitize ID (KYC / onboarding) | `https://id.securitize.io` |
| Securitize Connect API | `https://connect-gw.securitize.io/api/` |
| On/Off Ramp contracts repo | `https://github.com/securitize-io/bc-on-off-ramp-sc` |
| DS Protocol interfaces | `https://github.com/securitize-io/DSTokenInterfaces` |
| DSToken implementation | `https://github.com/securitize-io/dstoken` |
| Reference dApp (sandbox) | `https://ledger.sandbox.securitize.io/` |
| Contact / protocol issues | `protocol@securitize.io` |

---

## Addendum — Embedding in Ledger Live

This section applies only when building a dApp for the Ledger Live dApp browser. Skip if building a standalone web app.

Ledger Live injects a wallet provider via **EIP-6963**. Auto-connect on page load instead of showing a "Connect Wallet" button.

```js
// Auto-connect via EIP-6963 provider discovery
window.addEventListener('eip6963:announceProvider', async (event) => {
  const { provider: announceProvider, info } = event.detail || {};
  if (announceProvider && (info?.rdns?.includes('ledger') || announceProvider.isLedgerLive)) {
    const browserProvider = new ethers.BrowserProvider(announceProvider);
    const accounts = await browserProvider.send('eth_requestAccounts', []);
    if (accounts.length > 0) {
      const network = await browserProvider.getNetwork();
      const signer  = await browserProvider.getSigner();
      // set state...
    }
  }
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

// Fallback: Ledger dApp browser may also expose window.ethereum directly
setTimeout(async () => {
  if (alreadyConnected || !window.ethereum) return;
  // standard connect...
}, 500);
```

**UX differences in Ledger native mode** (pass `?ledger-native=true` to activate):

| Element | Standard dApp | Ledger Live |
|---|---|---|
| Connect Wallet button | Show | Hide — auto-connected |
| Back / navigation button | Show | Hide — Ledger manages navigation |
| Chain switcher UI | Show | Hide — Ledger manages active network |
| Chain mismatch message | Offer switch buttons | Show supported chains as text only |
