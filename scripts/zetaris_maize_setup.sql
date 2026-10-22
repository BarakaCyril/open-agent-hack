-- One statement per run. Do not paste the whole file into the SQL editor.
-- Skip a statement that already exists. Replacing the files under
-- /home/zetaris/customer-data/shared/maize/ reloads an existing registration.

CREATE LIGHTNING DATABASE MAIZE_FILES DESCRIBE BY "Maize sample files";

CREATE LIGHTNING FILESTORE TABLE kamis_prices_raw FROM MAIZE_FILES FORMAT CSV OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/kamis_dry_maize.csv",
  header "true"
);

CREATE LIGHTNING FILESTORE TABLE storage_loss_rules_raw FROM MAIZE_FILES FORMAT CSV OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/storage_loss_rules.csv",
  header "true"
);

CREATE LIGHTNING FILESTORE TABLE weather_raw FROM MAIZE_FILES FORMAT JSON OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/weather.json"
);

CREATE LIGHTNING FILESTORE TABLE market_news_raw FROM MAIZE_FILES FORMAT JSON OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/news.json"
);

CREATE LIGHTNING FILESTORE TABLE farmer_ledger_raw FROM MAIZE_FILES FORMAT JSON OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/farmer_ledger.json"
);

CREATE SCHEMASTORE CONTAINER maize;

CREATE OR REPLACE SCHEMASTORE VIEW kamis_prices WITH CONTAINER maize AS
SELECT
  CAST(market_date AS DATE) AS market_date,
  county,
  market_name,
  commodity,
  variety,
  grade,
  CAST(unit_kg AS INT) AS unit_kg,
  CAST(wholesale_price_kes AS DOUBLE) AS wholesale_price_kes,
  CAST(retail_price_kes AS DOUBLE) AS retail_price_kes,
  CAST(volume_bags AS INT) AS volume_bags
FROM MAIZE_FILES.kamis_prices_raw;

CREATE OR REPLACE SCHEMASTORE VIEW weather_daily WITH CONTAINER maize AS
SELECT
  s.county AS county,
  CAST(s.as_of AS DATE) AS as_of,
  s.source AS source,
  CAST(d.date AS DATE) AS forecast_date,
  CAST(d.rain_mm AS DOUBLE) AS rain_mm,
  CAST(d.humidity_pct AS DOUBLE) AS humidity_pct,
  CAST(d.temp_c AS DOUBLE) AS temp_c
FROM MAIZE_FILES.weather_raw
LATERAL VIEW explode(series) series_rows AS s
LATERAL VIEW explode(s.days) day_rows AS d;

CREATE OR REPLACE SCHEMASTORE VIEW market_news WITH CONTAINER maize AS
SELECT
  item.id AS id,
  CAST(item.as_of AS DATE) AS as_of,
  item.county AS county,
  item.maize_type AS maize_type,
  item.status AS status,
  item.direction AS direction,
  item.headline AS headline,
  item.commodity AS commodity
FROM MAIZE_FILES.market_news_raw
LATERAL VIEW explode(items) item_rows AS item;

CREATE OR REPLACE SCHEMASTORE VIEW storage_loss_rules WITH CONTAINER maize AS
SELECT
  storage,
  CAST(rain_mm_min AS DOUBLE) AS rain_mm_min,
  CAST(humidity_min AS DOUBLE) AS humidity_min,
  CAST(daily_loss_pct AS DOUBLE) AS daily_loss_pct
FROM MAIZE_FILES.storage_loss_rules_raw;

CREATE OR REPLACE SCHEMASTORE VIEW farmer_ledger WITH CONTAINER maize AS
SELECT
  entry.farmer_id AS farmer_id,
  entry.county AS county,
  CAST(entry.as_of AS DATE) AS as_of,
  entry.record_type AS record_type,
  entry.verdict AS verdict,
  CAST(entry.hold_days AS INT) AS hold_days,
  CAST(entry.bags AS INT) AS bags,
  entry.storage AS storage,
  CAST(entry.forecast_rain_mm_7d AS DOUBLE) AS forecast_rain_mm_7d,
  entry.notes AS notes
FROM MAIZE_FILES.farmer_ledger_raw
LATERAL VIEW explode(entries) entry_rows AS entry;
