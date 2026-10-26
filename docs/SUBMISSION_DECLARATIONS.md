## Pre-existing components and third-party material

The build window starts 22 October 2026 00:00 UTC.

`git log --reverse --format="%h %ad %s" --date=iso | head -5` shows:

```text
546140c 2026-10-22 14:56:04 +0300 Add H-MEM spec and reference
6dd879e 2026-10-22 15:44:53 +0300 Add sample data layout and example input/output folders.
c22eaa2 2026-10-22 18:43:08 +0300 Project Structure Setup
f7659cc 2026-10-22 19:30:37 +0300 Implement H-MEM backed MemoryPort in memory.ts, replacing the in-process memory store. Update memory recall and remember methods to utilize H-MEM for storing farmer profiles, verdicts, and offer gaps. Adjust README and other files to reflect changes in memory handling and data persistence under data/hmem. Update watcher and planner agents to accommodate new memory structure.
323497b 2026-10-22 19:34:31 +0300 Enhance planner logic to include liquidity penalty descriptions and improve summary outputs. Update price range handling and refine evidence reporting. Add new utility functions for deduplication and no recommendation summaries. Extend tests to validate cash need penalties and ensure correct behavior with missing directories in H-MEM. Update .dockerignore to exclude new data directory.
```

No application code was committed before the window. The first commit is 2026-10-22 14:56:04 +0300, which is 11:56:04 UTC, inside the window.

Pre-existing before the build window:

- `data/sample/kamis_dry_maize.csv` is a 27-row labelled subset of the KAMIS dry-maize export pulled on 26 October 2026. The full raw export is not in the tree. An earlier 50-row file was committed during the window in `6dd879e` and has been replaced.
- Planning notes and the "Shamba Council" README draft: not present in this repository. [FILL IN: path or link if they were kept outside the repo.]
- The mobile UI in `ui/` was first committed during the window, `c41e8ab` on 2026-10-24 18:51:33 +0300. Nothing in git shows a UI before the window.

Third-party and open source:

- Meterless H-MEM spec and reference in `memory/hmem/`, Apache-2.0, https://github.com/Meterless/Meterless
- Zetaris platform. Getting-started recipes: [FILL IN: title and URL of the recipe pack]. Local setup for this project is `scripts/zetaris_maize_setup.sql`.
- Open-Meteo, CC BY 4.0, https://open-meteo.com/
- OpenStreetMap contributors, ODbL, for `data/counties.csv`
- KAMIS prices, Ministry of Agriculture, https://kamis.kilimo.go.ke/site/market. Terms of use are unconfirmed.
- npm dependencies in `package.json`: fastify, zod; devDependencies @types/node, tsx, typescript, vitest.
- npm dependencies in `ui/package.json`: clsx, lucide-react, react, react-dom, recharts, tailwind-merge; devDependencies @types/react, @types/react-dom, @vitejs/plugin-react, autoprefixer, postcss, tailwindcss, typescript, vite.

Synthetic, and labelled synthetic in the files:

- Farmer profiles and ledger: `data/sample/farmer_ledger.json`
- News items: `data/sample/news.json`
- Storage-loss rules: `data/sample/storage_loss_rules.csv`
- Forecast series: `data/sample/weather.json`
- Planted critic cases: `data/fixtures/dirty_market.json`
