# Data

## Source

`sample/kamis_dry_maize.csv` is a small labelled subset of the live KAMIS dry-maize export (`product=1`) pulled on 26 October 2026 from `https://kamis.kilimo.go.ke/site/market`. The label is `sample/kamis_dry_maize.subset.txt`. The full export had 32,929 rows from 2005-02-01 through 2026-10-26. The largest `per_page` that pull accepted was 12,000. Raw workbooks stay in `data/cache/` and are not committed.

`sample/records_sample.json` (0 records) and `sample/metadata.csv` (header only) were already here and are unused by the agents.

## Licence or usage note

KAMIS terms of use are unconfirmed. This subset is for the hackathon demo only. Do not assume a redistribution licence.

Weather, storage-loss rules, news, and the farmer ledger are synthetic. Each of those files is marked `synthetic: true` (or `synthetic=true` on every CSV row). They are not KMD forecasts, gazette notices, or real farm records.

## Subset

`kamis_dry_maize.csv` columns: `market_date`, `county`, `market_name`, `commodity`, `variety`, `grade`, `unit_kg`, `wholesale_price_kes`, `retail_price_kes`, `volume_bags`.

Every row is white dry maize in a 90 kg bag, with a wholesale price and a retail price. Test rows are not included. These 27 quotes are real rows from the pull, not a filled-in series.

| County | Rows | Newest date |
| --- | ---: | --- |
| Kirinyaga (Ngurubani, Makutano, Kagio) | 9 | 2026-10-26 |
| Nairobi (Kawangware) | 3 | 2026-10-23 |
| Uasin Gishu (Eldoret Main, Cheptiret) | 3 | 2026-10-26 |
| Nyandarua (Engineer, Soko mpya) | 3 | 2024-08-14 |
| Nakuru (Naivasha) | 3 | 2023-12-01 |
| Machakos | 3 | 2022-12-16 |
| Garissa (Soko Mugdi) | 3 | 2023-08-31 |
| **Total** | **27** | |

The planted 9,999 KES quote is not in this file. It lives in `fixtures/dirty_market.json` and is selected only when a request sets `"fixture": "dirty"`.

## Other sample files

| File | Rows | Role |
| --- | ---: | --- |
| `weather.json` | 2 county series (7 Kirinyaga days, 1 Garissa day) | Synthetic forecast. Garissa is stale (1 Aug 2026) and includes a 400 mm day. |
| `storage_loss_rules.csv` | 8 | Synthetic daily loss by storage and weather. |
| `news.json` | 7 | Synthetic items tagged by maize type and `announced` or `gazetted`. |
| `farmer_ledger.json` | 4 | Synthetic stock, one sale, and a prior HOLD for `farmer-kirinyaga-003`. |

## How to regenerate

`npm run backfill:kamis` reads the live export, caches raw workbooks under `data/cache/`, and upserts parsed rows into Postgres. It does not write `data/sample/` or `data/fixtures/`. This CSV is a labelled subset taken from that pull. Weather, rules, news, and the ledger in this folder are hand-authored synthetic inputs.

`counties.csv` holds administrative centroids for the counties in the price sample. Each row is an OpenStreetMap Nominatim relation (`source` and `source_url`). The coordinates are © OpenStreetMap contributors, available under the Open Database Licence (ODbL). Do not replace a row with a town geocoder hit.

`fixtures/dirty_market.json` is a planted critic case: a 9,999 KES white-maize quote and a yellow-maize news item. It is not a KAMIS extract and not a gazette notice. Refresh and the sample-load script refuse to write into `data/fixtures/` or `data/sample/`.

`npx tsx scripts/refresh_kamis.ts` downloads the KAMIS market export and upserts the parsed rows into Postgres (`MAIZE_PG_HOST`:`MAIZE_PG_PORT`, default `127.0.0.1:5433`), which `maize.kamis_prices` reads. The forecast is the live `maize.weather_daily` view, one Open-Meteo REST table per county. Requests wait 2 seconds, and raw KAMIS bodies go to `data/cache/` (gitignored). KAMIS terms are unconfirmed. Open-Meteo data is CC BY 4.0 (Weather data by Open-Meteo.com). Nominatim coordinates are ODbL 1.0.

## Limitations

- The committed file is 27 quotes, not the 32,929-row export, and it is not a national price index.
- Wholesale KES per 90 kg bag is the series the tools use. Retail and volume are carried but not modelled.
- Nakuru, Machakos, Nyandarua, and Garissa have no quote in this subset after 2024. A last-14-day coverage check marks those counties limited.
- Synthetic weather and loss rules drive the hold-versus-sell comparison. They are not measured on-farm losses.
