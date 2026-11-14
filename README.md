# Securitize dApp Sample

A reference implementation of a front-end dApp that reads tokenized-asset
metadata from the Securitize public data feed and lets an investor:

- Browse the list of available tokenized assets
- Connect an EVM wallet (MetaMask or any EIP-1193 provider)
- Verify their wallet is whitelisted in the DS Protocol investor registry
- Buy an asset atomically by swapping USDC (or other stablecoins) via an
  on-ramp contract
- Sell an asset atomically via an off-ramp contract
- Redeem an asset by transferring tokens to the fund's redemption wallet

This project is intentionally minimal and self-contained so third-party
developers can use it as a starting point for their own integrations.

> **Deep-dive reference:** [`docs/SECURITIZE_SKILL.md`](./docs/SECURITIZE_SKILL.md)
> — a comprehensive technical guide to building dApps on top of Securitize
> tokenized assets: DS Protocol architecture, asset discovery, compliance
> checks, all relevant ABIs, chain metadata, known edge cases, and a
> step-by-step checklist. Read it before (or alongside) the source code.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000/securitize-sample
```

Build for production:

```bash
npm run build        # emits static files in ./dist
npm run preview      # serve ./dist locally
```

The built `dist/` folder is fully static — you can host it on any CDN or
static-file server (S3, Cloudflare Pages, Netlify, GitHub Pages, …). No
backend is required.

---

## Project layout

```
securitize-dapp-sample/
├── index.html                     # entry, loads ethers from CDN
├── package.json
├── vite.config.js                 # minimal Vite config, no middleware
├── LICENSE
├── NOTICE
├── README.md
├── docs/
│   └── SECURITIZE_SKILL.md        # deep-dive developer guide
├── public/
│   ├── securitize-logo.svg
│   └── securitize-icon.svg
└── src/
    ├── main.jsx                   # router — mounts /securitize-sample
    ├── index.css
    ├── pages/SamplePage.jsx       # the entire dApp in a single file
    └── data/assetInfo.json        # bundled cache of the public feed
```

---

## Data source

The app sources all asset metadata (supported chains, token contracts,
on-ramp/off-ramp contracts, redemption wallet addresses, icons, primary
market URLs) from the Securitize public data feed at:

```
https://public-feed.securitize.io
```

### CORS caveat

At the time of writing, the public feed does **not** return
`Access-Control-Allow-Origin` headers, so a direct browser fetch from a
different origin will be blocked by the browser. The sample app handles
this gracefully:

1. On load it attempts to fetch fresh data from the feed.
2. If the fetch fails (CORS or any other reason) it logs a warning to the
   console and falls back to the bundled `src/data/assetInfo.json`.

This means **the app always renders**, even offline, using whatever data
was most recently committed to `assetInfo.json`.

### Keeping the local cache fresh

**It is the developer's responsibility to periodically refresh
`src/data/assetInfo.json` from the public feed** and redeploy the app.
The app will never update that file by itself.

A trivial way to regenerate it from a terminal:

```bash
# List available symbols
curl -s https://public-feed.securitize.io/asset-info | jq .symbol

