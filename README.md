[![Token Radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/Schyd/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/Schyd/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar — pre-token protocols ranked by fitted implied value

A radar for the make.fun `token-radar-01` bounty. It reads the frozen DefiLlama
snapshot (758 protocols, as of 2026-11-14), ranks every pre-token protocol it can
defend — the 40 watchlist slugs plus every other pre-token protocol that is not an
exchange, a wrapped, staked or bridged product, or a versioned pool (198 rows) —
and hands the reader a dashboard: a sortable, filterable board, a detail view per
protocol with the model's own arithmetic, a live-token tab at the market's own
values, and a six-step farm plan per row, each step with its cost and time.

## The model — radar-2

The value is a power law **fitted at run time to the snapshot's own clean comps**
(the protocols that already trade, minus exchanges, bridges and staking products):

```
log10(implied) = intercept + slope × log10(TVL)
implied *= (1 + clamped 7d growth × 0.25) × (0.85 + age share × 0.30)
```

On this snapshot the fit is `intercept 3.958, slope 0.394` on 92 clean comps
(R² 0.10 in log space). Five-fold holdout: fitted R² −0.05 vs the house
constant-multiple model −0.25; median error ≈87% vs ≈86%. The fit is weak and
the dashboard says so — token multiples genuinely span 1,000× across comps, so
every row also shows its prediction interval (the fitted value times or divided
by the fit's own residual spread) instead of a false precision. The growth and
maturity weights are stated priors, kept small and bounded, because the comps
show growth and age add almost no signal once TVL is known.

## Run it

Node 22, standard library only, no install:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

That writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/`
and `out/dossier.json`. Open `out/dashboard/index.html` in a browser (served over
HTTP so `data.js` loads) to use the radar.

## Layout

- `main.ts` — entrypoint: reads the snapshot, builds the board, writes the outputs.
- `lib/model.ts` — the model: snapshot parsing, the run-time power-law fit, the
  5-fold holdout, the farm-plan generator, board validation.
- `dashboard/` — the page: `index.html`, `app.css`, `app.js` (no network, no
  framework). The page recomputes each row's implied value from the snapshot
  figures and checks it against `board.json`.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied from the kit.
- `screenshots/` — the board, a detail view, and a filtered view (1280×800).

## License

MIT — see `LICENSE`.
