-- Maize live gateway. One statement per block. Re-run with
--   python3 scripts/run_sql.py --skip-exists zetaris/setup_maize.sql
-- after scripts/setup_zetaris.sh has copied the files and started maize-db.
-- The password token is replaced from the environment by that script.
-- Do not put a real password in this file.
-- @generated-counties is refreshed from data/counties.csv by the setup script.

-- 1
CREATE LIGHTNING DATABASE MAIZE_FILES DESCRIBE BY "Maize sample files";

-- 2
CREATE SCHEMASTORE CONTAINER maize;

-- 3
CREATE LIGHTNING FILESTORE TABLE kamis_prices_raw FROM MAIZE_FILES FORMAT CSV OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/kamis_dry_maize.csv",
  header "true",
  inferSchema "true"
);

-- 4
CREATE LIGHTNING FILESTORE TABLE weather_raw FROM MAIZE_FILES FORMAT JSON OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/weather.json",
  multiLine "true",
  inferSchema "true"
);

-- 5
CREATE LIGHTNING FILESTORE TABLE market_news_raw FROM MAIZE_FILES FORMAT JSON OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/news.json",
  multiLine "true",
  inferSchema "true"
);

-- 6
CREATE LIGHTNING FILESTORE TABLE storage_loss_rules_raw FROM MAIZE_FILES FORMAT CSV OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/storage_loss_rules.csv",
  header "true",
  inferSchema "true"
);

-- 7
CREATE LIGHTNING FILESTORE TABLE farmer_ledger_raw FROM MAIZE_FILES FORMAT JSON OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/farmer_ledger.json",
  multiLine "true",
  inferSchema "true"
);

-- 8
CREATE LIGHTNING FILESTORE TABLE counties_raw FROM MAIZE_FILES FORMAT CSV OPTIONS (
  path "/home/zetaris/customer-data/shared/maize/counties.csv",
  header "true",
  inferSchema "true"
);

-- 9
CREATE LIGHTNING DATABASE OPEN_METEO DESCRIBE BY "Open Meteo forecast";

