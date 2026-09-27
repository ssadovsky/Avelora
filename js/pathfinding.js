/**
 * Diablo-style Grid Pathfinding with A* and String-Pulling Waypoint Smoothing
 */
class MinHeap {
    constructor() { this.items = []; this.prio = []; }
    get size() { return this.items.length; }
    push(item, p) {
        const a = this.items, pr = this.prio;
        a.push(item); pr.push(p);
        let i = a.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (pr[parent] <= pr[i]) break;
            [a[i], a[parent]] = [a[parent], a[i]];
            [pr[i], pr[parent]] = [pr[parent], pr[i]];
            i = parent;
        }
    }
    pop() {
        const a = this.items, pr = this.prio;
        const top = a[0];
        const lastItem = a.pop(), lastP = pr.pop();
        if (a.length > 0) {
            a[0] = lastItem; pr[0] = lastP;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && pr[l] < pr[m]) m = l;
                if (r < a.length && pr[r] < pr[m]) m = r;
                if (m === i) break;
                [a[i], a[m]] = [a[m], a[i]];
                [pr[i], pr[m]] = [pr[m], pr[i]];
                i = m;
            }
        }
        return top;
    }
}

class DiabloPathfinder {
    constructor(terrain, gridSize = 160, worldSize = 120) {
        this.terrain = terrain;
        this.gridSize = gridSize;
        this.worldSize = worldSize;
        this.cellSize = worldSize / gridSize;
        this.halfWorld = worldSize / 2;

        // 0: Walkable, 1: Blocked (Water or Obstacle)
        this.grid = new Uint8Array(gridSize * gridSize);
        this.obstacles = [];

        this.initGrid();
    }

    worldToGrid(wx, wz) {
        const gx = Math.floor((wx + this.halfWorld) / this.cellSize);
        const gz = Math.floor((wz + this.halfWorld) / this.cellSize);
        return {
            x: Math.max(0, Math.min(this.gridSize - 1, gx)),
            z: Math.max(0, Math.min(this.gridSize - 1, gz))
        };
    }

    gridToWorld(gx, gz) {
        return {
            x: (gx + 0.5) * this.cellSize - this.halfWorld,
            z: (gz + 0.5) * this.cellSize - this.halfWorld
        };
    }

    getIndex(gx, gz) {
        return gz * this.gridSize + gx;
    }

    isWalkable(gx, gz) {
        if (gx < 0 || gx >= this.gridSize || gz < 0 || gz >= this.gridSize) return false;
        return this.grid[this.getIndex(gx, gz)] === 0;
    }

    addObstacle(wx, wz, radius) {
        this.obstacles.push({ x: wx, z: wz, r: radius });
        const minG = this.worldToGrid(wx - radius, wz - radius);
        const maxG = this.worldToGrid(wx + radius, wz + radius);

        for (let gz = minG.z; gz <= maxG.z; gz++) {
            for (let gx = minG.x; gx <= maxG.x; gx++) {
                const pos = this.gridToWorld(gx, gz);
                const distSq = (pos.x - wx) * (pos.x - wx) + (pos.z - wz) * (pos.z - wz);
                if (distSq <= radius * radius) {
                    this.grid[this.getIndex(gx, gz)] = 1;
                }
            }
        }
    }

    initGrid() {
        for (let gz = 0; gz < this.gridSize; gz++) {
            for (let gx = 0; gx < this.gridSize; gx++) {
                const wpos = this.gridToWorld(gx, gz);
                const height = this.terrain.getHeightAt(wpos.x, wpos.z);
                const slope = this.terrain.getSlopeAt(wpos.x, wpos.z);

                // Water level is at Y = 0.0; shallow wading allowed down to -0.25m
                const isWater = height < -0.25;
                // Cliffs too steep to walk (slope > 0.85)
                const isCliff = slope > 0.95;

                // Keep a thin walkable-free rim along the map edge
                const edgeMargin = 1.5;
                const isEdge = Math.abs(wpos.x) > this.halfWorld - edgeMargin || Math.abs(wpos.z) > this.halfWorld - edgeMargin;

                if (isWater || isCliff || isEdge) {
                    this.grid[this.getIndex(gx, gz)] = 1;
                } else {
                    this.grid[this.getIndex(gx, gz)] = 0;
                }
            }
        }
    }

    // Line of sight check between two grid cells
    hasLineOfSight(x0, z0, x1, z1) {
        let dx = Math.abs(x1 - x0);
        let dz = Math.abs(z1 - z0);
        let sx = x0 < x1 ? 1 : -1;
        let sz = z0 < z1 ? 1 : -1;
        let err = dx - dz;

        let curX = x0;
        let curZ = z0;

        while (true) {
            if (!this.isWalkable(curX, curZ)) return false;
            if (curX === x1 && curZ === z1) break;

            let e2 = 2 * err;
            if (e2 > -dz) {
                err -= dz;
                curX += sx;
            }
            if (e2 < dx) {
                err += dx;
                curZ += sz;
            }
        }
        return true;
    }

