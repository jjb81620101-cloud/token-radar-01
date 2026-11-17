[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/jjb81620101-cloud/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/jjb81620101-cloud/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar — a category-calibrated token launch radar

[Token launch radar bounty](https://make.fun/bounty/token-radar-01) · entry for
[make.fun](https://make.fun) competition `token-radar-01`.

A radar for the token that is not there yet. It ranks 200 pre-token protocols by
an implied token value calibrated from the snapshot's own live-token figures —
never a hardcoded list of names — and gives every row a concrete six-step farm
plan with a cost and a time.

## What it does

`main.ts` reads the frozen DefiLlama snapshot (`/input/snapshot.json`, as of
2026-11-14, floor $50M) and writes, deterministically:

- `board.json` — 200 ranked rows: all 40 watchlist protocols plus 160
  pre-token protocols below the $50M floor, by TVL. Ranked by implied value
  descending.
- `data.js` — the same board plus the top 24 live-token protocols by market
  cap, as `window.RADAR`, for the dashboard.
- `dashboard/` — a single-page dashboard (sortable, filterable board; detail
  drawer with the model breakdown and the six farm steps; a model explainer;
  a separate Live-token view).
- `screenshots/` — three screenshots of the dashboard (board, detail view,
  filtered view).
- `dossier.json` — the entry dossier, built by the house's
  `vendor/makefun-board.ts`.

The run is deterministic: no wall-clock, no unseeded randomness. Running it
twice on the same snapshot produces byte-identical output.

## The model — `radar-calibrated-1`

The starter scores every protocol with one fixed multiple, 0.25. This entry
calibrates the multiple from the snapshot itself, per category:

1. For every live-token protocol, compute `mcap_usd / tvl_usd`.
2. Take the **median** of that ratio per category (fallback to the overall
   median when a category has fewer than 5 live protocols).
3. Clamp the multiple to `[0.05, 2.0]`.

Then, for a pre-token protocol:

```
implied = TVL × category_multiple × growth_mult × maturity_mult
```

- **growth** — `clamp(change_7d, -60, 120)`; `growth_mult = 1 + (growth / 100) × 0.5`
  (a missing `change_7d` counts as 0).
- **maturity** — age in days from `listed_at` to the snapshot's `as_of`
  (missing `listed_at` counts as 365 days);
  `maturity_mult = 0.6 + min(age, 1095) / 1095 × 0.4`.
- `implied = max(1, round(TVL × multiple × growth_mult × maturity_mult))`,
  whole dollars.

Calibrated multiples from this snapshot (overall median **0.2138**, n=128 live
protocols with a positive TVL and market cap):

| Category | Multiple | n |
| --- | --- | --- |
| Lending | 0.1324 | 15 |
| Dexs | 0.3424 | 11 |
| Yield | 0.1914 | 9 |
| Liquid Staking | 0.0500 | 9 (raw 0.0406, clamped) |
| CEX | 0.0748 | 9 |
| RWA | 0.2748 | 9 |
| Canonical Bridge | 0.7464 | 8 |
| Basis Trading | 0.6544 | 7 |
| Bridge | 0.5567 | 6 |
| every other category | 0.2138 (overall) | — |

Live-token protocols are never in the ranked board; the top 24 by market cap
appear in a separate Live view, so the board is purely a pre-token ranking.
The judge can read the formula and every multiple in the dashboard's model
explainer, and the detail drawer shows each row's own breakdown.

## Farm plans

Each row carries six steps, derived from the protocol's own category, chains,
TVL and age — never a hardcoded name list. The action varies by category
(lending/supply, dex/liquidity, bridge, staking, perps, prediction, vault,
stable, RWA, insurance, or a plain deposit), and every step names a concrete
action, a cost and a time.

## Run it

```sh
node main.ts --input /input/snapshot.json
```

`main.ts` reads the snapshot from `--input` (default `/input/snapshot.json`)
and writes to the directory in `MAKEFUN_OUTPUT_DIR` (default `/output`).
Node 22, standard library only, no network. It runs twice in the grader's
sandbox; both runs must produce identical output.

## Layout

```
main.ts                  entrypoint: read snapshot, build board, write outputs
lib/model.ts             snapshot parser, calibrated model, board, farm plans
dashboard/               index.html, app.css, app.js (the radar, dark theme)
vendor/makefun-board.ts  house dossier library (verbatim from the starter)
screenshots/             board, detail view, filtered view
```

## Board (this snapshot)

- 200 rows, 40 / 40 watchlist covered, 160 early rows below the floor.
- Implied value from **$464,924,662** (Steakhouse Financial) to **$323,621**
  (marginfi-lst).
- Top 5: Steakhouse Financial, Gauntlet, Veda, USDD, Upshift.
- Live view top 3 by market cap: Rain, Aave V2, Mantle Bridge.
