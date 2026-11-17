// Token Radar — a launch radar that prices pre-token protocols from the snapshot itself.
//
// What this file does:
//   1. Calibrates a value multiple per category from the protocols that already trade:
//      for each live-token protocol, market-cap / TVL; the median of that ratio inside a
//      category is the category's multiple. A category with fewer than five live protocols
//      borrows the median across every live protocol instead. Every multiple is clamped to
//      [0.05, 2.00] so one outlier category cannot run away with the board.
//   2. Scores every pre-token protocol: implied = TVL x category multiple x growth x maturity.
//      Growth is the seven-day TVL change, clamped; maturity is how long the protocol has run
//      with no token. Nothing is keyed to a name: the same arithmetic scores every row.
//   3. Builds the ranked board: the whole 40-slug watchlist, plus the 160 pre-token protocols
//      below the $50M floor with the most TVL, ranked by implied value.
//   4. Writes a six-step farm plan per row, derived from the protocol's own category, chains,
//      TVL and age, with a cost and a time on every step.
//   5. Sets the live-token protocols aside (top 24 by market cap) with their market values,
//      never mixed into the pre-token ranking.
//
// The snapshot is sealed: the same bytes feed every run, so the same code always writes the
// same board. No wall clock, no randomness, no network anywhere in this file.

/** One protocol as the sealed snapshot carries it: exactly ten fields. */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** The model's tunables. Growth and maturity are fixed by the design; the multiples are
 *  calibrated from the snapshot at run time (see calibrate()). */
export const TUNING = {
  growthWeight: 0.5,
  growthLow: -60,
  growthHigh: 120,
  maturityBase: 0.6,
  maturitySpan: 0.4,
  maturityDays: 1095,
  ageWhenUnknown: 365,
  multipleLow: 0.05,
  multipleHigh: 2.0,
  minLiveForOwnMultiple: 5,
  earlyRows: 160,
  liveRows: 24,
} as const;

export const MODEL_LABEL = 'radar-calibrated-1';

/** The calibrated multiples: one per category, plus the overall fallback. */
export interface Multiples {
  /** Category name -> multiple. Only categories with enough live protocols appear here. */
  byCategory: Record<string, number>;
  /** The median multiple across every live protocol; the fallback for thin categories. */
  overall: number;
  /** How many live protocols backed each category's multiple (for the dashboard's explainer). */
  counts: Record<string, number>;
  /** How many live protocols backed the overall median. */
  overallCount: number;
}

/** One scored board row, as board.json carries it. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    multiple: number;
    multiple_source: string;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row as data.js carries it for the page (farm steps included: the page renders
 *  exactly what board.json holds, from the same strings). */
export interface PageRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  multiple_source: string;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol for the Live view: the market's own numbers, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  multiples: Multiples;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: PageRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The middle value of a sorted list; the mean of the two middle values when the count is even. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Clamp a number into [low, high]. */
function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n));
}

/** A finite number, else `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listed` to `asOf`; null when the listing date is absent or unparsable. */
export function ageInDays(asOf: string, listed: string | null): number | null {
  if (listed === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listed}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a version marker (V2, v2, 2.0 ...) is a pool of another protocol, not a
 *  protocol of its own. This is the snapshot's own watchlist rule, reused for the early rows. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A protocol the early radar may carry: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: Proto): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

/**
 * Calibrate the multiples from the protocols that already trade.
 *
 * A live protocol contributes its market-cap / TVL ratio only when both figures are positive
 * and finite (a market cap of 0 or -1 is the feed's way of saying "no number", not a value).
 * The median ratio inside a category is that category's multiple when at least five live
 * protocols back it; a thinner category borrows the median across every live protocol. Each
 * multiple is clamped to [0.05, 2.00].
 */
export function calibrate(protocols: Proto[]): Multiples {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of protocols) {
    if (isPreToken(p)) continue;
    if (!(p.tvl_usd > 0) || p.mcap_usd === null || !(p.mcap_usd > 0)) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio)) continue;
    allRatios.push(ratio);
    const key = p.category ?? '';
    const bucket = ratiosByCategory.get(key);
    if (bucket) bucket.push(ratio);
    else ratiosByCategory.set(key, [ratio]);
  }
  if (allRatios.length === 0) throw new SnapshotError('no live-token protocol carries a market cap to calibrate from');
  const overall = medianOf(allRatios);
  const byCategory: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const [category, ratios] of ratiosByCategory) {
    counts[category] = ratios.length;
    const raw = ratios.length >= TUNING.minLiveForOwnMultiple ? medianOf(ratios) : overall;
    byCategory[category] = clamp(raw, TUNING.multipleLow, TUNING.multipleHigh);
  }
  return { byCategory, overall: clamp(overall, TUNING.multipleLow, TUNING.multipleHigh), counts, overallCount: allRatios.length };
}

