/** Shared by GET /counties and scripts/coverage_report.ts. */
export const COVERAGE_WINDOW_DAYS = 14;
export const SUPPORTED_MIN_QUOTES = 3;

export function coverageFromQuoteCount(count: number): "supported" | "limited" {
  return count >= SUPPORTED_MIN_QUOTES ? "supported" : "limited";
}

/** Zetaris SQL. Same commodity filter and window as the Postgres report. */
export function zetarisCountyQuoteSql(): string {
  return `SELECT county, COUNT(*) AS n FROM maize.kamis_prices WHERE lower(commodity) = 'dry maize' AND market_date >= date_sub(current_date(), ${COVERAGE_WINDOW_DAYS}) GROUP BY county`;
}

/** Postgres SQL for maize-db.kamis_prices. Counties with no quote in the window stay at 0. */
export function postgresCountyQuoteSql(): string {
  return `SELECT c.county, COUNT(p.market_date)::int AS n
FROM (SELECT DISTINCT county FROM kamis_prices) c
LEFT JOIN kamis_prices p
  ON p.county = c.county
 AND lower(p.commodity) = 'dry maize'
 AND p.market_date >= CURRENT_DATE - ${COVERAGE_WINDOW_DAYS}
GROUP BY c.county
ORDER BY c.county`;
}
