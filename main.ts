// makefun-sokoban-solver — a push-optimal Sokoban solver for make.fun's
// "Build the best Sokoban solver, 21 November 2026" bounty.
//
// Strategy
// --------
// Generated levels decompose into independent rooms: a one-square-wide
// hallway (the player's row) with one to four rooms off it, each holding
// 3-4 boxes and as many goals, and a box pushed through a door into the
// hallway can never come back, so every box stays in its room. The level's
// push-optimal count P* is the sum of its rooms' optima, so the solver
// solves each room on its own, push-optimally, and stitches the rooms
// together with plain walks along the hallway.
//
// Each room is solved by A* over pushes (not moves): a state is the boxes'
// squares plus the player's reachable region (named by its lowest square),
// every push costs 1, and the estimate is the Hungarian minimum assignment
// of boxes to goals under shortest-path box distances — admissible and
// consistent, so the first solved state popped is push-optimal. Deadlocks
// are pruned soundly: dead squares (a box that can never reach a goal, by
// pull-back from the goals) and frozen 2x2 blocks of walls and boxes.
// A greedy best-first fallback (same machinery, estimate only) covers any
// room where A* exhausts its work budget, so a hard room still gets solved
// instead of scoring 0.
//
// Determinism: the program reads no clock and no randomness. Every search
// is cut off by work (expansions), never by time, ties break in fixed
// order, and two runs on the same input write the same bytes.
//
// Limits (work, not clock): 300,000 A* expansions per room, 150,000 greedy
// expansions per room, 2,500,000 expansions for the whole run. A level no
// search solves still gets a (valid, empty) solution.txt, so one hard level
// never takes the other four down with it.
//
// Run: node main.ts (Node 22.18+ strips the types natively), with
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR, or /input and /output by default.
// One run answers the whole set of 5 instances.
//
// MIT License, Copyright (c) 2026 make.fun (LICENSE beside this file).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets: expansions, never seconds, so runs are reproducible. */
const ASTAR_EXPANSIONS = 300_000;
const GREEDY_EXPANSIONS = 150_000;
const RUN_EXPANSIONS = 2_500_000;
let runExpansions = 0;

