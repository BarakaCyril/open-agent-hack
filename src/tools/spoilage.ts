export interface ForecastDay {
  date: string;
  rain_mm: number;
  humidity_pct: number;
}

export interface StorageRule {
  storage: string;
  rain_mm_min: number;
  humidity_min: number;
  daily_loss_pct: number;
}

export interface LossEstimate {
  mean: number;
  p10: number;
  p90: number;
  days: number;
  rulesMatched: number;
  totalRainMm: number;
}

export function matchRule(storage: string, day: ForecastDay, rules: StorageRule[]): StorageRule | null {
  const candidates = rules.filter(
    (rule) => rule.storage === storage && day.rain_mm >= rule.rain_mm_min && day.humidity_pct >= rule.humidity_min,
  );
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => b.rain_mm_min - a.rain_mm_min || b.humidity_min - a.humidity_min || b.daily_loss_pct - a.daily_loss_pct,
  );
  return candidates[0] ?? null;
}

function compoundLoss(storage: string, forecast: ForecastDay[], rules: StorageRule[], rainScale: number): { loss: number; matched: number } {
  let remaining = 1;
  let matched = 0;
  for (const day of forecast) {
    const scaled: ForecastDay = { ...day, rain_mm: day.rain_mm * rainScale };
    const rule = matchRule(storage, scaled, rules);
    if (!rule) continue;
    matched += 1;
    const daily = Math.min(0.5, Math.max(0, rule.daily_loss_pct / 100));
    remaining *= 1 - daily;
  }
  return { loss: 1 - remaining, matched };
}

export function expectedLoss(storage: string, forecast: ForecastDay[], rules: StorageRule[]): LossEstimate {
  if (forecast.length === 0) throw new Error("no forecast days");
  if (!rules.some((rule) => rule.storage === storage)) {
    throw new Error(`no storage rules for ${storage}`);
  }
  const base = compoundLoss(storage, forecast, rules, 1);
  const low = compoundLoss(storage, forecast, rules, 0.7).loss;
  const high = compoundLoss(storage, forecast, rules, 1.3).loss;
  const totalRainMm = forecast.reduce((sum, day) => sum + day.rain_mm, 0);
  return {
    mean: base.loss,
    p10: Math.min(low, base.loss, high),
    p90: Math.max(low, base.loss, high),
    days: forecast.length,
    rulesMatched: base.matched,
    totalRainMm,
  };
}
