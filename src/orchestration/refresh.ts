import type { CaseState } from "../schemas.js";
import { refreshKamis } from "../tools/refreshKamis.js";
import type { RefreshReport } from "../tools/refreshReport.js";
import { refreshWeather } from "../tools/refreshWeather.js";

export async function refreshStaleFeeds(state: CaseState, retryCount: number, deps: {
  prices?: (retryCount: number) => Promise<RefreshReport>;
  weather?: (county: string, retryCount: number) => Promise<RefreshReport>;
} = {}): Promise<void> {
  const targets = state.last_decision?.target_agents ?? [];
  const prices = deps.prices ?? ((retry) => refreshKamis({ retryCount: retry }));
  const weather = deps.weather ?? ((county, retry) => refreshWeather(county, { retryCount: retry }));
  if (targets.includes("MarketAnalyst")) await prices(retryCount);
  if (targets.includes("StorageWeatherAnalyst")) await weather(state.request.county, retryCount);
}

export async function continueAfterCritique(
  effect: "revise" | "refresh",
  state: CaseState,
  refreshes: number,
  deps?: Parameters<typeof refreshStaleFeeds>[2],
): Promise<void> {
  if (effect === "refresh") await refreshStaleFeeds(state, refreshes, deps);
}
