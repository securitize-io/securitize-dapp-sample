/**
 * Securitize Sample dApp — reference implementation for third-party developers.
 *
 * This single-file React component demonstrates how to:
 *   1. List tokenized assets from Securitize's public data feed
 *   2. Connect an EVM wallet (MetaMask or any EIP-1193 provider)
 *   3. Verify an investor is whitelisted in the DS Protocol registry
 *   4. Buy tokens atomically via on-ramp contracts (USDC -> DS token)
 *   5. Sell tokens atomically via off-ramp contracts (DS token -> stablecoin)
 *   6. Redeem tokens by transferring them to the fund's redemption wallet
 *
 * Data source:
 *   The page tries to refresh asset metadata from https://public-feed.securitize.io
 *   at load time. That feed currently does NOT send CORS headers, so a direct
 *   browser fetch will fail in most contexts. When that happens, the app falls
 *   back to the bundled ../data/assetInfo.json file. See README.md for the
 *   feed schema and instructions on keeping the local copy up to date.
 *
 * Dependencies:
 *   - React 19
 *   - react-router-dom 7 (for URL-based asset selection via ?symbol=)
 *   - ethers v6 (loaded via <script> in index.html to stay framework-agnostic)
 */
import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import cachedAssetInfo from '../data/assetInfo.json';

// ethers v6 is loaded from CDN in index.html so this file can be consumed as-is
const ethers = window.ethers;

// ─── Public feed endpoint ────────────────────────────────────────────────────
// Change this base URL if Securitize ever moves the feed. See README.md for
// the endpoint semantics.
const PUBLIC_FEED_BASE = 'https://public-feed.securitize.io';

// ─── Theme ───────────────────────────────────────────────────────────────────
const C = {
  bg: '#0d1117',
  bgCard: '#161b22',
  bgInput: '#0d1117',
  border: 'rgba(255,255,255,0.06)',
  borderHover: 'rgba(255,255,255,0.12)',
  text: '#e6edf3',
  textSecondary: '#8b949e',
  textMuted: '#484f58',
  blue: '#3b82f6',
  green: '#3fb950',
  red: '#f85149',
  purple: '#8b5cf6',
  yellow: '#d29922',
};

// ─── Chain metadata ──────────────────────────────────────────────────────────
// Supported EVM chains. Assets returned by the feed on any chain NOT in this
// map are filtered out (e.g. Solana, Aptos). Extend this map to support more.
const CHAIN_META = {
  1:     { name: 'Ethereum', hex: '0x1' },
  10:    { name: 'Optimism', hex: '0xa' },
  56:    { name: 'BNB Chain', hex: '0x38' },
  137:   { name: 'Polygon', hex: '0x89' },
  42161: { name: 'Arbitrum', hex: '0xa4b1' },
  43114: { name: 'Avalanche', hex: '0xa86a' },
  1329:  { name: 'Sei', hex: '0x531' },
  57073: { name: 'Ink', hex: '0xdf11' },
};