# Fetch per-asset data
curl -s 'https://public-feed.securitize.io/asset-info?symbol=BUIDL' | jq .
```

A simple refresh script is easy to write — fetch the symbol list, fetch
each symbol's data, transform into the shape described below, and write
it to `src/data/assetInfo.json`. See the `fetchLiveAssetInfo()` function
in `src/pages/SamplePage.jsx` for the exact transformation the app uses
at runtime; running the same logic from Node is the simplest approach.

### Optional: bypass CORS with a server-side proxy

If you want live data without manually refreshing the JSON, run a small
backend that fetches the feed server-to-server (no CORS there) and
forwards the JSON to the browser with proper `Access-Control-Allow-Origin`
headers. Then point `PUBLIC_FEED_BASE` in `SamplePage.jsx` at your proxy.
This is out of scope for the sample app but only a few lines of Express /
Fastify / Cloudflare Worker.

---

## Public feed — endpoint reference

### `GET /asset-info`

Returns the list of symbols currently served by the feed. **Note:** this
list now includes IST (Investor Security Tokens) and CET (Corporate
Equity Tokens) alongside fund tokens. Use the `?filter=` parameter
(see below) to identify and exclude them.

```json
{
  "symbol": ["BUIDL", "ACRED", "VBILL", "HLSCOPE", "STAC", "CURR", "AAPL", …]
}
```

### `GET /asset-info?filter=ist` / `GET /asset-info?filter=cet`

Returns entries for a specific instrument type. Useful for building an
exclusion set — the sample app fetches both lists and removes those
symbols before iterating the main list.

Each entry includes an `InstrumentType` field (`"IST"` or `"CET"`).

### `GET /asset-info?symbol=<SYMBOL>`

Returns per-blockchain deployment data for a single asset.

```json
{
  "data": [
    {
      "symbol": "BUIDL",
      "name": "BlackRock USD Institutional Digital Liquidity Fund",
      "icon": "https://…/buidl.png",
      "decimals": "6",
      "blockchain": "ethereum",
      "chainId": 1,
      "TokenAddress": "0x7712c34205737192402172409a8f7ccef8aa2aec",
      "RedemptionWalletAddress": "0x8780Dd016171B91E4Df47075dA0a947959C34200",
      "onramp": "",
      "offramp": [
        { "address": "0x…", "coin": "USDtb" },
        { "address": "0x…", "coin": "RLUSD" }
      ],
      "opportunityURL": "https://id.securitize.io/primary-market/opportunities/341",
      "nativeCurrencySymbol": "ETH",
      "rpcURL": "https://mainnet.infura.io/v3/",
      "nativeCurrency": { "name": "ETH", "decimals": 18, "symbol": "ETH" }
    },
    {
      "symbol": "BUIDL-I",
      "blockchain": "ethereum",
      "chainId": 1,
      "TokenAddress": "0x6a9DA2D710BB9B700acde7Cb81F10F1fF8C89041",
      "onramp": [{ "address": "0x…", "coin": "USDC" }],
      "offramp": [{ "address": "0x…", "coin": "USDC" }]
    },
    { /* …one entry per chain the asset is deployed on… */ }
  ],
  "result": 12345678.9
}
```

Field notes:

| Field                    | Meaning                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `symbol`                 | Asset or share-class symbol. **May differ from the query parameter** (e.g. `BUIDL-I` under `?symbol=BUIDL`).      |
| `name`                   | Human-readable fund name                                                                                           |
| `icon`                   | PNG/SVG logo URL                                                                                                   |
| `decimals`               | ERC-20 decimals of the DS token (string, parse to int)                                                             |
| `blockchain`             | Lowercase chain name (e.g. `ethereum`, `polygon`, `avalanche`, `solana`, `tempo`)                                  |
| `chainId`                | Numeric EVM chain id. **Only present for EVM chains.** Non-EVM entries (Solana, Aptos…) are filtered out by the app. |
| `TokenAddress`           | Address of the DS token (ERC-20) on this chain                                                                     |
| `RedemptionWalletAddress`| Fund wallet that receives tokens when an investor redeems off-chain (may be empty)                                 |
| `onramp`                 | Array of `{ address, coin }` entries for atomic buy contracts. **Empty string `""` (not array)** when no on-ramp is deployed. |
| `offramp`                | Array of `{ address, coin }` entries for atomic sell contracts. **Empty string `""` (not array)** when no off-ramp is deployed. |
| `opportunityURL`         | Public primary-market page where a non-whitelisted investor can register                                           |
| `InstrumentType`         | Present on IST/CET entries: `"IST"` or `"CET"`. Absent on fund tokens.                                            |
| `nativeCurrencySymbol`   | Native gas token symbol for the chain                                                                              |
| `rpcURL`                 | RPC endpoint base URL for the chain                                                                                |
| `nativeCurrency`         | Object with `name`, `decimals`, `symbol` of the chain's native token                                              |
| `BridgeAddress`          | Wormhole bridge contract (if cross-chain bridging is available)                                                    |

`result` at the top level is the aggregate AUM of the asset across all chains.

#### Sub-tokens / share classes

Some fund queries return entries for related share classes alongside the
primary token. For example, `?symbol=BUIDL` returns entries for both
`BUIDL` and `BUIDL-I` on the same chain. Each share class has its own
`TokenAddress` and its own on-ramp/off-ramp contracts. The sample app
merges these into the parent asset's chain data and annotates each ramp
with the sub-token's address so the swap flow approves and receives the
correct ERC-20. See `fetchLiveAssetInfo()` in `SamplePage.jsx`.

### `GET /asset-stats` (optional)

An alternative endpoint that returns per-symbol, per-blockchain AUM and
NAV aggregates. Not used by the sample dApp but useful if you want to
render total AUM in your own UI.

```
GET https://public-feed.securitize.io/asset-stats
GET https://public-feed.securitize.io/asset-stats?symbol=BUIDL
```

---

## Local JSON schema

The bundled `src/data/assetInfo.json` follows a normalised shape that the
sample app consumes directly:

```json
{
  "symbols": ["BUIDL", "ACRED", …],
  "assets": {
    "BUIDL": {
      "symbol": "BUIDL",
      "name": "BlackRock USD Institutional Digital Liquidity Fund Ltd. (\"BUIDL\")",
      "icon": "https://…",
      "decimals": 6,
      "purchaseUrl": "https://id.securitize.io/primary-market/opportunities/341",
      "chains": [
        {
          "blockchain": "ethereum",
          "chainId": 1,
          "tokenAddress": "0x7712…",
          "redemptionAddress": "0x8780…",
          "onramp": [
            { "address": "0x5f94…", "coin": "USDC", "tokenAddress": "0x6a9D…", "tokenSymbol": "BUIDL-I" }
          ],
          "offramp": [
            { "address": "0x4580…", "coin": "USDtb" },
            { "address": "0x04FB…", "coin": "RLUSD" },
            { "address": "0x6a4D…", "coin": "USDC", "tokenAddress": "0x6a9D…", "tokenSymbol": "BUIDL-I" }
          ]
        }
      ]
    }
  }
}
```

The transformation from the raw feed response to this shape lives in
`fetchLiveAssetInfo()` in `src/pages/SamplePage.jsx`. Reuse it verbatim
from a Node refresh script if you want.

---

## Smart-contract flow

### DS Protocol registry check

Before any UI surfaces a "Buy" button, the app calls the DS token's
registry to check whether the connected wallet is a registered investor:

```
DSToken.getDSService(1)         -> registry address
                                   (falls back to registryService())
