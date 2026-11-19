// Radar-2: the token radar's model, fitted to the snapshot itself on every run.
//
// The board ranks every pre-token protocol the radar can defend: the 40 watchlist slugs plus
// every other pre-token protocol that is not an exchange, a wrapped, staked or bridged product,
// or a versioned pool. Live-token protocols are kept apart and shown at the market's own value.
//
// The value model is a power law fitted at run time to the snapshot's own clean comps — the
// protocols that already trade and are not exchanges, bridges or staking products:
//   log10(implied) = intercept + slope * log10(tvl_usd)
//   implied *= (1 + clamped 7d growth * 0.25) * (0.85 + age share * 0.30)
// The intercept and slope come from ordinary least squares on the comps; the growth and maturity
// weights are stated priors, kept small and bounded, because the comps show growth and age add
// almost no signal once TVL is known (their holdout R-squared is near zero). The dashboard states
// the fit and its limits, including the 5-fold holdout numbers this file computes, so the reader
// sees the model is real and how weak it is, instead of a false precision.
//
// No protocol name is ever special-cased: one function scores every row, and the fit is
// recomputed from whatever snapshot the program is handed.

/** One protocol record: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted power law plus the diagnostics the dashboard prints. */
export interface PowerLawFit {
  intercept: number;
  slope: number;
  r2: number;
  n: number;
  /** Residual spread of the fit in log10 units: the row's range is the fitted value x/÷ 10^(0.674*sd). */
  resid_sd: number;
}

/** Holdout numbers for the fitted model against the house constant-multiple model. */
export interface HoldoutStats {
  folds: number;
  fitted_r2: number;
  starter_r2: number;
  fitted_mdape: number;
  starter_mdape: number;
}

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  watchlist: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  model: {
    fitted_base_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** One row as the dashboard reads it. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  fitted_base_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol, shown at the market's own value, never modelled. */
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
  fit: PowerLawFit;
  holdout: HoldoutStats;
  growth_weight: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why a snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label. */
export const MODEL_VERSION = 'radar-2';

/** The growth prior: a clamped 7d move moves the value by at most a quarter of itself. */
export const GROWTH_WEIGHT = 0.25;
/** The maturity prior: 0.85 for a brand-new protocol, 1.15 at three years. */
export const MATURITY_FLOOR = 0.85;
export const MATURITY_RANGE = 0.3;
export const MATURITY_DAYS = 1095;
/** Age assumed when the snapshot records no listing date. */
export const UNKNOWN_AGE_DAYS = 365;
/** How many live-token protocols the Live tab carries, by market cap. */
export const LIVE_ROWS = 24;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is missing. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A name ending in a release marker is a pool of another protocol, not a launch of its own. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are exchanges or wrapped, staked or bridged products of a trading token. */
const EXCLUDED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);
/** A name beginning with an exchange's name is that exchange's product. */
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
/** A whole word wrapped, staked or staking marks a product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol is an exchange, a wrapped/staked/bridged product, or a versioned pool. */
export function isExcluded(p: SnapshotProtocol): boolean {
  return (
    EXCLUDED_CATEGORIES.has(p.category ?? '') ||
    EXCHANGE_NAME.test(p.name) ||
    WRAPPED_WORD.test(p.name) ||
    VERSIONED.test(p.name)
  );
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether the board may rank a protocol: pre-token and not an excluded product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isExcluded(p);
}

/** Whether a protocol is a clean comp: it trades, and it is not an excluded product. */
export function isCleanComp(p: SnapshotProtocol): boolean {
  return !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && !isExcluded(p);
}

/** Clamp the 7d TVL move into the band the model reads, in per cent. */
function clampedGrowth(p: SnapshotProtocol): number {
  return Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
}

/** Ordinary least squares for y = a + b*x, on paired arrays. */
function olsLine(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b };
}

/** R-squared of a predictor in log space, on the given protocols. */
function logR2(predict: (p: SnapshotProtocol) => number, data: SnapshotProtocol[]): number {
  const ys = data.map((p) => Math.log10(p.mcap_usd!));
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < data.length; i++) {
    const lp = Math.log10(Math.max(1, predict(data[i]!)));
    ssRes += (ys[i]! - lp) * (ys[i]! - lp);
    ssTot += (ys[i]! - mean) * (ys[i]! - mean);
  }
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
}