// ─── Known stablecoin addresses per chain ────────────────────────────────────
// Used as a fallback when the ramp contract doesn't expose its liquidity
// token via liquidity()/liquidityToken() getters.
const KNOWN_STABLES = {
  USDC: {
    1:     { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    137:   { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    43114: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
    10:    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    42161: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    56:    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  },
};

// ─── ABI fragments ───────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// DSToken (Securitize's ERC-20) exposes the DS Protocol registry via
// getDSService(1) or registryService(). Either returns the registry address.
const DS_TOKEN_ABI = [
  'function getDSService(uint16 serviceId) view returns (address)',
  'function registryService() view returns (address)',
];

// The registry maps wallet -> investor ID. A non-empty ID == whitelisted.
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

// ─── Helpers ─────────────────────────────────────────────────────────────────
const shortAddr = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const fmt = (val, dec) => {
  try { return parseFloat(ethers.formatUnits(val, dec)).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
  catch { return '0'; }
};

async function resolveStablecoinAddress(rampAddress, coinName, chainId, provider) {
  // Query the ramp contract first
  const ramp = new ethers.Contract(rampAddress, [...ONRAMP_ABI, ...OFFRAMP_ABI], provider);
  for (const fn of ['liquidity', 'liquidityToken']) {
    try {
      const addr = await ramp[fn]();
      if (addr && addr !== ethers.ZeroAddress) return addr;
    } catch {}
  }
  // Fall back to known addresses
  const known = KNOWN_STABLES[coinName]?.[chainId];
  if (known) return known.address;
  return null;
}

async function getTokenDecimals(tokenAddress, provider) {
  try {
    const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return Number(await c.decimals());
  } catch { return 6; }
}

async function getTokenSymbol(tokenAddress, provider) {
  try {
    const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await c.symbol();
  } catch { return '???'; }
}

/**
 * Check whether a wallet is whitelisted in the DS Protocol registry for a
 * given DS token. Returns true iff the registry returns a non-empty investor
 * ID for the wallet.
 */
async function checkDSRegistry(tokenAddress, walletAddress, provider) {
  const dsToken = new ethers.Contract(tokenAddress, DS_TOKEN_ABI, provider);
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

/**
 * Refresh asset metadata by pulling fresh data from the public feed.
 *
 * NOTE: public-feed.securitize.io does NOT currently send
 *       Access-Control-Allow-Origin headers, so a direct browser fetch will
 *       normally fail with a CORS error. This function will throw in that
 *       case and callers should fall back to the bundled JSON.
 *
 * A production app that needs always-fresh data should run a small backend
 * proxy that fetches the feed server-side and forwards the JSON to the
 * browser with proper CORS headers. See README.md for details.
 *
 * Filtering: the feed now includes IST (Investor Security Tokens) and CET
 * (Corporate Equity Tokens) alongside fund tokens. This dApp only shows
 * funds, so we fetch the IST/CET lists via the ?filter= parameter and
 * exclude those symbols.
 *
 * Sub-tokens: some assets (e.g. BUIDL) return entries for related share
 * classes (e.g. BUIDL-I) under the same query. These entries have different
 * symbols and token addresses but share the same chainId. We merge their
 * on-ramp/off-ramp contracts into the parent asset's chain data, annotating
 * each ramp with the sub-token's address so the swap flow uses the correct
 * contract for approvals and output.
 */
async function fetchLiveAssetInfo() {
  // ── Step 1: build an exclusion set of IST/CET symbols ───────────────
  const excludeSymbols = new Set();
  for (const filter of ['ist', 'cet']) {
    try {
      const res = await fetch(`${PUBLIC_FEED_BASE}/asset-info?filter=${filter}`);
      if (res.ok) {
        const json = await res.json();
        (json.data || []).forEach(d => { if (d.symbol) excludeSymbols.add(d.symbol); });
      }
    } catch {} // best-effort; if filters fail we still have InstrumentType fallback
  }

  // ── Step 2: fetch the full symbol list and filter ───────────────────
  const listRes = await fetch(`${PUBLIC_FEED_BASE}/asset-info`);
  if (!listRes.ok) throw new Error(`asset-info list returned ${listRes.status}`);
  const listJson = await listRes.json();
  const allSymbols = listJson.symbol || listJson.symbols || [];
  if (!allSymbols.length) throw new Error('asset-info list returned no symbols');

  const symbols = allSymbols.filter(s => !excludeSymbols.has(s));

  // ── Step 3: fetch each fund symbol's data ───────────────────────────
  const assets = {};
  for (const sym of symbols) {
    try {
      const res = await fetch(`${PUBLIC_FEED_BASE}/asset-info?symbol=${sym}`);
      if (!res.ok) continue;
      const json = await res.json();
      const data = json.data || [];
      if (!data.length) continue;

      // Belt-and-suspenders: skip if any entry carries an IST/CET type
      if (data.some(d => d.InstrumentType === 'IST' || d.InstrumentType === 'CET')) continue;

      // Group by chainId, merging sub-token ramps (e.g. BUIDL-I into BUIDL)
      const chainMap = {};
      for (const d of data) {
        if (!d.chainId || typeof d.chainId !== 'number') continue;
        const cid = d.chainId;
        const isSubToken = d.symbol !== sym;

        const rawOnramps  = Array.isArray(d.onramp)  ? d.onramp  : [];
        const rawOfframps = Array.isArray(d.offramp) ? d.offramp : [];

        // Annotate sub-token ramps with their specific token address so the
        // swap flow can approve and receive the correct ERC-20.
        const annotateRamp = (r) => isSubToken
          ? { ...r, tokenAddress: d.TokenAddress, tokenSymbol: d.symbol }
          : r;

        if (!chainMap[cid]) {
          chainMap[cid] = {
            blockchain: d.blockchain,
            chainId: cid,
            tokenAddress: isSubToken ? null : d.TokenAddress,
            redemptionAddress: isSubToken ? '' : (d.RedemptionWalletAddress || ''),
            onramp:  rawOnramps.map(annotateRamp),
            offramp: rawOfframps.map(annotateRamp),
          };
        } else {
          // Merge: prefer the primary token's address/redemption
          if (!isSubToken) {
            chainMap[cid].tokenAddress = d.TokenAddress;
            chainMap[cid].redemptionAddress = d.RedemptionWalletAddress || '';
          }
          chainMap[cid].onramp.push(...rawOnramps.map(annotateRamp));
          chainMap[cid].offramp.push(...rawOfframps.map(annotateRamp));
        }
      }

      // Only keep chains where we have the primary token address
      const chains = Object.values(chainMap).filter(ch => ch.tokenAddress);

      // Use the primary token's metadata (not a sub-token's)
      const primary = data.find(d => d.symbol === sym) || data[0];
      assets[sym] = {
        symbol: sym,
        name: primary?.name || sym,
        icon: primary?.icon || '',
        decimals: parseInt(primary?.decimals) || 6,
        purchaseUrl: primary?.opportunityURL || '',
        chains,
      };
    } catch (err) {
      console.warn(`[sample-dapp] Failed to fetch ${sym}:`, err.message);
    }
  }
  return { symbols, assets };
}

// ─── Logo ────────────────────────────────────────────────────────────────────
const SecuritizeLogo = ({ size = 160 }) => (
  <img src="/securitize-logo.svg" alt="Securitize" style={{ height: size * 0.11, width: 'auto' }} />
);

// ─── Styles ──────────────────────────────────────────────────────────────────
const cardStyle = {
  background: C.bgCard,
  border: `1px solid ${C.border}`,
  borderRadius: 16,
  padding: 24,
};

const inputStyle = {
  width: '100%',
  background: C.bgInput,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: '14px 16px',
  color: C.text,
  fontSize: '1.1rem',
  fontFamily: 'inherit',
  outline: 'none',
};

const btnPrimary = (disabled) => ({
  width: '100%',
  padding: '14px 24px',
  borderRadius: 12,
  border: 'none',
  background: disabled ? C.textMuted : C.blue,
  color: '#fff',
  fontSize: '1rem',
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: 'inherit',
  transition: 'all 0.2s',
  opacity: disabled ? 0.5 : 1,
});

const selectStyle = {
  width: '100%',
  background: C.bgInput,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: '14px 16px',
  color: C.text,
  fontSize: '1rem',
  fontFamily: 'inherit',
  outline: 'none',
  cursor: 'pointer',
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b949e' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 16px center',
};

// ═══════════════════════════════════════════════════════════════════════════════
// ASSET SELECTOR
// ═══════════════════════════════════════════════════════════════════════════════
const AssetSelector = ({ assets, onSelect }) => (
  <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
    <SecuritizeLogo size={200} />
    <p style={{ color: C.textSecondary, marginTop: 16, marginBottom: 40, fontSize: '1rem' }}>
      Sample dApp — access tokenized assets through the Securitize public feed
    </p>

    <div style={{ ...cardStyle, width: '100%', maxWidth: 480 }}>
      <h2 style={{ color: '#fff', fontSize: '1.2rem', fontWeight: 600, marginBottom: 8 }}>Select an Asset</h2>
      <p style={{ color: C.textSecondary, fontSize: '0.85rem', marginBottom: 20 }}>
        Choose a tokenized asset to view swap and redemption options.
      </p>

      <select style={selectStyle} value="" onChange={e => { if (e.target.value) onSelect(e.target.value); }}>
        <option value="">— Choose asset —</option>
        {Object.values(assets).map(a => (
          <option key={a.symbol} value={a.symbol}>{a.symbol} — {a.name}</option>
        ))}
      </select>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginTop: 20 }}>
        {Object.values(assets).map(a => (
          <div
            key={a.symbol}
            onClick={() => onSelect(a.symbol)}
            style={{
              background: C.bgInput, border: `1px solid ${C.border}`, borderRadius: 12,
              padding: 16, cursor: 'pointer', transition: 'all 0.2s',
              display: 'flex', alignItems: 'center', gap: 12,
            }}
            onMouseEnter={e => e.currentTarget.style.borderColor = C.borderHover}
            onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
          >
            {a.icon ? (
              <img src={a.icon} alt={a.symbol} style={{ width: 36, height: 36, borderRadius: 8 }} />
            ) : (
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'rgba(139,92,246,0.15)', border: `1px solid rgba(139,92,246,0.3)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, color: C.purple,
              }}>
                {a.symbol.slice(0, 2)}
              </div>
            )}
            <div>
              <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.9rem' }}>{a.symbol}</div>
              <div style={{ color: C.textSecondary, fontSize: '0.72rem', lineHeight: 1.3 }}>{a.name}</div>
            </div>
          </div>
        ))}
      </div>
    </div>

    <div style={{ marginTop: 32, fontSize: '0.75rem', color: C.textMuted }}>
      Powered by Securitize
    </div>
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
// SWAP PANEL — atomic buy/sell via on-ramp / off-ramp contracts
// ═══════════════════════════════════════════════════════════════════════════════
const SwapPanel = ({ chainData, asset, signer, provider, walletAddress }) => {
  const [mode, setMode] = useState('buy');
  const [amount, setAmount] = useState('');
  const [estimatedOut, setEstimatedOut] = useState(null);
  const [loading, setLoading] = useState(false);
  const [txStatus, setTxStatus] = useState(null);
  const [stableInfo, setStableInfo] = useState(null);
  const [tokenBalance, setTokenBalance] = useState(null);
  const [stableBalance, setStableBalance] = useState(null);
  const [selectedRampIndex, setSelectedRampIndex] = useState(0);

  const ramps = mode === 'buy' ? chainData.onramp : chainData.offramp;
  const hasRamps = ramps && ramps.length > 0;
  const currentRamp = hasRamps ? ramps[selectedRampIndex] || ramps[0] : null;

  // Sub-token support: when a ramp comes from a related share class (e.g.
  // BUIDL-I under BUIDL), the ramp entry carries tokenAddress/tokenSymbol
  // indicating which ERC-20 to approve/receive. Fall back to the primary.
  const activeTokenAddress = currentRamp?.tokenAddress || chainData.tokenAddress;
  const activeTokenSymbol  = currentRamp?.tokenSymbol  || asset.symbol;

  useEffect(() => {
    if (!currentRamp || !provider) return;
    let cancelled = false;
    (async () => {
      const addr = await resolveStablecoinAddress(currentRamp.address, currentRamp.coin, chainData.chainId, provider);
      if (cancelled || !addr) return;
      const dec = await getTokenDecimals(addr, provider);
      const sym = await getTokenSymbol(addr, provider);
      if (!cancelled) setStableInfo({ address: addr, decimals: dec, symbol: sym });
    })();
    return () => { cancelled = true; };
  }, [currentRamp?.address, chainData.chainId, provider]);

  useEffect(() => {
    if (!walletAddress || !provider) return;
    let cancelled = false;
    (async () => {
      // Use the active token (may be a sub-token like BUIDL-I)
      try {
        const token = new ethers.Contract(activeTokenAddress, ERC20_ABI, provider);
        const bal = await token.balanceOf(walletAddress);
        if (!cancelled) setTokenBalance(bal);
      } catch {}
      if (stableInfo?.address) {
        try {
          const stable = new ethers.Contract(stableInfo.address, ERC20_ABI, provider);
          const bal = await stable.balanceOf(walletAddress);
          if (!cancelled) setStableBalance(bal);
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [walletAddress, provider, stableInfo?.address, activeTokenAddress, txStatus]);

  // Debounced estimate of the swap output
  useEffect(() => {
    if (!amount || !currentRamp || !provider || !stableInfo) {
      setEstimatedOut(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        if (mode === 'buy') {
          const rawAmount = ethers.parseUnits(amount, stableInfo.decimals);
          const rampContract = new ethers.Contract(currentRamp.address, ONRAMP_ABI, provider);
          const [dsTokenAmount] = await rampContract.calculateDsTokenAmount(rawAmount);
          setEstimatedOut({ value: dsTokenAmount, decimals: asset.decimals, symbol: activeTokenSymbol });
        } else {
          const rawAmount = ethers.parseUnits(amount, asset.decimals);
          const rampContract = new ethers.Contract(currentRamp.address, OFFRAMP_ABI, provider);
          const liqAmount = await rampContract.calculateLiquidityTokenAmount(rawAmount);
          setEstimatedOut({ value: liqAmount, decimals: stableInfo.decimals, symbol: stableInfo.symbol });
        }
      } catch (err) {
        console.warn('Estimate failed:', err);
        setEstimatedOut(null);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [amount, mode, currentRamp?.address, provider, stableInfo, asset, activeTokenSymbol]);

  const handleSwap = async () => {
    if (!signer || !currentRamp || !amount || !stableInfo) return;
    setLoading(true);
    setTxStatus(null);
    try {
      if (mode === 'buy') {
        // BUY: approve stablecoin spend → call onramp.swap()
        const rawAmount = ethers.parseUnits(amount, stableInfo.decimals);
        const stableContract = new ethers.Contract(stableInfo.address, ERC20_ABI, signer);
        const rampContract = new ethers.Contract(currentRamp.address, ONRAMP_ABI, signer);

        const allowance = await stableContract.allowance(walletAddress, currentRamp.address);
        if (allowance < rawAmount) {
          setTxStatus({ type: 'info', msg: 'Approving stablecoin spend…' });
          const appTx = await stableContract.approve(currentRamp.address, rawAmount);
          await appTx.wait();
        }

        setTxStatus({ type: 'info', msg: 'Executing swap…' });
        const [estimated] = await rampContract.calculateDsTokenAmount(rawAmount);
        // 1% slippage tolerance
        const minOut = estimated * 99n / 100n;
        const tx = await rampContract.swap(rawAmount, minOut);
        const receipt = await tx.wait();
        setTxStatus({ type: 'success', msg: `Swap complete! Tx: ${shortAddr(receipt.hash)}` });
        setAmount('');
      } else {
        // SELL: approve DS token → call offramp.redeem()
        // Use the active token address (may be a sub-token like BUIDL-I)
        const rawAmount = ethers.parseUnits(amount, asset.decimals);
        const tokenContract = new ethers.Contract(activeTokenAddress, ERC20_ABI, signer);
        const rampContract = new ethers.Contract(currentRamp.address, OFFRAMP_ABI, signer);

        const allowance = await tokenContract.allowance(walletAddress, currentRamp.address);
        if (allowance < rawAmount) {
          setTxStatus({ type: 'info', msg: `Approving ${activeTokenSymbol} spend…` });
          const appTx = await tokenContract.approve(currentRamp.address, rawAmount);
          await appTx.wait();
        }

        setTxStatus({ type: 'info', msg: 'Executing redemption swap…' });
        const estimated = await rampContract.calculateLiquidityTokenAmount(rawAmount);
        const minOut = estimated * 99n / 100n;
        const tx = await rampContract.redeem(rawAmount, minOut);
        const receipt = await tx.wait();
        setTxStatus({ type: 'success', msg: `Sell complete! Tx: ${shortAddr(receipt.hash)}` });
        setAmount('');
      }
    } catch (err) {
      console.error('Swap error:', err);
      setTxStatus({ type: 'error', msg: err.reason || err.message || 'Transaction failed' });
    }
    setLoading(false);
  };

  const sourceToken = mode === 'buy'
    ? { symbol: stableInfo?.symbol || currentRamp?.coin || '—', decimals: stableInfo?.decimals || 6, balance: stableBalance }
    : { symbol: activeTokenSymbol, decimals: asset.decimals, balance: tokenBalance };
  const destToken = mode === 'buy'
    ? { symbol: activeTokenSymbol, decimals: asset.decimals }
    : { symbol: stableInfo?.symbol || currentRamp?.coin || '—', decimals: stableInfo?.decimals || 6 };

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h3 style={{ color: '#fff', fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>Swap</h3>
        <div style={{ display: 'flex', gap: 4, background: C.bgInput, borderRadius: 8, padding: 3 }}>
          <button
            onClick={() => { setMode('buy'); setAmount(''); setEstimatedOut(null); setSelectedRampIndex(0); }}
            style={{
              padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: '0.82rem', fontWeight: 600, transition: 'all 0.15s',
              background: mode === 'buy' ? 'rgba(63,185,80,0.15)' : 'transparent',
              color: mode === 'buy' ? C.green : C.textSecondary,
            }}
          >Buy</button>
          <button
            onClick={() => { setMode('sell'); setAmount(''); setEstimatedOut(null); setSelectedRampIndex(0); }}
            style={{
              padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: '0.82rem', fontWeight: 600, transition: 'all 0.15s',
              background: mode === 'sell' ? 'rgba(248,81,73,0.15)' : 'transparent',
              color: mode === 'sell' ? C.red : C.textSecondary,
            }}
          >Sell</button>
        </div>
      </div>

      {!hasRamps ? (
        <div style={{
          background: 'rgba(208,153,34,0.08)', border: `1px solid rgba(208,153,34,0.25)`,
          borderRadius: 12, padding: 20, textAlign: 'center',
        }}>
          <div style={{ fontSize: '0.95rem', color: C.yellow, fontWeight: 500, marginBottom: 4 }}>
            No atomic {mode === 'buy' ? 'buy' : 'sell'} available for {activeTokenSymbol}
          </div>
          <div style={{ fontSize: '0.8rem', color: C.textSecondary }}>
            On this chain, there is no {mode === 'buy' ? 'on-ramp' : 'off-ramp'} contract deployed.
          </div>
        </div>
      ) : (
        <>
          {ramps.length > 1 && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ color: C.textSecondary, fontSize: '0.8rem', display: 'block', marginBottom: 6 }}>
                {mode === 'buy' ? 'Pay with' : 'Receive'}
              </label>
              <select
                style={{ ...selectStyle, padding: '10px 14px', fontSize: '0.9rem' }}
                value={selectedRampIndex}
                onChange={e => { setSelectedRampIndex(Number(e.target.value)); setEstimatedOut(null); }}
              >
                {ramps.map((r, i) => (
                  <option key={i} value={i}>
                    {r.coin}{r.tokenSymbol ? ` (via ${r.tokenSymbol})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ background: C.bgInput, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ color: C.textSecondary, fontSize: '0.8rem' }}>You {mode === 'buy' ? 'pay' : 'sell'}</span>
              {sourceToken.balance !== null && sourceToken.balance !== undefined && (
                <span style={{ color: C.textSecondary, fontSize: '0.8rem' }}>
                  Balance: {fmt(sourceToken.balance, sourceToken.decimals)}
                  <button
                    onClick={() => setAmount(ethers.formatUnits(sourceToken.balance, sourceToken.decimals))}
                    style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: '0.8rem', marginLeft: 4, fontFamily: 'inherit' }}
                  >MAX</button>
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="number" placeholder="0.00" value={amount}
                onChange={e => setAmount(e.target.value)}
                style={{ ...inputStyle, border: 'none', padding: 0, fontSize: '1.4rem', background: 'transparent' }}
              />
              <div style={{ padding: '6px 14px', borderRadius: 20, background: 'rgba(255,255,255,0.06)', fontSize: '0.9rem', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' }}>
                {sourceToken.symbol}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', margin: '-8px 0', position: 'relative', zIndex: 1 }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%', background: C.bgCard,
              border: `3px solid ${C.bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textSecondary} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
            </div>
          </div>

          <div style={{ background: C.bgInput, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ color: C.textSecondary, fontSize: '0.8rem' }}>You receive (est.)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: '1.4rem', color: estimatedOut ? '#fff' : C.textMuted, flex: 1 }}>
                {estimatedOut ? fmt(estimatedOut.value, estimatedOut.decimals) : '0.00'}
              </div>
              <div style={{ padding: '6px 14px', borderRadius: 20, background: 'rgba(255,255,255,0.06)', fontSize: '0.9rem', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' }}>
                {destToken.symbol}
              </div>
            </div>
          </div>

          <button
            disabled={loading || !signer || !amount || Number(amount) <= 0}
            onClick={handleSwap}
            style={btnPrimary(loading || !signer || !amount || Number(amount) <= 0)}
          >
            {!signer ? 'Connect wallet to swap' : loading ? 'Processing…' : mode === 'buy' ? `Buy ${activeTokenSymbol}` : `Sell ${activeTokenSymbol}`}
          </button>
        </>
      )}

      {txStatus && (
        <div style={{
          marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: '0.85rem',
          background: txStatus.type === 'success' ? 'rgba(63,185,80,0.1)' :
                      txStatus.type === 'error' ? 'rgba(248,81,73,0.1)' : 'rgba(59,130,246,0.1)',
          color: txStatus.type === 'success' ? C.green :
                 txStatus.type === 'error' ? C.red : C.blue,
          border: `1px solid ${txStatus.type === 'success' ? 'rgba(63,185,80,0.2)' :
                  txStatus.type === 'error' ? 'rgba(248,81,73,0.2)' : 'rgba(59,130,246,0.2)'}`,
        }}>
          {txStatus.msg}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// REDEEM PANEL — transfer tokens to fund's redemption wallet (off-chain)
// ═══════════════════════════════════════════════════════════════════════════════
const RedeemPanel = ({ chainData, asset, signer, provider, walletAddress }) => {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [txStatus, setTxStatus] = useState(null);
  const [tokenBalance, setTokenBalance] = useState(null);

  useEffect(() => {
    if (!walletAddress || !provider) return;
    let cancelled = false;
    (async () => {
      try {
        const token = new ethers.Contract(chainData.tokenAddress, ERC20_ABI, provider);
        const bal = await token.balanceOf(walletAddress);
        if (!cancelled) setTokenBalance(bal);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [walletAddress, provider, chainData.tokenAddress, txStatus]);

  const handleRedeem = async () => {
    if (!signer || !amount || !chainData.redemptionAddress) return;
    setLoading(true);
    setTxStatus(null);
    try {
      const rawAmount = ethers.parseUnits(amount, asset.decimals);
      const tokenContract = new ethers.Contract(chainData.tokenAddress, ERC20_ABI, signer);
      setTxStatus({ type: 'info', msg: `Transferring ${amount} ${asset.symbol} to redemption address…` });
      const tx = await tokenContract.transfer(chainData.redemptionAddress, rawAmount);
      const receipt = await tx.wait();
      setTxStatus({ type: 'success', msg: `Redemption transfer sent! Tx: ${shortAddr(receipt.hash)}` });
      setAmount('');
    } catch (err) {
      setTxStatus({ type: 'error', msg: err.reason || err.message || 'Transaction failed' });
    }
    setLoading(false);
  };

  if (!chainData.redemptionAddress) {
    return (
      <div style={cardStyle}>
        <h3 style={{ color: '#fff', fontSize: '1.1rem', fontWeight: 600, marginBottom: 12 }}>Redeem</h3>
        <div style={{
          background: 'rgba(208,153,34,0.08)', border: `1px solid rgba(208,153,34,0.25)`,
          borderRadius: 12, padding: 20, textAlign: 'center',
        }}>
          <div style={{ fontSize: '0.95rem', color: C.yellow }}>
            No redemption address configured for {asset.symbol} on this chain.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h3 style={{ color: '#fff', fontSize: '1.1rem', fontWeight: 600, marginBottom: 4 }}>Redeem</h3>
      <p style={{ color: C.textSecondary, fontSize: '0.8rem', marginBottom: 16 }}>
        Transfer tokens to the fund redemption wallet for off-chain processing.
      </p>

      <div style={{ background: C.bgInput, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ color: C.textSecondary, fontSize: '0.8rem' }}>Amount to redeem</span>
          {tokenBalance !== null && (
            <span style={{ color: C.textSecondary, fontSize: '0.8rem' }}>
              Balance: {fmt(tokenBalance, asset.decimals)}
              <button
                onClick={() => setAmount(ethers.formatUnits(tokenBalance, asset.decimals))}
                style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: '0.8rem', marginLeft: 4, fontFamily: 'inherit' }}
              >MAX</button>
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="number" placeholder="0.00" value={amount}
            onChange={e => setAmount(e.target.value)}
            style={{ ...inputStyle, border: 'none', padding: 0, fontSize: '1.4rem', background: 'transparent' }}
          />
          <div style={{ padding: '6px 14px', borderRadius: 20, background: 'rgba(255,255,255,0.06)', fontSize: '0.9rem', fontWeight: 600, color: '#fff' }}>
            {asset.symbol}
          </div>
        </div>
      </div>

      <div style={{
        background: C.bgInput, border: `1px solid ${C.border}`, borderRadius: 8,
        padding: '10px 14px', fontSize: '0.8rem', color: C.textSecondary, marginBottom: 16,
        wordBreak: 'break-all',
      }}>
        <span style={{ color: C.textMuted }}>Redemption address:</span>{' '}
        <span style={{ color: C.text, fontFamily: 'monospace', fontSize: '0.78rem' }}>{chainData.redemptionAddress}</span>
      </div>

      <button
        disabled={loading || !signer || !amount || Number(amount) <= 0}
        onClick={handleRedeem}
        style={btnPrimary(loading || !signer || !amount || Number(amount) <= 0)}
      >
        {!signer ? 'Connect wallet to redeem' : loading ? 'Processing…' : `Redeem ${asset.symbol}`}
      </button>

      {txStatus && (
        <div style={{
          marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: '0.85rem',
          background: txStatus.type === 'success' ? 'rgba(63,185,80,0.1)' :
                      txStatus.type === 'error' ? 'rgba(248,81,73,0.1)' : 'rgba(59,130,246,0.1)',
          color: txStatus.type === 'success' ? C.green :
                 txStatus.type === 'error' ? C.red : C.blue,
          border: `1px solid ${txStatus.type === 'success' ? 'rgba(63,185,80,0.2)' :
                  txStatus.type === 'error' ? 'rgba(248,81,73,0.2)' : 'rgba(59,130,246,0.2)'}`,
        }}>
          {txStatus.msg}
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// NOT WHITELISTED OVERLAY — redirects to the asset's primary-market page
// ═══════════════════════════════════════════════════════════════════════════════
const NotWhitelistedOverlay = ({ symbol, purchaseUrl }) => {
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (countdown <= 0) { window.location.href = purchaseUrl; return; }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, purchaseUrl]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(13,17,23,0.95)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{ ...cardStyle, maxWidth: 500, width: '90%', textAlign: 'center', padding: 40 }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%', margin: '0 auto 24px',
          background: 'rgba(248,81,73,0.12)', border: `2px solid rgba(248,81,73,0.3)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.red} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>

        <h2 style={{ color: '#fff', fontSize: '1.3rem', fontWeight: 600, marginBottom: 12 }}>
          Wallet Not Registered
        </h2>
        <p style={{ color: C.textSecondary, fontSize: '0.95rem', lineHeight: 1.6, marginBottom: 24 }}>
          Your connected wallet is not registered to purchase <strong style={{ color: '#fff' }}>{symbol}</strong>.
          We're redirecting you to complete your registration and onboarding.
        </p>

        <div style={{ position: 'relative', width: 80, height: 80, margin: '0 auto 24px' }}>
          <svg width="80" height="80" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="35" fill="none" stroke={C.border} strokeWidth="4"/>
            <circle
              cx="40" cy="40" r="35" fill="none" stroke={C.blue} strokeWidth="4"
              strokeDasharray={`${2 * Math.PI * 35}`}
              strokeDashoffset={`${2 * Math.PI * 35 * (1 - countdown / 5)}`}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 1s linear', transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }}
            />
          </svg>
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.6rem', fontWeight: 700, color: '#fff',
          }}>{countdown}</div>
        </div>

        <p style={{ color: C.textMuted, fontSize: '0.8rem', marginBottom: 16 }}>
          Redirecting in {countdown} second{countdown !== 1 ? 's' : ''}…
        </p>

        <button
          onClick={() => { window.location.href = purchaseUrl; }}
          style={{ ...btnPrimary(false), maxWidth: 300, margin: '0 auto' }}
        >
          Go to Registration Now →
        </button>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// ASSET PAGE — shown once a symbol is selected via ?symbol=...
// ═══════════════════════════════════════════════════════════════════════════════
const AssetPage = ({ asset, onBack }) => {
  const [walletAddress, setWalletAddress] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [connectedChainId, setConnectedChainId] = useState(null);
  const [isWhitelisted, setIsWhitelisted] = useState(null);
  const [checkingRegistry, setCheckingRegistry] = useState(false);
  const [connectError, setConnectError] = useState(null);

  // Only EVM chains in CHAIN_META are usable (everything else is filtered out)
  const evmChains = asset.chains.filter(ch => CHAIN_META[ch.chainId]);
  const currentChainData = evmChains.find(ch => ch.chainId === connectedChainId);

  // Listen for wallet chain/account changes
  useEffect(() => {
    if (!window.ethereum) return;
    const handleChainChanged = (chainIdHex) => {
      setConnectedChainId(parseInt(chainIdHex, 16));
      setIsWhitelisted(null);
    };
    const handleAccountsChanged = (accounts) => {
      if (accounts.length === 0) {
        setWalletAddress(null); setProvider(null); setSigner(null); setIsWhitelisted(null);
      } else {
        setWalletAddress(accounts[0]); setIsWhitelisted(null);
      }
    };
    window.ethereum.on('chainChanged', handleChainChanged);
    window.ethereum.on('accountsChanged', handleAccountsChanged);
    return () => {
      window.ethereum.removeListener('chainChanged', handleChainChanged);
      window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
    };
  }, []);

  // Registry check whenever wallet/chain changes
  useEffect(() => {
    if (!walletAddress || !currentChainData || !provider) return;
    let cancelled = false;
    setCheckingRegistry(true);
    setIsWhitelisted(null);
    (async () => {
      try {
        const result = await checkDSRegistry(currentChainData.tokenAddress, walletAddress, provider);
        if (!cancelled) setIsWhitelisted(result);
      } catch (err) {
        console.error('Registry check failed:', err);
        if (!cancelled) setIsWhitelisted(false);
      }
      if (!cancelled) setCheckingRegistry(false);
    })();
    return () => { cancelled = true; };
  }, [walletAddress, currentChainData?.tokenAddress, provider]);

  const connectWallet = async () => {
    setConnectError(null);
    if (!window.ethereum) {
      setConnectError('No Ethereum provider detected. Please install MetaMask or another compatible wallet.');
      return;
    }
    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await browserProvider.send('eth_requestAccounts', []);
      const network = await browserProvider.getNetwork();
      const walletSigner = await browserProvider.getSigner();
      setProvider(browserProvider);
      setSigner(walletSigner);
      setWalletAddress(accounts[0]);
      setConnectedChainId(Number(network.chainId));
    } catch (err) {
      setConnectError(err.message || 'Failed to connect wallet');
    }
  };

  const switchChain = async (chainId) => {
    if (!window.ethereum) return;
    const meta = CHAIN_META[chainId];
    if (!meta) return;
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: meta.hex }],
      });
    } catch (err) {
      if (err.code === 4902) {
        setConnectError(`Please add ${meta.name} to your wallet manually.`);
      } else {
        setConnectError(err.message);
      }
    }
  };

  const purchaseUrl = asset.purchaseUrl;

  return (
    <div style={{
      minHeight: '100vh', background: C.bg,
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      color: C.text,
    }}>
      {isWhitelisted === false && purchaseUrl && (
        <NotWhitelistedOverlay symbol={asset.symbol} purchaseUrl={purchaseUrl} />
      )}

      <div style={{
        padding: '20px 24px', borderBottom: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            onClick={onBack}
            style={{
              background: 'none', border: `1px solid ${C.border}`, borderRadius: 8,
              color: C.textSecondary, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: '0.85rem',
            }}
          >← Back</button>
          <SecuritizeLogo size={120} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {walletAddress ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {connectedChainId && CHAIN_META[connectedChainId] && (
                <div style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600,
                  background: 'rgba(139,92,246,0.12)', color: C.purple,
                  border: `1px solid rgba(139,92,246,0.2)`,
                }}>
                  {CHAIN_META[connectedChainId].name}
                </div>
              )}
              <div style={{
                padding: '6px 14px', borderRadius: 8,
                background: 'rgba(63,185,80,0.1)', border: `1px solid rgba(63,185,80,0.2)`,
                color: C.green, fontSize: '0.85rem', fontWeight: 500, fontFamily: 'monospace',
              }}>
                {shortAddr(walletAddress)}
              </div>
            </div>
          ) : (
            <button
              onClick={connectWallet}
              style={{
                padding: '8px 20px', borderRadius: 8, border: 'none',
                background: C.blue, color: '#fff', fontSize: '0.9rem',
                fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >Connect Wallet</button>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
          {asset.icon ? (
            <img src={asset.icon} alt={asset.symbol} style={{ width: 48, height: 48, borderRadius: 12 }} />
          ) : (
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: 'rgba(139,92,246,0.15)', border: `1px solid rgba(139,92,246,0.3)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 700, color: C.purple,
            }}>
              {asset.symbol.slice(0, 2)}
            </div>
          )}
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#fff', margin: 0 }}>{asset.symbol}</h1>
            <p style={{ color: C.textSecondary, fontSize: '0.85rem', margin: 0 }}>{asset.name}</p>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
          {walletAddress && !currentChainData && (
            <div style={{
              background: 'rgba(208,153,34,0.08)', border: `1px solid rgba(208,153,34,0.25)`,
              borderRadius: 12, padding: 16, textAlign: 'center',
            }}>
              <div style={{ fontSize: '0.9rem', color: C.yellow, fontWeight: 500, marginBottom: 8 }}>
                {asset.symbol} is not available on {CHAIN_META[connectedChainId]?.name || `Chain ${connectedChainId}`}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 10 }}>
                {evmChains.map(ch => {
                  const meta = CHAIN_META[ch.chainId];
                  return (
                    <button
                      key={ch.chainId}
                      onClick={() => switchChain(ch.chainId)}
                      style={{
                        padding: '6px 14px', borderRadius: 8,
                        background: 'rgba(59,130,246,0.1)', border: `1px solid rgba(59,130,246,0.2)`,
                        color: C.blue, fontSize: '0.82rem', fontWeight: 500,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >{meta?.name || ch.blockchain}</button>
                  );
                })}
              </div>
            </div>
          )}

          {walletAddress && currentChainData && checkingRegistry && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 16px', borderRadius: 10,
              background: 'rgba(59,130,246,0.06)', border: `1px solid rgba(59,130,246,0.15)`,
            }}>
              <div style={{
                width: 16, height: 16, border: `2px solid ${C.border}`, borderTopColor: C.blue,
                borderRadius: '50%', animation: 'spin 0.8s linear infinite',
              }}/>
              <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
              <span style={{ color: C.textSecondary, fontSize: '0.85rem' }}>Checking investor registry…</span>
            </div>
          )}

          {walletAddress && currentChainData && isWhitelisted === true && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 16px', borderRadius: 10,
              background: 'rgba(63,185,80,0.06)', border: `1px solid rgba(63,185,80,0.15)`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.green }}/>
                <span style={{ color: C.green, fontSize: '0.85rem', fontWeight: 500 }}>
                  Wallet registered on {CHAIN_META[connectedChainId]?.name}
                </span>
              </div>
              {evmChains.length > 1 && (
                <select
                  style={{
                    ...selectStyle, width: 'auto', padding: '4px 28px 4px 10px',
                    fontSize: '0.8rem', background: 'transparent', border: `1px solid rgba(255,255,255,0.1)`,
                  }}
                  value={connectedChainId}
                  onChange={e => switchChain(Number(e.target.value))}
                >
                  {evmChains.map(ch => (
                    <option key={ch.chainId} value={ch.chainId}>
                      {CHAIN_META[ch.chainId]?.name || ch.blockchain}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {walletAddress && currentChainData && isWhitelisted === false && !purchaseUrl && (
            <div style={{
              padding: '10px 16px', borderRadius: 10,
              background: 'rgba(248,81,73,0.06)', border: `1px solid rgba(248,81,73,0.15)`,
              fontSize: '0.85rem', color: C.red,
            }}>
              Your wallet is not registered to purchase {asset.symbol}. Please contact the asset issuer.
            </div>
          )}

          {connectError && (
            <div style={{ padding: '8px 14px', borderRadius: 8, background: 'rgba(248,81,73,0.08)', color: C.red, fontSize: '0.85rem' }}>
              {connectError}
            </div>
          )}
        </div>

        {(() => {
          // Default to Ethereum for the preview UI when no wallet is connected,
          // falling back to the first available EVM chain.
          const displayChainData = currentChainData || evmChains.find(ch => ch.chainId === 1) || evmChains[0];
          if (!displayChainData) return null;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <SwapPanel chainData={displayChainData} asset={asset} signer={signer} provider={provider} walletAddress={walletAddress}/>
              <RedeemPanel chainData={displayChainData} asset={asset} signer={signer} provider={provider} walletAddress={walletAddress}/>
            </div>
          );
        })()}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE — routes between AssetSelector and AssetPage via ?symbol=
// ═══════════════════════════════════════════════════════════════════════════════
const SamplePage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  // Start with the bundled cached data so the UI renders immediately even if
  // the public feed is unreachable.
  const [assetData, setAssetData] = useState(cachedAssetInfo);

  const symbol = searchParams.get('symbol');

  // Attempt a background refresh directly from the public feed. If CORS blocks
  // the request (typical for a browser-only deployment), the catch block logs
  // a warning and the app continues with the bundled JSON. Developers are
  // expected to refresh the bundled JSON periodically — see README.md.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await fetchLiveAssetInfo();
        if (!cancelled && fresh?.assets && Object.keys(fresh.assets).length > 0) {
          setAssetData(fresh);
          console.info('[sample-dapp] Loaded fresh asset data from public feed.');
        }
      } catch (err) {
        console.warn(
          '[sample-dapp] Could not fetch live data from public feed ' +
          '(likely CORS). Falling back to bundled assetInfo.json. ' +
          'See README.md for how to refresh the bundled copy.',
          err.message
        );
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedAsset = symbol ? assetData.assets[symbol] : null;

  if (selectedAsset) {
    return <AssetPage asset={selectedAsset} onBack={() => setSearchParams({})} />;
  }

  return <AssetSelector assets={assetData.assets} onSelect={(sym) => setSearchParams({ symbol: sym })} />;
};

export default SamplePage;