Registry.getInvestor(wallet)    -> non-empty string iff whitelisted
```

If the wallet is **not** whitelisted, the app shows an overlay and
redirects to the asset's `opportunityURL` (primary-market page) so the
user can register.

### Buy (on-ramp)

```
1. Stablecoin.approve(onramp, amount)
2. onramp.calculateDsTokenAmount(amount)       -> expected output
3. onramp.swap(amount, expectedOutput * 99%)   -> 1% slippage tolerance
```

### Sell (off-ramp)

```
1. DSToken.approve(offramp, amount)
2. offramp.calculateLiquidityTokenAmount(amount) -> expected output
3. offramp.redeem(amount, expectedOutput * 99%)
```

### Redeem (off-chain)

Plain ERC-20 transfer of the DS token to the fund's
`redemptionAddress`. The fund processes redemption off-chain.

---

## Extending the sample

- **More chains**: add entries to the `CHAIN_META` map in
  `SamplePage.jsx`. Anything not in that map is filtered out of the UI.
- **More stablecoins**: add entries to the `KNOWN_STABLES` map for chains
  where the ramp contract doesn't expose `liquidity()` / `liquidityToken()`.
- **More routes**: the router lives in `src/main.jsx`. The single
  `/securitize-sample` route is there to keep the sample focused.

---

## What this sample deliberately does NOT include

- No backend, proxy, or server-side code (keep it inspectable)
- No wallet-connect libraries (uses raw EIP-1193 `window.ethereum`)
- No transaction history / analytics / portfolio views
- No fiat on-ramp integrations
- No gas estimation UI beyond the basics ethers provides

These are easy to layer on top — start with this code as a base.

---

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). Fork it,
modify it, ship it — commercial or not.

### Trademark and brand — *not* licensed

The Apache 2.0 license **does not** grant any right to use Securitize's
name, logo, or other brand assets (see Section 6 of the License and the
[`NOTICE`](./NOTICE) file).

In plain English:

- You **may** reference "Securitize" factually to describe what your
  software does — e.g. "this dApp integrates with the Securitize public
  feed" — because that's accurate origin/interoperability language.
- You **may not** name your fork or product anything like "Securitize X",
  put the Securitize logo on your UI or marketing, or imply endorsement,
  sponsorship, or affiliation.

Trademark questions: legal@securitize.io.
