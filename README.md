[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/grandkent900/makefun-sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/grandkent900/makefun-sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# makefun-sokoban-solver

A push-optimal Sokoban solver for make.fun's ["Build the best Sokoban solver, 21 November 2026"](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty ($100 in USDC, 10 places × $10).

One program, `main.ts`, answers a whole set of 5 instances in a single run
(`node main.ts`, Node 22; reads `MAKEFUN_INPUT_DIR`, writes
`MAKEFUN_OUTPUT_DIR`, or `/input` and `/output` by default). It writes each
instance's player moves to `<id>/solution.txt` (u/d/l/r, an upper letter
marks a push).

## How it works

Generated levels decompose into independent rooms: a one-square-wide
hallway (the player's row) with one to four rooms off it, each holding 3–4
boxes and as many goals, and a box pushed through a door into the hallway
can never come back, so every box stays in its room. The level's
push-optimal count P\* is the sum of its rooms' optima, so the solver solves
each room on its own, push-optimally, and stitches the rooms together with
plain walks along the hallway.

Each room is solved by A\* over pushes (not moves):

- a state is the boxes' squares plus the player's reachable region (named by
  its lowest square); every push costs 1;
- the estimate is the Hungarian minimum assignment of boxes to goals under
  shortest-path box distances — admissible and consistent, so the first
  solved state popped is push-optimal;
- deadlocks are pruned soundly: dead squares (a box that can never reach a
  goal, by pull-back from the goals) and frozen 2×2 blocks of walls and
  boxes;
- a greedy best-first fallback (same machinery, estimate only) covers any
  room where A\* exhausts its work budget, so a hard room still gets solved
  instead of scoring 0.

Determinism: the program reads no clock and no randomness. Every search is
cut off by work (expansions), never by time — 300,000 A\* expansions per
room, 150,000 greedy expansions per room, 2,500,000 for the whole run — so
two executions on the same set write the same bytes. A level no search
solves still gets a (valid, empty) `solution.txt`, so one hard level never
takes the other four down with it.

## Local validation

- Practice set (kit): **1,000,000 / 1,000,000** — all 5 instances solved in
  exactly P\* pushes (13, 16, 29, 47, 60), ~0.3 s for the whole set.
  The house baseline (plain-astar 1.0.0) scores 200,000 on the same set
  (solves only i001).
- 30 freshly drawn sets from the kit's own generator (150 instances):
  **1,000,000 on every set**, every instance at P\* pushes; worst room
  search 2,023 expansions (cap 300,000), slowest set 0.53 s (limit 60 s).
- Two runs on the same input are byte-identical; `grade-local --driver
  process` reproduces the practice score and reports `eligible: ranked
  yes, prize yes`.

## Layout

- `main.ts` — the whole solver (the entrypoint the grader runs)
- `LICENSE` — MIT
- `.makefun/owner.json` — the payout wallet for this entry
