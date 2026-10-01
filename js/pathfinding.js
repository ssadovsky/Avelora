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
    constructor(terrain, gridSizeX = 160, gridSizeZ = null, worldSizeX = 120, worldSizeZ = null) {
        this.terrain = terrain;
        if (gridSizeZ === null || worldSizeZ === null) {
            // Backward compatibility: constructor(terrain, gridSize, worldSize)
            const g = gridSizeX;
            const w = gridSizeZ || worldSizeX || 120;
            this.gridSizeX = g;
            this.gridSizeZ = g;
            this.worldSizeX = w;
            this.worldSizeZ = w;
        } else {
            this.gridSizeX = gridSizeX;
            this.gridSizeZ = gridSizeZ;
            this.worldSizeX = worldSizeX;
            this.worldSizeZ = worldSizeZ;
        }
        this.gridSize = this.gridSizeX;
        this.worldSize = this.worldSizeX;
        this.cellWidth = this.worldSizeX / this.gridSizeX;
        this.cellHeight = this.worldSizeZ / this.gridSizeZ;
        this.halfWorldX = this.worldSizeX / 2;
        this.halfWorldZ = this.worldSizeZ / 2;

        // 0: Walkable, 1: Blocked (Water or Obstacle)
        this.grid = new Uint8Array(this.gridSizeX * this.gridSizeZ);
        this.obstacles = [];

        this.initGrid();
    }

    worldToGrid(wx, wz) {
        const gx = Math.floor((wx + this.halfWorldX) / this.cellWidth);
        const gz = Math.floor((wz + this.halfWorldZ) / this.cellHeight);
        return {
            x: Math.max(0, Math.min(this.gridSizeX - 1, gx)),
            z: Math.max(0, Math.min(this.gridSizeZ - 1, gz))
        };
    }

    gridToWorld(gx, gz) {
        return {
            x: (gx + 0.5) * this.cellWidth - this.halfWorldX,
            z: (gz + 0.5) * this.cellHeight - this.halfWorldZ
        };
    }

    getIndex(gx, gz) {
        return gz * this.gridSizeX + gx;
    }

    isWalkable(gx, gz) {
        if (gx < 0 || gx >= this.gridSizeX || gz < 0 || gz >= this.gridSizeZ) return false;
        return this.grid[this.getIndex(gx, gz)] === 0;
    }

    isWalkableWorld(wx, wz) {
        const g = this.worldToGrid(wx, wz);
        return this.isWalkable(g.x, g.z);
    }

    findNearestWalkable(gx, gz, maxRadius = 120) {
        if (this.isWalkable(gx, gz)) return { x: gx, z: gz };

        let closest = null;
        let minDist = Infinity;

        for (let r = 1; r <= maxRadius; r++) {
            for (let d = -r; d <= r; d++) {
                const candidates = [
                    { x: gx + d, z: gz - r },
                    { x: gx + d, z: gz + r },
                    { x: gx - r, z: gz + d },
                    { x: gx + r, z: gz + d }
                ];
                for (let i = 0; i < 4; i++) {
                    const c = candidates[i];
                    if (this.isWalkable(c.x, c.z)) {
                        const distSq = (c.x - gx) * (c.x - gx) + (c.z - gz) * (c.z - gz);
                        if (distSq < minDist) {
                            minDist = distSq;
                            closest = { x: c.x, z: c.z };
                        }
                    }
                }
            }
            if (closest) return closest;
        }
        return null;
    }

    findNearestWalkableWorld(wx, wz, maxRadius = 120) {
        const g = this.worldToGrid(wx, wz);
        const safeG = this.findNearestWalkable(g.x, g.z, maxRadius);
        if (safeG) {
            return this.gridToWorld(safeG.x, safeG.z);
        }
        return null;
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
        for (let gz = 0; gz < this.gridSizeZ; gz++) {
            for (let gx = 0; gx < this.gridSizeX; gx++) {
                const wpos = this.gridToWorld(gx, gz);
                const height = this.terrain.getHeightAt(wpos.x, wpos.z);
                const slope = this.terrain.getSlopeAt(wpos.x, wpos.z);

                // Water level is at Y = 0.0; shallow wading allowed down to -0.25m
                const isWater = height < -0.25;
                // Cliffs too steep to walk (slope > 0.18 = angle > ~28 deg, or mountain altitude > 3.6m)
                const isCliff = slope > 0.18 || height > 3.6;

                // Keep a safe non-walkable rim along the map edge (player cannot reach the world edge)
                const edgeMargin = 4.0;
                const isEdge = Math.abs(wpos.x) > this.halfWorldX - edgeMargin || Math.abs(wpos.z) > this.halfWorldZ - edgeMargin;

                // In western pass: portal is at X = -138.0. Player cannot walk past the portal into the back cliff wall
                const isPastPortal = wpos.x < -138.8 && Math.abs(wpos.z - 8.0) < 14.0;

                if (isWater || isCliff || isEdge || isPastPortal) {
                    this.grid[this.getIndex(gx, gz)] = 1;
                } else {
                    this.grid[this.getIndex(gx, gz)] = 0;
                }
            }
        }
        this.blockBridgeRails();
    }

    /** Bridge railings: along the deck only the strip between the rails is walkable. */
    blockBridgeRails() {
        const br = this.terrain.bridges;
        if (!br) return;
        br.forEach(b => {
            const inner = b.width / 2 - 0.3;   // rails stand at width/2 - 0.08
            const reach = b.width / 2 + 0.6 + this.cellWidth;
            const lo = this.worldToGrid(b.x - reach, b.z - b.length / 2);
            const hi = this.worldToGrid(b.x + reach, b.z + b.length / 2);
            for (let gz = lo.z; gz <= hi.z; gz++) {
                for (let gx = lo.x; gx <= hi.x; gx++) {
                    const p = this.gridToWorld(gx, gz);
                    if (Math.abs(p.z - b.z) >= b.length / 2) continue;
                    if (Math.abs(p.x - b.x) > inner) this.grid[this.getIndex(gx, gz)] = 1;
                }
            }
        });
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
        let start = this.worldToGrid(startWorld.x, startWorld.z);
        let target = this.worldToGrid(targetWorld.x, targetWorld.z);
        let startAdjusted = false;
        let safeStartWorld = null;

        // Auto-rescue: If start itself is inside an obstacle / cliff / mountain (e.g. spawned on a high ridge or old save),
        // resolve to closest walkable cell so character can pathfind out towards the valley!
        if (!this.isWalkable(start.x, start.z)) {
            const safeStart = this.findNearestWalkable(start.x, start.z, 120);
            if (safeStart) {
                start = safeStart;
                startAdjusted = true;
                const sw = this.gridToWorld(safeStart.x, safeStart.z);
                safeStartWorld = new THREE.Vector3(sw.x, this.terrain.getHeightAt(sw.x, sw.z), sw.z);
            } else {
                return [];
            }
        }

        // If target itself is inside water/obstacle/cliff, find closest walkable cell
        if (!this.isWalkable(target.x, target.z)) {
            const safeTarget = this.findNearestWalkable(target.x, target.z, 40);
            if (safeTarget) {
                target = safeTarget;
            } else {
                return []; // No reachable point
            }
        }

        // Direct straight line of sight check
        if (!startAdjusted && this.hasLineOfSight(start.x, start.z, target.x, target.z)) {
            const finalW = this.gridToWorld(target.x, target.z);
            return [new THREE.Vector3(finalW.x, this.terrain.getHeightAt(finalW.x, finalW.z), finalW.z)];
        }

        if (startAdjusted && this.hasLineOfSight(start.x, start.z, target.x, target.z)) {
            const finalW = this.gridToWorld(target.x, target.z);
            return [
                safeStartWorld,
                new THREE.Vector3(finalW.x, this.terrain.getHeightAt(finalW.x, finalW.z), finalW.z)
            ];
        }

        // A* Pathfinding
        const startIdx = this.getIndex(start.x, start.z);
        const targetIdx = this.getIndex(target.x, target.z);
        const totalCells = this.gridSizeX * this.gridSizeZ;

        const open = new MinHeap();
        const closed = new Uint8Array(totalCells);
        const cameFrom = new Map();

        const gScore = new Float32Array(totalCells).fill(Infinity);
        const fScore = new Float32Array(totalCells).fill(Infinity);

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
        const MAX_ITER = totalCells; // binary heap: whole grid is affordable

        while (open.size > 0 && iterations++ < MAX_ITER) {
            const current = open.pop();
            if (closed[current]) continue; // stale heap entry
            closed[current] = 1;

            if (current === targetIdx) {
                const path = this.reconstructPath(cameFrom, current);
                if (startAdjusted && safeStartWorld) {
                    path.unshift(safeStartWorld);
                }
                return path;
            }

            const cx = current % this.gridSizeX;
            const cz = Math.floor(current / this.gridSizeX);

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
            const gx = idx % this.gridSizeX;
            const gz = Math.floor(idx / this.gridSizeX);
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
