// sokoban-solver: a push-optimal Sokoban solver for make.fun's
// sokoban-solver-01-run-20261121 bounty ($100, closes 2026-11-23T03:00Z).
//
// The board is a one-square-wide hallway with one to four rooms off it
// (three or four boxes each, each room opening through a single door, no
// two doors in one column). A box pushed through a door into the hallway
// can never be pushed back, so every box stays in its room and a level's
// push-optimal count P* is the sum of its rooms' optima. The solver
// therefore splits each level into its rooms and solves each room on its
// own, then stitches the rooms' walks together.
//
// Each room is solved with A* over push states (Hart, Nilsson and
// Raphael, 1968). A state is the boxes' squares plus the player's
// reachable region (named by its lowest square); a step costs one push.
// The estimate is the minimum-cost assignment of the boxes to the goals
// under the push-distance table (the fewest pushes a lone box needs to
// reach a goal, other boxes ignored, computed by pulling back from the
// goals). That estimate never overstates the pushes still needed, so
// with reopening the first solved state A* meets is push-optimal.
// Dead squares (no pull-back path to any goal), frozen 2x2 blocks, boxes
// stranded on the hallway row, and boxes with no push left prune states
// no solution can pass through.
//
// Determinism is by construction: no clock is read, nothing is random,
// every tie breaks by square order and insertion order, and all budgets
// are counts of work, so two executions write the same bytes.
//
// Node 22 runs this file as it is (erasable TypeScript only): no
// dependencies, nothing installed, no WebAssembly or native code.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in expanded states, never in seconds: the two
// graded executions must agree byte for byte, so the search is cut off
// by work alone. A room the optimal search cannot finish falls back to
// a weighted search, then to a greedy one; a room none of them finishes
// leaves its level unanswered rather than risking the whole set.
const ASTAR_CAP = 250_000;
const WEIGHTED_CAP = 250_000;
const GREEDY_CAP = 400_000;
const GLOBAL_CAP = 4_000_000;

// The four moves: [dx, dy, the step's letter, the push's letter].
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can be pushed onto some goal:
 * pull back from the goals over open floor. A box on a square outside
 * this set can never reach a goal, whatever the other boxes do.
 */