-- @generated-counties-start
CREATE LIGHTNING REST TABLE kirinyaga_forecast FROM OPEN_METEO REQUEST(
    endpoint "https://api.open-meteo.com/v1/forecast?latitude=-0.4688780&longitude=37.3027681&daily=precipitation_sum,temperature_2m_mean&hourly=relative_humidity_2m&timezone=Africa%2FNairobi&forecast_days=7",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

CREATE LIGHTNING REST TABLE nakuru_forecast FROM OPEN_METEO REQUEST(
    endpoint "https://api.open-meteo.com/v1/forecast?latitude=-0.4597932&longitude=36.1007930&daily=precipitation_sum,temperature_2m_mean&hourly=relative_humidity_2m&timezone=Africa%2FNairobi&forecast_days=7",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

CREATE LIGHTNING REST TABLE machakos_forecast FROM OPEN_METEO REQUEST(
    endpoint "https://api.open-meteo.com/v1/forecast?latitude=-1.2790046&longitude=37.3952698&daily=precipitation_sum,temperature_2m_mean&hourly=relative_humidity_2m&timezone=Africa%2FNairobi&forecast_days=7",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

CREATE LIGHTNING REST TABLE nairobi_forecast FROM OPEN_METEO REQUEST(
    endpoint "https://api.open-meteo.com/v1/forecast?latitude=-1.3023980&longitude=36.8288509&daily=precipitation_sum,temperature_2m_mean&hourly=relative_humidity_2m&timezone=Africa%2FNairobi&forecast_days=7",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

CREATE LIGHTNING REST TABLE uasin_gishu_forecast FROM OPEN_METEO REQUEST(
    endpoint "https://api.open-meteo.com/v1/forecast?latitude=0.4771938&longitude=35.3050597&daily=precipitation_sum,temperature_2m_mean&hourly=relative_humidity_2m&timezone=Africa%2FNairobi&forecast_days=7",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

CREATE LIGHTNING REST TABLE nyandarua_forecast FROM OPEN_METEO REQUEST(
    endpoint "https://api.open-meteo.com/v1/forecast?latitude=-0.3917064&longitude=36.4977397&daily=precipitation_sum,temperature_2m_mean&hourly=relative_humidity_2m&timezone=Africa%2FNairobi&forecast_days=7",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

CREATE LIGHTNING REST TABLE garissa_forecast FROM OPEN_METEO REQUEST(
    endpoint "https://api.open-meteo.com/v1/forecast?latitude=-0.5236333&longitude=40.3564053&daily=precipitation_sum,temperature_2m_mean&hourly=relative_humidity_2m&timezone=Africa%2FNairobi&forecast_days=7",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();

CREATE OR REPLACE SCHEMASTORE VIEW weather_daily WITH CONTAINER maize AS
SELECT county, as_of, source, forecast_date, precipitation_sum, temperature_2m_mean, humidity_pct, rain_mm, temp_c
FROM (
    SELECT 'Kirinyaga' AS county,
           MAX(CAST(to_date(daily.time[0]) AS DATE)) AS as_of,
           'open-meteo' AS source,
           CAST(to_date(hourly.time[hour_idx]) AS DATE) AS forecast_date,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS precipitation_sum,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temperature_2m_mean,
           AVG(humidity) AS humidity_pct,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS rain_mm,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temp_c
    FROM OPEN_METEO.kirinyaga_forecast
    LATERAL VIEW posexplode(hourly.relative_humidity_2m) u AS hour_idx, humidity
    GROUP BY CAST(to_date(hourly.time[hour_idx]) AS DATE)
    UNION ALL
    SELECT 'Nakuru' AS county,
           MAX(CAST(to_date(daily.time[0]) AS DATE)) AS as_of,
           'open-meteo' AS source,
           CAST(to_date(hourly.time[hour_idx]) AS DATE) AS forecast_date,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS precipitation_sum,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temperature_2m_mean,
           AVG(humidity) AS humidity_pct,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS rain_mm,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temp_c
    FROM OPEN_METEO.nakuru_forecast
    LATERAL VIEW posexplode(hourly.relative_humidity_2m) u AS hour_idx, humidity
    GROUP BY CAST(to_date(hourly.time[hour_idx]) AS DATE)
    UNION ALL
    SELECT 'Machakos' AS county,
           MAX(CAST(to_date(daily.time[0]) AS DATE)) AS as_of,
           'open-meteo' AS source,
           CAST(to_date(hourly.time[hour_idx]) AS DATE) AS forecast_date,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS precipitation_sum,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temperature_2m_mean,
           AVG(humidity) AS humidity_pct,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS rain_mm,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temp_c
    FROM OPEN_METEO.machakos_forecast
    LATERAL VIEW posexplode(hourly.relative_humidity_2m) u AS hour_idx, humidity
    GROUP BY CAST(to_date(hourly.time[hour_idx]) AS DATE)
    UNION ALL
    SELECT 'Nairobi' AS county,
           MAX(CAST(to_date(daily.time[0]) AS DATE)) AS as_of,
           'open-meteo' AS source,
           CAST(to_date(hourly.time[hour_idx]) AS DATE) AS forecast_date,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS precipitation_sum,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temperature_2m_mean,
           AVG(humidity) AS humidity_pct,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS rain_mm,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temp_c
    FROM OPEN_METEO.nairobi_forecast
    LATERAL VIEW posexplode(hourly.relative_humidity_2m) u AS hour_idx, humidity
    GROUP BY CAST(to_date(hourly.time[hour_idx]) AS DATE)
    UNION ALL
    SELECT 'Uasin Gishu' AS county,
           MAX(CAST(to_date(daily.time[0]) AS DATE)) AS as_of,
           'open-meteo' AS source,
           CAST(to_date(hourly.time[hour_idx]) AS DATE) AS forecast_date,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS precipitation_sum,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temperature_2m_mean,
           AVG(humidity) AS humidity_pct,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS rain_mm,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temp_c
    FROM OPEN_METEO.uasin_gishu_forecast
    LATERAL VIEW posexplode(hourly.relative_humidity_2m) u AS hour_idx, humidity
    GROUP BY CAST(to_date(hourly.time[hour_idx]) AS DATE)
    UNION ALL
    SELECT 'Nyandarua' AS county,
           MAX(CAST(to_date(daily.time[0]) AS DATE)) AS as_of,
           'open-meteo' AS source,
           CAST(to_date(hourly.time[hour_idx]) AS DATE) AS forecast_date,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS precipitation_sum,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temperature_2m_mean,
           AVG(humidity) AS humidity_pct,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS rain_mm,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temp_c
    FROM OPEN_METEO.nyandarua_forecast
    LATERAL VIEW posexplode(hourly.relative_humidity_2m) u AS hour_idx, humidity
    GROUP BY CAST(to_date(hourly.time[hour_idx]) AS DATE)
    UNION ALL
    SELECT 'Garissa' AS county,
           MAX(CAST(to_date(daily.time[0]) AS DATE)) AS as_of,
           'open-meteo' AS source,
           CAST(to_date(hourly.time[hour_idx]) AS DATE) AS forecast_date,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS precipitation_sum,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temperature_2m_mean,
           AVG(humidity) AS humidity_pct,
           MAX(daily.precipitation_sum[CAST(hour_idx / 24 AS INT)]) AS rain_mm,
           MAX(daily.temperature_2m_mean[CAST(hour_idx / 24 AS INT)]) AS temp_c
    FROM OPEN_METEO.garissa_forecast
    LATERAL VIEW posexplode(hourly.relative_humidity_2m) u AS hour_idx, humidity
    GROUP BY CAST(to_date(hourly.time[hour_idx]) AS DATE)
) forecast;
-- @generated-counties-end

-- 18
CREATE OR REPLACE SCHEMASTORE VIEW counties WITH CONTAINER maize AS
SELECT
  county,
  CAST(latitude AS DOUBLE) AS latitude,
  CAST(longitude AS DOUBLE) AS longitude,
  source,
  source_url,
  osm_type,
  CAST(osm_id AS BIGINT) AS osm_id
FROM MAIZE_FILES.counties_raw;

-- 19
CREATE OR REPLACE SCHEMASTORE VIEW storage_loss_rules WITH CONTAINER maize AS
SELECT
  storage,
  CAST(rain_mm_min AS DOUBLE) AS rain_mm_min,
  CAST(humidity_min AS DOUBLE) AS humidity_min,
  CAST(daily_loss_pct AS DOUBLE) AS daily_loss_pct,
  true AS synthetic
FROM MAIZE_FILES.storage_loss_rules_raw;

-- 20
CREATE OR REPLACE SCHEMASTORE VIEW market_news WITH CONTAINER maize AS
SELECT
  item.id AS id,
  CAST(item.as_of AS DATE) AS as_of,
  item.county AS county,
  item.maize_type AS maize_type,
  item.status AS status,
  item.direction AS direction,
  item.headline AS headline,
  item.commodity AS commodity,
  true AS synthetic
FROM MAIZE_FILES.market_news_raw
LATERAL VIEW explode(items) AS item;

-- 21
CREATE OR REPLACE SCHEMASTORE VIEW farmer_ledger WITH CONTAINER maize AS
SELECT
  e.farmer_id AS farmer_id,
  e.county AS county,
  CAST(e.as_of AS DATE) AS as_of,
  e.record_type AS record_type,
  e.verdict AS verdict,
  CAST(e.hold_days AS INT) AS hold_days,
  CAST(e.bags AS INT) AS bags,
  e.storage AS storage,
  CAST(e.forecast_rain_mm_7d AS DOUBLE) AS forecast_rain_mm_7d,
  e.notes AS notes,
  true AS synthetic
FROM MAIZE_FILES.farmer_ledger_raw
LATERAL VIEW explode(entries) AS e;

-- 22
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

-- 23
CREATE OR REPLACE SCHEMASTORE VIEW county_case WITH CONTAINER maize AS
SELECT
  c.county,
  c.latitude,
  c.longitude,
  p.latest_market_date,
  p.quote_count,
  p.min_wholesale_price_kes,
  p.avg_wholesale_price_kes,
  p.max_wholesale_price_kes,
  p.latest_wholesale_price_kes,
  w.forecast_date,
  w.precipitation_sum,
  w.temperature_2m_mean,
  w.humidity_pct,
  w.source AS forecast_source,
  r.storage,
  r.rain_mm_min,
  r.humidity_min,
  r.daily_loss_pct,
  r.synthetic AS rules_synthetic
FROM maize.counties c
LEFT JOIN (
  SELECT
    county,
    market_date AS latest_market_date,
    quote_count,
    min_wholesale_price_kes,
    avg_wholesale_price_kes,
    max_wholesale_price_kes,
    wholesale_price_kes AS latest_wholesale_price_kes
  FROM (
    SELECT
      county,
      market_date,
      wholesale_price_kes,
      COUNT(*) OVER (PARTITION BY county) AS quote_count,
      MIN(wholesale_price_kes) OVER (PARTITION BY county) AS min_wholesale_price_kes,
      AVG(wholesale_price_kes) OVER (PARTITION BY county) AS avg_wholesale_price_kes,
      MAX(wholesale_price_kes) OVER (PARTITION BY county) AS max_wholesale_price_kes,
      ROW_NUMBER() OVER (PARTITION BY county ORDER BY market_date DESC, market_name) AS rn
    FROM maize.kamis_prices
    WHERE lower(commodity) = 'dry maize'
      AND lower(variety) LIKE '%white%'
      AND unit_kg = 90
  ) ranked
  WHERE rn = 1
) p ON p.county = c.county
LEFT JOIN maize.weather_daily w ON w.county = c.county
LEFT JOIN maize.storage_loss_rules r ON true;

-- @seed
-- The setup script loads Postgres from MAIZE_FILES.kamis_prices_raw and
-- checks COUNT(*) and MAX(market_date) before these statements run.

-- 24
CREATE DATASOURCE maize_pg DESCRIBE BY "Maize KAMIS prices" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://maize-db:5432/maize",
  fetchsize "1000",
  username "maize",
  password "MAIZE_PG_PASSWORD"
);

-- 25
REGISTER DATASOURCE TABLE "kamis_prices" FROM maize_pg;

-- 26
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
FROM maize_pg.kamis_prices;
