# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/hungndp/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/hungndp/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's [Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty ($100 in USDC, closes 2026-11-23T03:00Z). `main.ts` answers a whole 5-instance set in one run, in well under the 60-second wall budget.

## How it works

Each level is a one-square-wide hallway with one to four rooms off it (three or four boxes each, one door per room). A box pushed through a door into the hallway can never be pushed back, so every box stays in its room and a level's push-optimal count P\* is the sum of its rooms' optima. The solver therefore splits each level into its rooms (cutting the hallway's dead squares out of the floor) and solves each room on its own, then stitches the rooms' walks together.

Each room is solved with A\* over push states: a state is the boxes' squares plus the player's reachable region, a step costs one push, and the estimate is the minimum-cost assignment of the boxes to the goals under a push-distance table (the fewest pushes a lone box needs to reach a goal, other boxes ignored, computed by pulling back from the goals). That estimate never overstates the pushes still needed, so with reopening the first solved state A\* meets is push-optimal. Dead squares, frozen 2×2 blocks, boxes stranded on the hallway row, and structurally stuck boxes prune states no solution passes through. A room the optimal search cannot finish in its work cap falls back to weighted A\* (f = g + 2h), then to a greedy search — a near-optimal answer still earns most of the room's points.

Determinism is by construction: no clock is read, nothing is random, every tie breaks by square order and insertion order, and all budgets are counts of work — two executions write the same bytes.

## Run it

```sh
node main.ts
```

`main.ts` reads every instance from `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`), creating each output directory itself and never deleting it. It needs nothing installed: Node 22 runs it as it is, with only Node's built-in modules.

## Verification

- Practice set (the kit's own scorer): **score 1,000,000, passed 5/5** — every instance solved in exactly P\* pushes: i001 13, i002 16, i003 29, i004 47, i005 60.
- The house baseline plain-astar 1.0.0 scores **200,000** on the same practice set (only i001 solved; i002–i005 left blank). This entry beats it by 800,000.
- Ten freshly drawn sets from the kit's own generator (new seeds): **1,000,000 on all ten**, every instance at P\*, whole-set runtimes 222–370 ms against the 60,000 ms budget.
- `grade-local` (kit CLI, process driver): score 1,000,000, L1 regrade reproduced byte for byte.
- Determinism: two runs write byte-identical outputs; a uid-65534 repro (read-only repo copy, non-writable output parent) exits 0 with identical output.

## License

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=ebjdb2tv&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
