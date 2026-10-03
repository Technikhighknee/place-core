import {
  assertVec2,
  boundsIntersect,
  geometryBounds,
  pointInBounds,
  pointInGeometry
} from "./primitives.js";

const MAX_INDEX_CELLS_PER_ITEM = 4096;

function cellRangeForBounds(bounds, cellSize) {
  return {
    minX: Math.floor(bounds.minX / cellSize),
    minY: Math.floor(bounds.minY / cellSize),
    maxX: Math.floor(bounds.maxX / cellSize),
    maxY: Math.floor(bounds.maxY / cellSize)
  };
}

function rangeCellCount(range) {
  const values = [
    range.minX,
    range.minY,
    range.maxX,
    range.maxY
  ];
  if (!values.every(Number.isSafeInteger)) {
    return Infinity;
  }

  const width = range.maxX - range.minX + 1;
  const height = range.maxY - range.minY + 1;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > MAX_INDEX_CELLS_PER_ITEM ||
    height > MAX_INDEX_CELLS_PER_ITEM
  ) {
    return Infinity;
  }

  const count = width * height;
  return Number.isSafeInteger(count)
    ? count
    : Infinity;
}

function assertFiniteBounds(bounds, label = "bounds") {
  if (!bounds ||
      typeof bounds !== "object" ||
      !Number.isFinite(bounds.minX) ||
      !Number.isFinite(bounds.minY) ||
      !Number.isFinite(bounds.maxX) ||
      !Number.isFinite(bounds.maxY)) {
    throw new TypeError(`${label} must contain finite bounds`);
  }
  if (bounds.maxX < bounds.minX ||
      bounds.maxY < bounds.minY) {
    throw new RangeError(`${label} must contain ordered bounds`);
  }
  return bounds;
}

function assertFiniteIndexPoint(point) {
  try {
    assertVec2(point, "point");
  } catch (error) {
    throw new TypeError(
      "point must be a finite Vec2",
      { cause: error }
    );
  }
  return point;
}

export class StaticGeometryIndex {
  #cellSize;
  #cells = new Map();
  #largeItems = [];
  #items;
  #geometryOf;

  constructor(items, { cellSize = 8, geometryOf = (item) => item.geometry } = {}) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError("cellSize must be > 0");
    if (typeof geometryOf !== "function") {
      throw new TypeError("geometryOf must be a function");
    }
    this.#cellSize = cellSize;
    this.#geometryOf = geometryOf;
    this.#items = Object.freeze([...items]);
    for (let index = 0; index < this.#items.length; index += 1) {
      const bounds = geometryBounds(
        this.#geometryOf(this.#items[index])
      );
      const range = cellRangeForBounds(
        bounds,
        this.#cellSize
      );

      if (
        rangeCellCount(range) >
        MAX_INDEX_CELLS_PER_ITEM
      ) {
        this.#largeItems.push(index);
        continue;
      }

      for (const key of this.#keysForRange(range)) {
        let bucket = this.#cells.get(key);
        if (!bucket) {
          this.#cells.set(key, bucket = []);
        }
        bucket.push(index);
      }
    }
    for (const bucket of this.#cells.values()) Object.freeze(bucket);
  }

  queryPoint(point, predicate = null) {
    assertVec2(point);
    const bucket =
      this.#cells.get(
        this.#key(point.x, point.y)
      ) ?? [];
    const result = [];

    const visit = (index) => {
      const item = this.#items[index];
      if (
        (!predicate || predicate(item)) &&
        pointInGeometry(
          point,
          this.#geometryOf(item)
        )
      ) {
        result.push(item);
      }
    };

    for (const index of bucket) visit(index);
    for (const index of this.#largeItems) {
      visit(index);
    }
    return result;
  }

  get cellCount() {
    return this.#cells.size;
  }

  get largeItemCount() {
    return this.#largeItems.length;
  }

  #key(x, y) {
    return `${Math.floor(x / this.#cellSize)},${Math.floor(y / this.#cellSize)}`;
  }

  *#keysForRange(range) {
    for (
      let y = range.minY;
      y <= range.maxY;
      y += 1
    ) {
      for (
        let x = range.minX;
        x <= range.maxX;
        x += 1
      ) {
        yield `${x},${y}`;
      }
    }
  }
}

export class DynamicAabbIndex {
  #cellSize;
  #cells = new Map();
  #bounds = new Map();
  #memberships = new Map();
  #largeIds = new Set();