/** Median absolute percentage error of a predictor, on the given protocols. */
function medianApe(predict: (p: SnapshotProtocol) => number, data: SnapshotProtocol[]): number {
  const errs = data
    .map((p) => Math.abs(Math.max(1, predict(p)) - p.mcap_usd!) / p.mcap_usd!)
    .sort((a, b) => a - b);
  return errs[Math.floor(errs.length / 2)] ?? 0;
}

/** The house constant-multiple model, as a predictor, for the holdout comparison. */
function starterPredict(p: SnapshotProtocol, asOf: string): number {
  const g = clampedGrowth(p);
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  const growthMult = 1 + (g / 100) * 0.5;
  const maturityMult = 0.6 + (Math.min(Math.max(age, 0), 1095) / 1095) * 0.4;
  return Math.max(1, Math.round(p.tvl_usd * 0.25 * growthMult * maturityMult));
}

/** Fit the power law on the snapshot's clean comps, with its diagnostics. */
export function fitPowerLaw(snapshot: Snapshot): PowerLawFit {
  const comps = snapshot.protocols.filter(isCleanComp);
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const { a, b } = olsLine(xs, ys);
  const r2 = logR2((p) => 10 ** (a + b * Math.log10(p.tvl_usd)), comps);
  const residSd = Math.sqrt(
    comps.reduce((s, p, i) => {
      const d = ys[i]! - (a + b * xs[i]!);
      return s + d * d;
    }, 0) / comps.length,
  );
  return { intercept: a, slope: b, r2, n: comps.length, resid_sd: residSd };
}

/** The fitted model's prediction for one protocol, before the priors. */
function fittedBase(p: SnapshotProtocol, fit: PowerLawFit): number {
  return 10 ** (fit.intercept + fit.slope * Math.log10(p.tvl_usd));
}

/** The growth multiplier from the clamped 7d move. */
function growthMultiplier(p: SnapshotProtocol): number {
  return 1 + (clampedGrowth(p) / 100) * GROWTH_WEIGHT;
}

/** The maturity multiplier from the protocol's age with no token. */
function maturityMultiplier(p: SnapshotProtocol, asOf: string): number {
  const age = ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS;
  return MATURITY_FLOOR + (Math.min(Math.max(age, 0), MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_RANGE;
}

/** The full implied value: fitted base, then the two bounded priors. */
export function impliedValue(
  p: SnapshotProtocol,
  fit: PowerLawFit,
  asOf: string,
): { implied: number; base: number; growthMult: number; maturityMult: number; age: number | null } {
  const base = fittedBase(p, fit);
  const growthMult = growthMultiplier(p);
  const maturityMult = maturityMultiplier(p, asOf);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, base, growthMult, maturityMult, age: ageDays(asOf, p.listed_at) };
}

/** Deterministic 5-fold holdout: the fitted model against the house constant, same folds. */
export function holdoutStats(snapshot: Snapshot): HoldoutStats {
  const comps = snapshot.protocols.filter(isCleanComp).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const fittedR2: number[] = [];
  const starterR2: number[] = [];
  const fittedApe: number[] = [];
  const starterApe: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = comps.filter((_, i) => i % 5 !== fold);
    const test = comps.filter((_, i) => i % 5 === fold);
    if (train.length < 10 || test.length === 0) continue;
    const { a, b } = olsLine(
      train.map((p) => Math.log10(p.tvl_usd)),
      train.map((p) => Math.log10(p.mcap_usd!)),
    );
    const foldFit: PowerLawFit = { intercept: a, slope: b, r2: 0, n: train.length, resid_sd: 0 };
    const fitted = (p: SnapshotProtocol) => {
      const base = fittedBase(p, foldFit);
      return Math.max(1, Math.round(base * growthMultiplier(p) * maturityMultiplier(p, snapshot.as_of)));
    };
    fittedR2.push(logR2(fitted, test));
    starterR2.push(logR2((p) => starterPredict(p, snapshot.as_of), test));
    fittedApe.push(medianApe(fitted, test));
    starterApe.push(medianApe((p) => starterPredict(p, snapshot.as_of), test));
  }
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length);
  return {
    folds: fittedR2.length,
    fitted_r2: mean(fittedR2),
    starter_r2: mean(starterR2),
    fitted_mdape: mean(fittedApe),
    starter_mdape: mean(starterApe),
  };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Rough gas for one transaction on the protocol's main chain, in dollars. */