    findPath(startWorld, targetWorld) {
        const start = this.worldToGrid(startWorld.x, startWorld.z);
        let target = this.worldToGrid(targetWorld.x, targetWorld.z);

        // If target itself is inside water/obstacle, find closest walkable cell
        if (!this.isWalkable(target.x, target.z)) {
            let closest = null;
            let minDist = Infinity;
            for (let r = 1; r <= 8; r++) {
                for (let dz = -r; dz <= r; dz++) {
                    for (let dx = -r; dx <= r; dx++) {
                        const nx = target.x + dx;
                        const nz = target.z + dz;
                        if (this.isWalkable(nx, nz)) {
                            const d = dx * dx + dz * dz;
                            if (d < minDist) {
                                minDist = d;
                                closest = { x: nx, z: nz };
                            }
                        }
                    }
                }
                if (closest) break;
            }
            if (closest) {
                target = closest;
            } else {
                return []; // No reachable point
            }
        }

        // Direct straight line of sight check
        if (this.hasLineOfSight(start.x, start.z, target.x, target.z)) {
            const finalW = this.gridToWorld(target.x, target.z);
            return [new THREE.Vector3(finalW.x, this.terrain.getHeightAt(finalW.x, finalW.z), finalW.z)];
        }

        // A* Pathfinding
        const startIdx = this.getIndex(start.x, start.z);
        const targetIdx = this.getIndex(target.x, target.z);

        const open = new MinHeap();
        const closed = new Uint8Array(this.gridSize * this.gridSize);
        const cameFrom = new Map();

        const gScore = new Float32Array(this.gridSize * this.gridSize).fill(Infinity);
        const fScore = new Float32Array(this.gridSize * this.gridSize).fill(Infinity);

        gScore[startIdx] = 0;
        fScore[startIdx] = this.heuristic(start.x, start.z, target.x, target.z);
        open.push(startIdx, fScore[startIdx]);

        const neighbors = [
            { dx: 1, dz: 0, cost: 1.0 },
            { dx: -1, dz: 0, cost: 1.0 },
            { dx: 0, dz: 1, cost: 1.0 },
            { dx: 0, dz: -1, cost: 1.0 },
            { dx: 1, dz: 1, cost: 1.414 },
            { dx: -1, dz: 1, cost: 1.414 },
            { dx: 1, dz: -1, cost: 1.414 },
            { dx: -1, dz: -1, cost: 1.414 }
        ];

        let iterations = 0;
        const MAX_ITER = this.gridSize * this.gridSize; // binary heap: whole grid is affordable

        while (open.size > 0 && iterations++ < MAX_ITER) {
            const current = open.pop();
            if (closed[current]) continue; // stale heap entry
            closed[current] = 1;

            if (current === targetIdx) {
                return this.reconstructPath(cameFrom, current);
            }

            const cx = current % this.gridSize;
            const cz = Math.floor(current / this.gridSize);

            for (const n of neighbors) {
                const nx = cx + n.dx;
                const nz = cz + n.dz;

                if (!this.isWalkable(nx, nz)) continue;
                // Disallow cutting diagonally through solid corner
                if (n.dx !== 0 && n.dz !== 0) {
                    if (!this.isWalkable(cx + n.dx, cz) || !this.isWalkable(cx, cz + n.dz)) {
                        continue;
                    }
                }

                const nIdx = this.getIndex(nx, nz);
                if (closed[nIdx]) continue;
                const tentativeG = gScore[current] + n.cost;

                if (tentativeG < gScore[nIdx]) {
                    cameFrom.set(nIdx, current);
                    gScore[nIdx] = tentativeG;
                    fScore[nIdx] = tentativeG + this.heuristic(nx, nz, target.x, target.z);
                    open.push(nIdx, fScore[nIdx]);
                }
            }
        }

        // Return best effort path if destination couldn't be reached
        return [];
    }

    heuristic(x1, z1, x2, z2) {
        const dx = Math.abs(x1 - x2);
        const dz = Math.abs(z1 - z2);
        return (dx + dz) + (1.414 - 2) * Math.min(dx, dz);
    }

    reconstructPath(cameFrom, current) {
        const gridPath = [];
        let curr = current;
        while (cameFrom.has(curr)) {
            gridPath.push(curr);
            curr = cameFrom.get(curr);
        }
        gridPath.reverse();

        // Convert to world points
        const rawPoints = gridPath.map(idx => {
            const gx = idx % this.gridSize;
            const gz = Math.floor(idx / this.gridSize);
            return this.gridToWorld(gx, gz);
        });

        // String-pulling: Simplify path by skipping intermediate points with direct line of sight
        const smoothed = [];
        if (rawPoints.length <= 2) {
            for (const pt of rawPoints) {
                smoothed.push(new THREE.Vector3(pt.x, this.terrain.getHeightAt(pt.x, pt.z), pt.z));
            }
            return smoothed;
        }

        let anchorIdx = 0;
        const gAnchor = this.worldToGrid(rawPoints[0].x, rawPoints[0].z);
        smoothed.push(new THREE.Vector3(rawPoints[0].x, this.terrain.getHeightAt(rawPoints[0].x, rawPoints[0].z), rawPoints[0].z));

        while (anchorIdx < rawPoints.length - 1) {
            let nextAnchor = anchorIdx + 1;
            const fromGrid = this.worldToGrid(rawPoints[anchorIdx].x, rawPoints[anchorIdx].z);

            for (let i = rawPoints.length - 1; i > anchorIdx + 1; i--) {
                const toGrid = this.worldToGrid(rawPoints[i].x, rawPoints[i].z);
                if (this.hasLineOfSight(fromGrid.x, fromGrid.z, toGrid.x, toGrid.z)) {
                    nextAnchor = i;
                    break;
                }
            }

            anchorIdx = nextAnchor;
            const pt = rawPoints[anchorIdx];
            smoothed.push(new THREE.Vector3(pt.x, this.terrain.getHeightAt(pt.x, pt.z), pt.z));
        }

        return smoothed;
    }
}

window.DiabloPathfinder = DiabloPathfinder;