/** Where a protocol's multiple came from: its own category, or the overall fallback. */
function multipleFor(p: Proto, multiples: Multiples): { value: number; source: string } {
  const key = p.category ?? '';
  const own = multiples.byCategory[key];
  if (own !== undefined && (multiples.counts[key] ?? 0) >= TUNING.minLiveForOwnMultiple) {
    return { value: own, source: `${p.category} median (${multiples.counts[key]} live)` };
  }
  return { value: multiples.overall, source: `overall median (${multiples.overallCount} live)` };
}

/** The implied value of one protocol, and the pieces the dashboard shows for it. */
export function scoreProtocol(
  p: Proto,
  asOf: string,
  multiples: Multiples,
): { implied: number; multiple: number; multipleSource: string; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const { value: multiple, source: multipleSource } = multipleFor(p, multiples);
  const growthPct = clamp(num(p.change_7d, 0), TUNING.growthLow, TUNING.growthHigh);
  const growthMult = 1 + (growthPct / 100) * TUNING.growthWeight;
  const age = ageInDays(asOf, p.listed_at);
  const ageForModel = age ?? TUNING.ageWhenUnknown;
  const maturityMult =
    TUNING.maturityBase + (Math.min(Math.max(ageForModel, 0), TUNING.maturityDays) / TUNING.maturityDays) * TUNING.maturitySpan;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, multipleSource, growthPct, growthMult, maturityMult, age };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, from the protocol's own TVL. */
function stakeFor(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in words a farmer can follow. The action, the chain and the
 *  capital all come from the protocol's own record; no name is ever special-cased. */
function actionFor(p: Proto, stake: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${stake} of USDC into ${name} on ${chain} and leave the loan open.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return `Add $${stake} of liquidity to ${name}'s largest pool on ${chain} and leave it in.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${stake} of USDC to ${chain} through ${name}, then use the bridged funds inside its app.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${stake} of the chain's staking asset through ${name} and keep the receipt token.`;
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Deposit $${stake} of USDC as margin on ${name} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${stake} on ${name} and take one position in an open market.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${stake} into a ${name} vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${stake} of the stable asset through ${name} on ${chain}.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${stake} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${stake} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  return `Deposit $${stake} of USDC into ${name} on ${chain} and leave the position open.`;
}

/** One farm step as a single string: action, cost and time, inside the gate's 20..600 chars. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a list of
 * names. Step 2 is the category's action; the rest are the same discipline for every row,
 * with the capital and the hold sized to the protocol.
 */
export function farmPlan(p: Proto, age: number | null): string[] {
  const chain = firstChain(p);
  const stake = stakeFor(p);
  const hold = holdFor(age);
  const gas = stake >= 150 ? 8 : 4;
  return [
    stepText(
      'Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    stepText(actionFor(p, stake, chain), `$${stake} of capital and about $${gas} of gas`, '15 minutes to set up'),
    stepText(
      'Do one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    stepText(
      `Keep the position open for at least ${hold} days so the activity lands in more than one snapshot.`,
      `the $${stake} stays in the position`,
      `${hold} days`,
    ),
    stepText(
      `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes.`,
      'no fee to check, and never pay to claim',
      '10 minutes',
    ),
    stepText(
      'Write the wallet, the dates and every transaction in a farm log, so you can repeat the position or unwind it.',
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..N. */
export function buildBoard(snapshot: Snap, multiples: Multiples): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Proto>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: rankable pre-token protocols below the floor, by TVL, capped. A chosen
  // protocol stays chosen; the early rows only add what the watchlist does not name.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, TUNING.earlyRows);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const s = scoreProtocol(p, snapshot.as_of, multiples);
    return { p, ...s };
  });
  // Rank by implied value, strongest first; a tie breaks on the slug, so the order is fixed.
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      multiple: round4(s.multiple),
      multiple_source: s.multipleSource,
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmPlan(s.p, s.age),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live view. */
export function liveSet(snapshot: Snap): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, TUNING.liveRows)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
function pageRow(row: BoardRow): PageRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.multiple,
    multiple_source: row.model.multiple_source,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** The board and everything the dashboard renders, from one snapshot. */
export function buildRadar(snapshot: Snap): { board: BoardRow[]; radar: RadarData } {
  const multiples = calibrate(snapshot.protocols);
  const board = buildBoard(snapshot, multiples);
  const live = liveSet(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_LABEL,
    multiples,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(pageRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared
 *  implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snap): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
