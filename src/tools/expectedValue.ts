export type EvAction = "sell" | "hold" | "split";

export interface EvInput {
  bags: number;
  sellPricePerBag: number;
  futureP10: number;
  futureP50: number;
  futureP90: number;
  lossMean: number;
  lossP10: number;
  lossP90: number;
  cashNeed: number;
  holdDays: number;
  seed: number;
  simulations?: number;
}

export interface EvResult {
  sellEv: number;
  holdEv: number;
  splitEv: number;
  sellGross: number;
  holdGross: number;
  splitGross: number;
  sellPenalty: number;
  holdPenalty: number;
  splitPenalty: number;
  cashNeed: number;
  penaltyRate: number;
  best: EvAction;
  sellBagsInSplit: number;
  holdBagsInSplit: number;
  holdDays: number;
}

export const EV_SEED = 20261022;
/** Charged once per KES of cash the action does not raise today. */
export const LIQUIDITY_PENALTY = 2;

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function triangular(rng: () => number, left: number, mode: number, right: number): number {
  const lo = Math.min(left, right, mode);
  const hi = Math.max(left, right, mode);
  if (hi <= lo) return mode;
  const mid = Math.min(Math.max(mode, lo), hi);
  const span = hi - lo;
  const cutoff = (mid - lo) / span;
  const draw = rng();
  if (draw < cutoff) return lo + Math.sqrt(draw * span * (mid - lo));
  return hi - Math.sqrt((1 - draw) * span * (hi - mid));
}

function scored(immediateCash: number, terminalWealth: number, cashNeed: number): { gross: number; penalty: number; value: number } {
  const shortfall = Math.max(0, cashNeed - immediateCash);
  const penalty = shortfall * LIQUIDITY_PENALTY;
  return { gross: terminalWealth, penalty, value: terminalWealth - penalty };
}

export function expectedValue(input: EvInput): EvResult {
  if (!(input.bags > 0)) throw new Error("bags must be positive");
  if (!(input.sellPricePerBag > 0)) throw new Error("sell price must be positive");
  const simulations = input.simulations ?? 500;
  if (simulations < 1) throw new Error("simulations must be positive");
  const rng = mulberry32(input.seed);
  const bagsForCash = input.cashNeed > 0 ? Math.ceil(input.cashNeed / input.sellPricePerBag) : 0;
  const sellBagsInSplit = Math.min(input.bags, Math.max(Math.ceil(input.bags / 2), bagsForCash));
  const holdBagsInSplit = input.bags - sellBagsInSplit;
  let sellSum = 0;
  let holdSum = 0;
  let splitSum = 0;
  let sellGrossSum = 0;
  let holdGrossSum = 0;
  let splitGrossSum = 0;
  let sellPenaltySum = 0;
  let holdPenaltySum = 0;
  let splitPenaltySum = 0;
  for (let i = 0; i < simulations; i += 1) {
    const futurePrice = triangular(rng, input.futureP10, input.futureP50, input.futureP90);
    const loss = Math.min(0.95, Math.max(0, triangular(rng, input.lossP10, input.lossMean, input.lossP90)));
    const kept = 1 - loss;
    const sellCash = input.bags * input.sellPricePerBag;
    const holdTerminal = input.bags * kept * futurePrice;
    const splitImmediate = sellBagsInSplit * input.sellPricePerBag;
    const splitTerminal = splitImmediate + holdBagsInSplit * kept * futurePrice;
    const sell = scored(sellCash, sellCash, input.cashNeed);
    const hold = scored(0, holdTerminal, input.cashNeed);
    const split = scored(splitImmediate, splitTerminal, input.cashNeed);
    sellSum += sell.value;
    holdSum += hold.value;
    splitSum += split.value;
    sellGrossSum += sell.gross;
    holdGrossSum += hold.gross;
    splitGrossSum += split.gross;
    sellPenaltySum += sell.penalty;
    holdPenaltySum += hold.penalty;
    splitPenaltySum += split.penalty;
  }
  const sellEv = sellSum / simulations;
  const holdEv = holdSum / simulations;
  const splitEv = splitSum / simulations;
  let best: EvAction = "sell";
  let bestValue = sellEv;
  if (holdEv > bestValue) {
    best = "hold";
    bestValue = holdEv;
  }
  if (splitEv > bestValue) best = "split";
  return {
    sellEv,
    holdEv,
    splitEv,
    sellGross: sellGrossSum / simulations,
    holdGross: holdGrossSum / simulations,
    splitGross: splitGrossSum / simulations,
    sellPenalty: sellPenaltySum / simulations,
    holdPenalty: holdPenaltySum / simulations,
    splitPenalty: splitPenaltySum / simulations,
    cashNeed: input.cashNeed,
    penaltyRate: LIQUIDITY_PENALTY,
    best,
    sellBagsInSplit,
    holdBagsInSplit,
    holdDays: input.holdDays,
  };
}

function kes(value: number): string {
  return Math.round(value).toLocaleString("en-KE");
}

/** Names the cash-need charge so a lower scored hold value is not read as a different grain price. */
export function describeLiquidityPenalty(result: EvResult): string | null {
  if (result.cashNeed <= 0) return null;
  const lines: string[] = [];
  if (result.holdPenalty > 0) {
    lines.push(
      `Holding raises no cash today, so the cash need of ${kes(result.cashNeed)} KES is charged at a penalty rate of ${result.penaltyRate}: ${kes(result.holdPenalty)} KES is subtracted from the hold grain value of ${kes(result.holdGross)} KES, leaving a scored hold value of ${kes(result.holdEv)} KES.`,
    );
  }
  if (result.sellPenalty > 0) {
    lines.push(
      `A full sale still misses part of that cash need, so ${kes(result.sellPenalty)} KES is subtracted from the sale value of ${kes(result.sellGross)} KES.`,
    );
  }
  if (result.splitPenalty > 0) {
    lines.push(
      `The split still misses part of that cash need, so ${kes(result.splitPenalty)} KES is subtracted from its grain-plus-sale value of ${kes(result.splitGross)} KES.`,
    );
  }
  return lines.length > 0 ? lines.join(" ") : null;
}