function liveSquares(w: number, h: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(w * h);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    const xx = x % w;
    const xy = (x / w) | 0;
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d;
      const yx = xx - DX[k];
      const yy = xy - DY[k];
      const bx = yx - DX[k];
      const by = yy - DY[k];
      if (yx < 0 || yx >= w || yy < 0 || yy >= h) continue;
      if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
      // The box at y is pushed to x by a player standing at y - d.
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The fewest pushes one box needs to reach `goal`, other boxes ignored:
 * breadth-first search backwards from the goal over box squares, each
 * step pulling the box one square back where a player could have stood
 * behind it. -1 marks a square the box can never be pushed from.
 */
function pushDistances(w: number, h: number, wall: Uint8Array, goal: number): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const queue = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    const xx = x % w;
    const xy = (x / w) | 0;
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d;
      const yx = xx - DX[k];
      const yy = xy - DY[k];
      const bx = yx - DX[k];
      const by = yy - DY[k];
      if (yx < 0 || yx >= w || yy < 0 || yy >= h) continue;
      if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
      if (!wall[y] && !wall[y - d] && dist[y] < 0) {
        dist[y] = dist[x] + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

/**
 * The cheapest way to pair the boxes with the goals under the
 * push-distance tables, by trying every pairing (at most four boxes,
 * so at most 24 pairings) with branch and bound. Every box still needs
 * at least its table distance to the goal it ends on, and every push
 * moves exactly one box, so this sum never overstates the pushes left:
 * the estimate is admissible. Infinity when no pairing works at all,
 * which prunes a state no solution passes through.
 */
function assignmentCost(boxes: number[], dists: Int32Array[]): number {
  const n = boxes.length;
  let best = Infinity;
  const used = new Uint8Array(n);
  const rec = (i: number, sum: number): void => {
    if (sum >= best) return;
    if (i === n) {
      best = sum;
      return;
    }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const d = dists[j][boxes[i]];
      if (d < 0) continue;
      used[j] = 1;
      rec(i + 1, sum + d);
      used[j] = 0;
    }
  };
  rec(0, 0);
  return best;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes, one of them a box off its goal. Such a
 * block can never be broken open, so the state is dead.
 */
function frozenBlock(
  w: number,
  h: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  const tx = t % w;
  const ty = (t / w) | 0;
  for (let oy = -1; oy <= 0; oy++) {
    for (let ox = -1; ox <= 0; ox++) {
      const ax = tx + ox;
      const ay = ty + oy;
      if (ax < 0 || ay < 0 || ax + 1 >= w || ay + 1 >= h) continue;
      const a = ay * w + ax;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a])) continue;
      if (!(wall[b] || occupied[b])) continue;
      if (!(wall[c] || occupied[c])) continue;
      if (!(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The squares the player reaches from `from` around walls and the
 * boxes in `occupied`, flood-filled into `seen` under `stamp`; returns
 * the region's lowest square, the region's name in a state's key.
 */
function floodRegion(
  w: number,
  h: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const px = p % w;
    const py = (p / w) | 0;
    for (let k = 0; k < 4; k++) {
      const qx = px + DX[k];
      const qy = py + DY[k];
      if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
      const q = qy * w + qx;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds boxes is a room, its squares, boxes and goals. The
 * hallway squares beside a door stay live, so each room's part also
 * holds the square outside its door. Null when the level is no set of
 * rooms (a box starts in the hallway, a goal lies in no part, or some
 * part holds more or fewer boxes than goals).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(w, h, wall, goals);
  const row = (player / w) | 0;
  const cut = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(w * h).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    stack.push(s);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p / w) | 0;
      for (let k = 0; k < 4; k++) {
        const qx = px + DX[k];
        const qy = py + DY[k];
        if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
        const q = qy * w + qx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
          stack.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]]!.boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

interface SearchResult {
  pushes: number;
  moves: string;
}

interface Budget {
  used: number;
  cap: number;
}

/**
 * A state's key: the region's lowest square and the boxes' squares, as
 * digits in base `size` — exact while size ** (boxes + 1) stays under
 * 2 ** 53, which holds for a room of up to four boxes on any board
 * this generator draws. A larger box count (only the whole-level
 * fallback ever has one) keys on a string instead, so no two states
 * can share a key by rounding.
 */
function keyOf(boxes: number[], low: number, size: number): number | string {
  if (boxes.length > 4) return `${low}|${boxes.join(',')}`;
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

type SearchMode = 'astar' | 'weighted' | 'greedy';

/**
 * One room solved by A* over push states (mode 'astar': f = g + h, which
 * with reopening meets a solved state in the fewest pushes; 'weighted':
 * f = g + 2h, a bounded-suboptimal fallback; 'greedy': f = h, a last
 * resort). The player starts at `startPlayer` and may walk the whole
 * sublevel; the other rooms' boxes are already walls in `wall`. Null
 * when the search gives up inside its work cap, or the room is dead.
 */
function solveRoom(
  w: number,
  h: number,
  wall: Uint8Array,
  goals: number[],
  boxes: number[],
  startPlayer: number,
  hallRow: number,
  mode: SearchMode,
  cap: number,
  budget: Budget,
): SearchResult | null {
  const size = w * h;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, h, wall, goals);
  const dists = goals.map((g) => pushDistances(w, h, wall, g));
  if (boxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (solved(boxes)) return { pushes: 0, moves: '' };

  // The states in the order found: their boxes, the player's square
  // after the push that made them, the pushes made, and their parent.
  const sBoxes: number[][] = [boxes.slice()];
  const sPlayer: number[] = [startPlayer];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sPushBox: number[] = [-1];
  const sPushDir: number[] = [-1];
  const best = new Map<number | string, number>();
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  for (const b of boxes) occupied[b] = 1;
  const low0 = floodRegion(w, h, wall, occupied, startPlayer, seen, ++stamp, stack);
  for (const b of boxes) occupied[b] = 0;
  best.set(keyOf(boxes, low0, size), 0);
  const h0 = assignmentCost(boxes, dists);
  if (!Number.isFinite(h0)) return null;

  // The open list: a binary heap on [f, h, sequence, state], so ties go
  // to the deeper state first and then to the state found first.
  const heap: [number, number, number, number][] = [[h0, h0, 0, 0]];
  let seq = 1;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  let expansions = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const bs = sBoxes[s]!;
    const g = sG[s]!;
    for (const b of bs) occupied[b] = 1;
    const here = ++stamp;
    const low = floodRegion(w, h, wall, occupied, sPlayer[s]!, seen, here, stack);
    if (best.get(keyOf(bs, low, size)) !== g) {
      for (const b of bs) occupied[b] = 0;
      continue;
    }
    if (solved(bs)) {
      found = s;
      for (const b of bs) occupied[b] = 0;
      break;
    }
    if (++expansions > cap || ++budget.used > budget.cap) {
      for (const b of bs) occupied[b] = 0;
      return null;
    }
    // A box off its goal with no push left strands the state: nothing
    // past here can solve it. The test is structural only — a target
    // that is a wall or a dead square, or a wall behind the box — never
    // reachability: the player may be shut out from behind a box now
    // and let in again once another box moves (a box in the doorway
    // does exactly that). (A box on a goal may sit still.)
    let stuck = false;
    for (const b of bs) {
      if (goal[b]) continue;
      let canPush = false;
      for (let k = 0; k < 4 && !canPush; k++) {
        const t = b + DY[k] * w + DX[k];
        const behind = b - DY[k] * w - DX[k];
        if (wall[t] || !live[t] || wall[behind]) continue;
        if (((t / w) | 0) === hallRow) continue;
        canPush = true;
      }
      if (!canPush) {
        stuck = true;
        break;
      }
    }
    if (stuck) {
      for (const b of bs) occupied[b] = 0;
      continue;
    }
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const t = b + d;
        const behind = b - d;
        if (wall[t] || occupied[t] || !live[t] || seen[behind] !== here) continue;
        if (((t / w) | 0) === hallRow) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, h, wall, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let hh = Infinity;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          const low2 = floodRegion(w, h, wall, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low2, size);
          hh = assignmentCost(next, dists);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || !Number.isFinite(hh)) continue;
        const g2 = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g2) continue;
        best.set(key, g2);
        const idx = sBoxes.length;
        sBoxes.push(next!);
        sPlayer.push(b);
        sG.push(g2);
        sParent.push(s);
        sPushBox.push(b);
        sPushDir.push(k);
        const f = mode === 'greedy' ? hh : g2 + (mode === 'weighted' ? 2 : 1) * hh;
        heapPush([f, hh, seq++, idx]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The path of pushes, then the moves: walk to each push's square,
  // then push. The walk is a shortest path around walls and boxes.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let cur: number[] = boxes.slice();
  for (const s of path) {
    const box = sPushBox[s]!;
    const k = sPushDir[s]!;
    const d = DY[k] * w + DX[k];
    for (const b of cur) occupied[b] = 1;
    const walk = walkTo(w, h, wall, occupied, player, box - d);
    for (const b of cur) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk + PUSH[k];
    player = box;
    cur = cur.slice();
    cur[cur.indexOf(box)] = box + d;
    cur.sort((x, y) => x - y);
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and the boxes in `occupied`, in lower LURD letters. */
function walkTo(
  w: number,
  h: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const how = new Array<string>(w * h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    const px = p % w;
    const py = (p / w) | 0;
    for (let k = 0; k < 4; k++) {
      const qx = px + DX[k];
      const qy = py + DY[k];
      if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
      const q = qy * w + qx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP[k];
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * One room solved, optimal search first, then its fallbacks: a room
 * the optimal search cannot finish in its work cap still earns most of
 * its points from a near-optimal answer, which beats leaving it blank.
 */
function solveRoomWithFallbacks(
  w: number,
  h: number,
  wall: Uint8Array,
  goals: number[],
  boxes: number[],
  startPlayer: number,
  hallRow: number,
  budget: Budget,
): SearchResult | null {
  return (
    solveRoom(w, h, wall, goals, boxes, startPlayer, hallRow, 'astar', ASTAR_CAP, budget) ??
    solveRoom(w, h, wall, goals, boxes, startPlayer, hallRow, 'weighted', WEIGHTED_CAP, budget) ??
    solveRoom(w, h, wall, goals, boxes, startPlayer, hallRow, 'greedy', GREEDY_CAP, budget)
  );
}

/**
 * A level's moves: each room solved in turn, the other rooms' boxes
 * standing as walls (on their goals once their room is done), the
 * player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's. '' when
 * a room cannot be solved, or the level is no set of rooms and the
 * whole-level search gives up too.
 */
function solveLevel(text: string, budget: Budget): string {
  const level = parseLevel(text);
  const hallRow = (level.player / level.w) | 0;
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solveRoomWithFallbacks(
      level.w,
      level.h,
      level.wall,
      level.goals,
      level.boxes,
      level.player,
      hallRow,
      budget,
    );
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const solved = solveRoomWithFallbacks(
      level.w,
      level.h,
      wall,
      room.goals.slice().sort((a, b) => a - b),
      room.boxes.slice().sort((a, b) => a - b),
      player,
      hallRow,
      budget,
    );
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

/**
 * Every instance of the set in one run: /input/<id>/level.txt in,
 * /output/<id>/solution.txt out. A level that fails to solve still gets
 * an empty answer in the stated format (worth 0, but answered), and a
 * failure on one instance never stops the rest: the output directory is
 * created, never deleted, and only its files are written.
 */
const budget: Budget = { used: 0, cap: GLOBAL_CAP };
for (const id of readdirSync(INPUT).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'), budget);
  } catch {
    moves = '';
  }
  try {
    mkdirSync(join(OUTPUT, id), { recursive: true });
    writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
  } catch {
    // The instance stays unanswered rather than failing the set.
  }
}