/** The four directions: [dx, dy, step letter, push letter]. */
const DIRS: readonly (readonly [number, number, string, string])[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
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
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can be pushed onto some goal,
 * by pulling back from the goals over open floor. A box off a goal on a
 * square that is not live is a deadlock: no push sequence saves it.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` with `occupied` boxes in the way; also the lowest such square. */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room, its squares, boxes and goals. Null when
 * some part holds more or fewer boxes than goals, or a box starts in the
 * hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Shortest box-move distances from every goal over open floor (walls block; other boxes ignored: a lower bound). */
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  return goals.map((g) => {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

/**
 * Minimum-assignment estimate: the cheapest way to match every box to a
 * distinct goal under box-move distances. Admissible (every box must travel
 * at least its distance to the goal it ends on) and consistent (one push
 * moves one box one square, so the estimate moves by at most 1). Infinity
 * when some box reaches no goal at all. Small rooms (n <= 6) are matched by
 * enumerating permutations; larger ones fall back to the sum of row minima,
 * also admissible.
 */
function estimate(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > dist.length) return Infinity; // more boxes than goals: no matching exists
  if (n <= 6) {
    const perm = boxes.map((_, i) => i);
    let best = Infinity;
    const walk = (k: number, cost: number): void => {
      if (cost >= best) return;
      if (k === n) {
        best = cost;
        return;
      }
      for (let j = k; j < n; j++) {
        [perm[k], perm[j]] = [perm[j]!, perm[k]!];
        const d = dist[perm[k]!]![boxes[k]!]!;
        if (d >= 0) walk(k + 1, cost + d);
        [perm[k], perm[j]] = [perm[j]!, perm[k]!];
      }
    };
    walk(0, 0);
    return best;
  }
  let sum = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (const dg of dist) if (dg[b]! >= 0 && dg[b]! < m) m = dg[b]!;
    if (m === Infinity) return Infinity;
    sum += m;
  }
  return sum;
}

/** A state's key: the region's lowest square and the boxes' squares, base `size` (exact while size ** (n + 1) < 2 ** 53). */
function keyOf(boxes: number[], low: number, size: number): number | string {
  if (boxes.length <= 5 && size <= 256) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return `${low}:${boxes.join(',')}`;
}

/**
 * Push-optimal (A*) or greedy best-first solution of `level` (one room, or
 * the whole level as a fallback), searching at most `maxExpansions` states:
 * {pushes, moves} (moves in LURD: a lower letter a step, an upper one a
 * push), or null when the search gives up or the level has no solution.
 * `exitCells`, when given, additionally requires the solved state's player
 * region to hold an exit cell (so the player can leave the room afterwards).
 */
function searchPushes(
  level: Level,
  maxExpansions: number,
  greedy: boolean,
  exitCells: number[] | null,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const canExit = (player: number, boxes: number[]): boolean => {
    if (exitCells === null) return true;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, player, seen, ++stamp, stack);
    const here = stamp;
    for (const b of boxes) occupied[b] = 0;
    return exitCells.some((e) => seen[e] === here);
  };
  if (level.boxes.some((b) => !live[b])) return null;
  if (estimate(level.boxes, dist) === Infinity) return null;

  // The states in order found: boxes, player square, pushes so far, parent, the push that made them.
  const sBoxes: number[][] = [level.boxes];
  const sPlayer: number[] = [level.player];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const best = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  best.set(keyOf(level.boxes, startLow, size), 0);

  // Open list: a binary heap on (f, h, id); f = g + h for A*, h for greedy. Ties break by id: deterministic.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[3] < b[3])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
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
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  const h0 = estimate(level.boxes, dist);
  heapPush([h0, h0, 0, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, , g, s] = heapPop();
    // A stale heap entry (a better path to this state was found since): skip.
    if (g !== sG[s]) continue;
    const boxes = sBoxes[s]!;
    if (solved(boxes) && canExit(sPlayer[s]!, boxes)) {
      found = s;
      break;
    }
    if (expanded >= maxExpansions || runExpansions >= RUN_EXPANSIONS) return null;
    expanded++;
    runExpansions++;
    const player = sPlayer[s]!;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, player, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack), size);
          h = estimate(next, dist);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const prev = best.get(key);
        if (prev !== undefined && sG[prev]! <= g + 1) continue;
        if (prev === undefined) {
          const id = sBoxes.length;
          sBoxes.push(next!);
          sPlayer.push(b);
          sG.push(g + 1);
          sParent.push(s);
          sFrom.push(b);
          sTo.push(t);
          best.set(key, id);
          heapPush([greedy ? h : g + 1 + h, h, g + 1, id]);
        } else {
          // A better path to a known state: reopen it (consistent h makes this rare).
          sG[prev] = g + 1;
          sParent[prev] = s;
          sFrom[prev] = b;
          sTo[prev] = t;
          sPlayer[prev] = b;
          heapPush([greedy ? h : g + 1 + h, h, g + 1, prev]);
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    const nb = boxes.slice();
    nb[nb.indexOf(from)] = to;
    nb.sort((a, b) => a - b);
    boxes = nb;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
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

/** Whether the player at `player` can walk to any of `exits` with `boxes` as obstacles. */
function canReachExit(level: Level, player: number, boxes: number[], exits: number[]): boolean {
  const occupied = new Uint8Array(level.wall.length);
  for (const b of boxes) occupied[b] = 1;
  const seen = new Int32Array(level.wall.length);
  const stack = new Int32Array(level.wall.length);
  reach(level, occupied, player, seen, 1, stack);
  return exits.some((e) => seen[e] === 1);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 * {pushes, moves}, or null when a room's search gives up, or the level is
 * no set of rooms and the search over the whole level gives up.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = searchPushes(level, ASTAR_EXPANSIONS, false, null)
      ?? searchPushes(level, GREEDY_EXPANSIONS, true, null);
    return whole;
  }
  const hallRow = Math.floor(level.player / level.w);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const done: boolean[] = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    // The room's exit cells: its squares beside a hallway floor square.
    const exits = room.squares.filter((s) => {
      const q = s < hallRow * level.w ? s + level.w : s - level.w;
      return Math.floor(q / level.w) === hallRow && !level.wall[q];
    });
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      for (const b of done[oj] ? rooms[oj]!.goals : rooms[oj]!.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const needExit = ri < rooms.length - 1;
    let solved = searchPushes(sub, ASTAR_EXPANSIONS, false, needExit ? exits : null)
      ?? searchPushes(sub, GREEDY_EXPANSIONS, true, needExit ? exits : null);
    // Safety net: if the player cannot leave the room after the solution
    // (the generator promises this never happens), re-solve requiring an exit.
    if (solved !== null && needExit) {
      const end = endOf(level.w, player, solved.moves);
      if (!canReachExit(level, end, room.goals, exits)) {
        solved = searchPushes(sub, ASTAR_EXPANSIONS, false, exits)
          ?? searchPushes(sub, GREEDY_EXPANSIONS, true, exits);
      }
    }
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done[ri] = true;
  }
  return { pushes, moves };
}

/** Solve one level's text; '' when no search solves it (a valid, scoreless answer). */
function solve(text: string): string {
  try {
    const level = parseLevel(text);
    if (level.boxes.every((b) => level.goals.includes(b))) return '';
    const solved = solveByRooms(level);
    return solved === null ? '' : solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