  constructor(cellSize = 64) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError("cellSize must be > 0");
    this.#cellSize = cellSize;
  }

  set(id, bounds) {
    assertFiniteBounds(
      bounds,
      "DynamicAabbIndex bounds"
    );
    const range = cellRangeForBounds(
      bounds,
      this.#cellSize
    );
    const useLargeFallback =
      rangeCellCount(range) >
      MAX_INDEX_CELLS_PER_ITEM;
    const keys = useLargeFallback
      ? null
      : [...this.#keysForRange(range)];

    this.delete(id);
    this.#bounds.set(id, { ...bounds });
    this.#memberships.set(id, keys);

    if (useLargeFallback) {
      this.#largeIds.add(id);
      return;
    }

    for (const key of keys) {
      let bucket = this.#cells.get(key);
      if (!bucket) {
        this.#cells.set(
          key,
          bucket = new Set()
        );
      }
      bucket.add(id);
    }
  }

  delete(id) {
    if (!this.#bounds.has(id)) return false;
    const keys = this.#memberships.get(id);
    if (keys) {
      for (const key of keys) {
        const bucket = this.#cells.get(key);
        if (!bucket) continue;
        bucket.delete(id);
        if (bucket.size === 0) {
          this.#cells.delete(key);
        }
      }
    } else {
      this.#largeIds.delete(id);
    }

    this.#memberships.delete(id);
    this.#bounds.delete(id);
    return true;
  }

  queryPoint(point) {
    assertFiniteIndexPoint(point);
    const bucket =
      this.#cells.get(
        this.#key(point.x, point.y)
      ) ?? [];
    const result = [];

    const visit = (id) => {
      const bounds = this.#bounds.get(id);
      if (
        bounds &&
        pointInBounds(point, bounds)
      ) {
        result.push(id);
      }
    };

    for (const id of bucket) visit(id);
    for (const id of this.#largeIds) {
      visit(id);
    }
    return result;
  }

  queryBounds(bounds) {
    assertFiniteBounds(bounds, "DynamicAabbIndex query bounds");
    const minX = Math.floor(bounds.minX / this.#cellSize);
    const minY = Math.floor(bounds.minY / this.#cellSize);
    const maxX = Math.floor(bounds.maxX / this.#cellSize);
    const maxY = Math.floor(bounds.maxY / this.#cellSize);
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const queryCellCount = width * height;
    const candidates =
      new Set(this.#largeIds);

    // Never let a sparse query spend time proportional to empty world area.
    // Small windows probe their cells directly; huge windows scan the
    // occupied-cell map instead.
    if (Number.isSafeInteger(queryCellCount) &&
        queryCellCount <= this.#cells.size) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const bucket = this.#cells.get(`${x},${y}`);
          if (!bucket) continue;
          for (const id of bucket) candidates.add(id);
        }
      }
    } else {
      for (const [key, bucket] of this.#cells) {
        const comma = key.indexOf(",");
        const x = Number(key.slice(0, comma));
        const y = Number(key.slice(comma + 1));
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        for (const id of bucket) candidates.add(id);
      }
    }

    const result = [];
    for (const id of candidates) {
      const itemBounds = this.#bounds.get(id);
      if (itemBounds && boundsIntersect(itemBounds, bounds)) result.push(id);
    }
    return result;
  }

  getBounds(id) {
    const bounds = this.#bounds.get(id);
    return bounds ? { ...bounds } : null;
  }

  get size() { return this.#bounds.size; }
  get cellSize() { return this.#cellSize; }
  get cellCount() { return this.#cells.size; }
  get largeItemCount() {
    return this.#largeIds.size;
  }

  #key(x, y) {
    return `${Math.floor(x / this.#cellSize)},${Math.floor(y / this.#cellSize)}`;
  }

  *#keysForRange(range) {
    for (
      let y = range.minY;
      y <= range.maxY;
      y += 1
    ) {
      for (
        let x = range.minX;
        x <= range.maxX;
        x += 1
      ) {
        yield `${x},${y}`;
      }
    }
  }
}


function lowerBoundNumber(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function axisDistanceToCell(value, coordinate, cellSize) {
  const min = coordinate * cellSize;
  const max = min + cellSize;
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

function *coordinatesByDistance(values, value, cellSize) {
  if (values.length === 0) return;

  const cell = Math.floor(value / cellSize);
  let right = lowerBoundNumber(values, cell);
  let left = right - 1;

  while (left >= 0 || right < values.length) {
    if (left < 0) {
      yield {
        coordinate: values[right],
        distance: axisDistanceToCell(
          value,
          values[right],
          cellSize
        )
      };
      right += 1;
      continue;
    }

    if (right >= values.length) {
      yield {
        coordinate: values[left],
        distance: axisDistanceToCell(
          value,
          values[left],
          cellSize
        )
      };
      left -= 1;
      continue;
    }

    const leftDistance =
      axisDistanceToCell(
        value,
        values[left],
        cellSize
      );
    const rightDistance =
      axisDistanceToCell(
        value,
        values[right],
        cellSize
      );

    if (leftDistance <= rightDistance) {
      yield {
        coordinate: values[left],
        distance: leftDistance
      };
      left -= 1;
    } else {
      yield {
        coordinate: values[right],
        distance: rightDistance
      };
      right += 1;
    }
  }
}

/**
 * Dynamic sparse point index.
 *
 * Nearest/radius queries iterate occupied rows/cells only; their runtime is
 * independent of the amount of empty coordinate space between points.
 */
export class DynamicPointIndex {
  #cellSize;
  #points = new Map();
  #rows = new Map();
  #sortedRows = null;
  #sortedColumns = new Map();
  #fallbackIds = new Set();
  #cellCount = 0;

  constructor(cellSize = 64) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError("cellSize must be > 0");
    }
    this.#cellSize = cellSize;
  }

  set(id, point) {
    assertVec2(point);
    this.delete(id);

    const x = Math.floor(point.x / this.#cellSize);
    const y = Math.floor(point.y / this.#cellSize);

    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y)
    ) {
      this.#fallbackIds.add(id);
      this.#points.set(id, {
        x: point.x,
        y: point.y,
        cellX: null,
        cellY: null
      });
      return this;
    }

    let row = this.#rows.get(y);
    if (!row) {
      row = new Map();
      this.#rows.set(y, row);
      this.#sortedRows = null;
    }

    let bucket = row.get(x);
    if (!bucket) {
      bucket = new Set();
      row.set(x, bucket);
      this.#sortedColumns.delete(y);
      this.#cellCount += 1;
    }

    bucket.add(id);
    this.#points.set(id, {
      x: point.x,
      y: point.y,
      cellX: x,
      cellY: y
    });
    return this;
  }

  delete(id) {
    const record = this.#points.get(id);
    if (!record) return false;

    if (
      record.cellX == null ||
      record.cellY == null
    ) {
      this.#fallbackIds.delete(id);
      this.#points.delete(id);
      return true;
    }

    const row = this.#rows.get(record.cellY);
    const bucket = row?.get(record.cellX);
    bucket?.delete(id);

    if (bucket?.size === 0) {
      row.delete(record.cellX);
      this.#sortedColumns.delete(record.cellY);
      this.#cellCount -= 1;
    }
    if (row?.size === 0) {
      this.#rows.delete(record.cellY);
      this.#sortedRows = null;
      this.#sortedColumns.delete(record.cellY);
    }

    this.#points.delete(id);
    return true;
  }

  getPoint(id) {
    const record = this.#points.get(id);
    return record ? { x: record.x, y: record.y } : null;
  }

  queryRadius(point, radius, predicate = null) {
    assertVec2(point);
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError("radius must be a finite number >= 0");
    }
    if (this.#points.size === 0) return [];

    const minCellY = Math.floor((point.y - radius) / this.#cellSize);
    const maxCellY = Math.floor((point.y + radius) / this.#cellSize);
    const minCellX = Math.floor((point.x - radius) / this.#cellSize);
    const maxCellX = Math.floor((point.x + radius) / this.#cellSize);
    const result = [];

    const rows = this.#rowCoordinates();
    const rowStart = lowerBoundNumber(rows, minCellY);
    for (let ri = rowStart; ri < rows.length; ri += 1) {
      const y = rows[ri];
      if (y > maxCellY) break;

      const columns = this.#columnCoordinates(y);
      const columnStart = lowerBoundNumber(columns, minCellX);
      for (let ci = columnStart; ci < columns.length; ci += 1) {
        const x = columns[ci];
        if (x > maxCellX) break;

        const bucket = this.#rows.get(y)?.get(x);
        if (!bucket) continue;
        for (const id of bucket) {
          const record = this.#points.get(id);
          if (!record) continue;
          if (predicate && !predicate(id, record)) continue;
          const dx = record.x - point.x;
          const dy = record.y - point.y;
          const distance = Math.hypot(dx, dy);
          if (distance <= radius) {
            result.push({
              id,
              point: { x: record.x, y: record.y },
              distance
            });
          }
        }
      }
    }

    for (const id of this.#fallbackIds) {
      const record = this.#points.get(id);
      if (!record) continue;
      if (predicate && !predicate(id, record)) continue;

      const distance = Math.hypot(
        record.x - point.x,
        record.y - point.y
      );
      if (distance <= radius) {
        result.push({
          id,
          point: {
            x: record.x,
            y: record.y
          },
          distance
        });
      }
    }

    return result;
  }

  findNearest(point, {
    maxDistance = Infinity,
    predicate = null,
    compareIds = null
  } = {}) {
    assertVec2(point);
    if (maxDistance !== Infinity &&
        (!Number.isFinite(maxDistance) || maxDistance < 0)) {
      throw new RangeError(
        "maxDistance must be a finite number >= 0 or Infinity"
      );
    }
    if (this.#points.size === 0) return null;

    let best = null;
    let bestDistance = maxDistance;
    const overflowCandidates = [];

    const consider = (id, record) => {
      if (!record) return;
      if (predicate && !predicate(id, record)) return;

      const exactX = record.x - point.x;
      const exactY = record.y - point.y;
      const distance = Math.hypot(
        exactX,
        exactY
      );

      if (
        distance === Infinity &&
        bestDistance === Infinity
      ) {
        overflowCandidates.push({
          id,
          record
        });
      }
      if (distance > bestDistance) return;

      const winsTie =
        best != null &&
        distance === bestDistance &&
        compareIds != null &&
        compareIds(id, best.id) < 0;

      if (
        best == null ||
        distance < bestDistance ||
        winsTie
      ) {
        best = {
          id,
          point: {
            x: record.x,
            y: record.y
          },
          distance
        };
        bestDistance = distance;
      }
    };

    for (const id of this.#fallbackIds) {
      consider(id, this.#points.get(id));
    }

    const rows = this.#rowCoordinates();

    for (const rowCandidate of coordinatesByDistance(
      rows,
      point.y,
      this.#cellSize
    )) {
      const dy = rowCandidate.distance;
      if (dy > bestDistance) break;

      const y = rowCandidate.coordinate;
      const columns = this.#columnCoordinates(y);

      for (const columnCandidate of coordinatesByDistance(
        columns,
        point.x,
        this.#cellSize
      )) {
        const dx = columnCandidate.distance;
        const cellDistance = Math.hypot(dx, dy);
        if (cellDistance > bestDistance) break;

        const bucket = this.#rows.get(y)?.get(columnCandidate.coordinate);
        if (!bucket) continue;

        for (const id of bucket) {
          consider(id, this.#points.get(id));
        }
      }
    }

    if (
      bestDistance === Infinity &&
      overflowCandidates.length > 0
    ) {
      let scale = Math.max(
        1,
        Math.abs(point.x),
        Math.abs(point.y)
      );
      for (const candidate of overflowCandidates) {
        scale = Math.max(
          scale,
          Math.abs(candidate.record.x),
          Math.abs(candidate.record.y)
        );
      }

      let scaledBest = null;
      let scaledBestDistance = Infinity;
      for (const candidate of overflowCandidates) {
        const scaledDistance = Math.hypot(
          point.x / scale -
            candidate.record.x / scale,
          point.y / scale -
            candidate.record.y / scale
        );

        const winsTie =
          scaledBest != null &&
          scaledDistance === scaledBestDistance &&
          compareIds != null &&
          compareIds(
            candidate.id,
            scaledBest.id
          ) < 0;

        if (
          scaledBest == null ||
          scaledDistance < scaledBestDistance ||
          winsTie
        ) {
          scaledBest = candidate;
          scaledBestDistance = scaledDistance;
        }
      }

      if (scaledBest) {
        best = {
          id: scaledBest.id,
          point: {
            x: scaledBest.record.x,
            y: scaledBest.record.y
          },
          distance:
            scaledBestDistance * scale
        };
      }
    }

    return best;
  }

  get size() { return this.#points.size; }
  get cellSize() { return this.#cellSize; }
  get cellCount() { return this.#cellCount; }

  #rowCoordinates() {
    if (!this.#sortedRows) {
      this.#sortedRows = [...this.#rows.keys()].sort((a, b) => a - b);
    }
    return this.#sortedRows;
  }

  #columnCoordinates(rowY) {
    let cached = this.#sortedColumns.get(rowY);
    if (!cached) {
      cached = [...(this.#rows.get(rowY)?.keys() ?? [])]
        .sort((a, b) => a - b);
      this.#sortedColumns.set(rowY, cached);
    }
    return cached;
  }
}