function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 6;
  if (c === 'solana') return 0.05;
  if (c === 'bitcoin') return 3;
  if (['base', 'arbitrum', 'optimism', 'bnb chain', 'polygon', 'avalanche', 'blast', 'mode', 'linea', 'scroll', 'zksync era', 'mantle'].includes(c)) return 0.5;
  return 2;
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) return `Allocate $${capital} to a ${name} vault on ${chain} and hold the shares.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC on ${name} (${chain}) and leave it earning.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Add $${capital} of liquidity to the deepest pool of ${name} on ${chain} and hold the position.`;
  if (c.includes('yield aggregator')) return `Deposit $${capital} of USDC into the top vault of ${name} on ${chain} and let it compound.`;
  if (c.includes('yield') || c.includes('basis')) return `Deposit $${capital} of USDC into the ${name} vault on ${chain} and hold the position.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${capital} of USDC into ${chain} with ${name}, then put the bridged funds to work in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the native asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one small position in a ${name} market.`;
  if (c.includes('stable')) return `Mint or hold $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Buy $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. Every number in it
 * comes from the protocol's own record (category, chains, TVL, age) and the fitted implied value:
 * the capital from its TVL tier, the gas from its main chain, the hold from its age, and the
 * break-even from the gas budget against the fitted value. No hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasPerTx(chain);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const totalGas = Math.round((2 * gas + weeks * gas) * 100) / 100;
  const tinyShare = Math.max(1, Math.round(implied * 0.001));
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, write its seed phrase on paper, and send a $1 test transaction first.`,
      cost: `under $${Math.max(1, Math.ceil(gas))} of gas for the test`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action every week, such as a deposit, a swap, a vote or a claim, so the wallet looks active in every snapshot.`,
      cost: `about $${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Keep the position open for at least ${hold} days, through more than one snapshot, before you touch it.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Add up the spend: about $${totalGas} of gas over ${weeks} weeks on a $${capital} position. The farm only pays if the launch is worth more than $${totalGas} to this wallet, and at the fitted implied value of $${implied.toLocaleString('en-US')}, even a 0.1% allocation would be $${tinyShare.toLocaleString('en-US')}.`,
      cost: 'nothing to add up',
      time: '5 minutes',
    },
    {
      text: `Before you withdraw, open the protocol's own rewards page from its official site and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: PowerLawFit): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, whatever its size.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, no TVL cut-off at all.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const { implied, base, growthMult, maturityMult, age } = impliedValue(p, fit, snapshot.as_of);
    return { p, implied, base, growthMult, maturityMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    token_status: 'pre-token',
    watchlist: snapshot.watchlist.includes(s.p.slug),
    implied_value_usd: s.implied,
    implied_low_usd: Math.max(1, Math.round(s.implied / 10 ** (0.674 * fit.resid_sd))),
    implied_high_usd: Math.max(1, Math.round(s.implied * 10 ** (0.674 * fit.resid_sd))),
    model: {
      fitted_base_usd: Math.round(s.base),
      growth_pct: clampedGrowth(s.p),
      growth_multiplier: Math.round(s.growthMult * 1e4) / 1e4,
      maturity_multiplier: Math.round(s.maturityMult * 1e4) / 1e4,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.implied).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live tab. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
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
export function radarRow(row: BoardRow): RadarRow {
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
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    implied_low_usd: row.implied_low_usd,
    implied_high_usd: row.implied_high_usd,
    fitted_base_usd: row.model.fitted_base_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitPowerLaw(snapshot);
  const holdout = holdoutStats(snapshot);
  const board = buildBoard(snapshot, fit);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fit,
    holdout,
    growth_weight: GROWTH_WEIGHT,
    maturity_floor: MATURITY_FLOOR,
    maturity_range: MATURITY_RANGE,
    maturity_days: MATURITY_DAYS,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
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

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
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
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
