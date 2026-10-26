#!/usr/bin/env bash
# Start maize-db, copy reference files into the Zetaris driver, register the
# views, then seed Postgres. Credentials come from .env and are not printed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "FAIL .env is missing. Copy .env.example and set MAIZE_PG_PASSWORD."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${MAIZE_PG_PASSWORD:-}" ]]; then
  echo "FAIL MAIZE_PG_PASSWORD is not set"
  exit 1
fi

docker compose -f docker/maize-db.compose.yml up -d

for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' maize-db 2>/dev/null || true)"
  if [[ "$status" == "healthy" ]]; then
    break
  fi
  sleep 2
done
status="$(docker inspect --format '{{.State.Health.Status}}' maize-db)"
if [[ "$status" != "healthy" ]]; then
  echo "FAIL maize-db did not become healthy"
  exit 1
fi
echo "PASS maize-db healthy"

dest="/home/zetaris/customer-data/shared/maize"
docker exec zetaris-driver-1 mkdir -p "$dest"
docker cp data/counties.csv "zetaris-driver-1:${dest}/counties.csv"
docker cp data/sample/kamis_dry_maize.csv "zetaris-driver-1:${dest}/kamis_dry_maize.csv"
docker cp data/sample/news.json "zetaris-driver-1:${dest}/news.json"
docker cp data/sample/storage_loss_rules.csv "zetaris-driver-1:${dest}/storage_loss_rules.csv"
docker cp data/sample/farmer_ledger.json "zetaris-driver-1:${dest}/farmer_ledger.json"
docker cp data/sample/weather.json "zetaris-driver-1:${dest}/weather.json"
echo "PASS reference files copied into zetaris-driver-1"

npm run setup:zetaris
npm run seed:zetaris
npm run setup:zetaris -- --after-seed
echo "PASS zetaris setup"
