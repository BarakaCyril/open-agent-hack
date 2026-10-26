import type { CaseState } from "../schemas.js";
import { refreshKamis } from "../tools/refreshKamis.js";
import type { RefreshReport } from "../tools/refreshReport.js";
import { traceRefreshSkipped } from "../tools/refreshState.js";

export async function refreshStaleFeeds(state: CaseState, retryCount: number, deps: {
  prices?: (retryCount: number) => Promise<RefreshReport>;
  weather?: (county: string, retryCount: number) => Promise<RefreshReport>;
} = {}): Promise<void> {
  const targets = state.last_decision?.target_agents ?? [];
  const prices = deps.prices ?? ((retry) => refreshKamis({ retryCount: retry }));
  if (targets.includes("MarketAnalyst")) noteUnavailable(state, await prices(retryCount));
  if (targets.includes("StorageWeatherAnalyst")) {
    if (deps.weather) noteUnavailable(state, await deps.weather(state.request.county, retryCount));
    else {
      traceRefreshSkipped(
        "weather",
        "The forecast is live on maize.weather_daily. There is no file refresh.",
        retryCount,
        "StorageWeatherAnalyst",
      );
    }
  }
}

function noteUnavailable(state: CaseState, report: RefreshReport): void {
  if (!report.unavailable) return;
  const line = report.detail.startsWith("refresh_unavailable:")
    ? report.detail
    : `refresh_unavailable: ${report.detail}`;
  if (!state.refresh_limits.includes(line)) state.refresh_limits.push(line);
}

export async function continueAfterCritique(
  effect: "revise" | "refresh",
  state: CaseState,
  refreshes: number,
  deps?: Parameters<typeof refreshStaleFeeds>[2],
): Promise<void> {
  if (effect === "refresh") await refreshStaleFeeds(state, refreshes, deps);
}
