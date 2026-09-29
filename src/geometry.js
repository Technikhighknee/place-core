const EPSILON = 1e-9;

export function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

export function assertVec2(value, label = "position") {
  if (!value || typeof value !== "object") throw new TypeError(`${label} must be a Vec2`);
  assertFiniteNumber(value.x, `${label}.x`);
  assertFiniteNumber(value.y, `${label}.y`);
  return value;
}

export function cloneVec2(value) {
  assertVec2(value);
  return Object.freeze({ x: value.x, y: value.y });
}

export function geometryBounds(geometry) {
  if (!geometry || typeof geometry !== "object") throw new TypeError("geometry is required");
  switch (geometry.type) {
    case "aabb": {
      const { minX, minY, maxX, maxY } = geometry;
      [minX, minY, maxX, maxY].forEach((v, i) => assertFiniteNumber(v, `geometry[${i}]`));
      if (maxX < minX || maxY < minY) throw new RangeError("invalid aabb bounds");
      return { minX, minY, maxX, maxY };
    }
    case "circle": {
      assertVec2(geometry.center, "geometry.center");
      assertFiniteNumber(geometry.radius, "geometry.radius");
      if (geometry.radius < 0) throw new RangeError("geometry.radius must be >= 0");
      return {
        minX: geometry.center.x - geometry.radius,
        minY: geometry.center.y - geometry.radius,
        maxX: geometry.center.x + geometry.radius,
        maxY: geometry.center.y + geometry.radius
      };
    }
    case "polygon": {
      if (!Array.isArray(geometry.points) || geometry.points.length < 3) {
        throw new TypeError("polygon geometry requires at least 3 points");
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < geometry.points.length; i += 1) {
        const p = geometry.points[i];
        assertVec2(p, `geometry.points[${i}]`);
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return { minX, minY, maxX, maxY };
    }
    default:
      throw new TypeError(`unsupported geometry type: ${geometry.type}`);
  }
}

function cross2(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function geometryVertices(geometry) {
  if (geometry.type === "aabb") {
    return [
      { x: geometry.minX, y: geometry.minY },
      { x: geometry.maxX, y: geometry.minY },
      { x: geometry.maxX, y: geometry.maxY },
      { x: geometry.minX, y: geometry.maxY }
    ];
  }
  if (geometry.type === "polygon") {
    return geometry.points;
  }
  return null;
}

function boundsContainBounds(parent, child) {
  return child.minX >= parent.minX - EPSILON &&
    child.minY >= parent.minY - EPSILON &&
    child.maxX <= parent.maxX + EPSILON &&
    child.maxY <= parent.maxY + EPSILON;
}

function segmentIntersectionParameters(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const rxs = cross2(rx, ry, sx, sy);
  const qxr = cross2(qx, qy, rx, ry);

  if (Math.abs(rxs) <= EPSILON) {
    if (Math.abs(qxr) > EPSILON) return [];
    const rr = rx * rx + ry * ry;
    if (rr <= EPSILON) return [];
    const t0 = (qx * rx + qy * ry) / rr;
    const t1 = t0 + (sx * rx + sy * ry) / rr;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    if (hi < lo - EPSILON) return [];
    return [lo, hi]
      .map((t) => Math.max(0, Math.min(1, t)));
  }

  const t = cross2(qx, qy, sx, sy) / rxs;
  const u = cross2(qx, qy, rx, ry) / rxs;
  if (
    t < -EPSILON || t > 1 + EPSILON ||
    u < -EPSILON || u > 1 + EPSILON
  ) {
    return [];
  }
  return [Math.max(0, Math.min(1, t))];
}

function pointAlongSegment(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  };
}

function segmentContainedInPolygon(a, b, polygon) {
  if (!pointInPolygon(a, polygon) || !pointInPolygon(b, polygon)) {
    return false;
  }

  const parameters = [0, 1];
  for (let i = 0; i < polygon.length; i += 1) {
    const c = polygon[i];
    const d = polygon[(i + 1) % polygon.length];
    parameters.push(...segmentIntersectionParameters(a, b, c, d));
  }

  parameters.sort((x, y) => x - y);
  const unique = [];
  for (const value of parameters) {
    if (
      unique.length === 0 ||
      Math.abs(value - unique[unique.length - 1]) > EPSILON
    ) {
      unique.push(value);
    }
  }

  for (let i = 0; i < unique.length - 1; i += 1) {
    const lo = unique[i];
    const hi = unique[i + 1];
    if (hi - lo <= EPSILON) continue;
    const midpoint = pointAlongSegment(a, b, (lo + hi) / 2);
    if (!pointInPolygon(midpoint, polygon)) return false;
  }

  return true;
}

function polygonContainsVerticesAndEdges(parentPoints, childPoints) {
  for (const point of childPoints) {
    if (!pointInPolygon(point, parentPoints)) return false;
  }
  for (let i = 0; i < childPoints.length; i += 1) {
    const a = childPoints[i];
    const b = childPoints[(i + 1) % childPoints.length];
    if (!segmentContainedInPolygon(a, b, parentPoints)) return false;
  }
  return true;
}

export function geometryContainsGeometry(parent, child) {
  const parentBounds = geometryBounds(parent);
  const childBounds = geometryBounds(child);
  if (!boundsContainBounds(parentBounds, childBounds)) return false;

  if (child.type === "circle") {
    if (parent.type === "aabb") {
      return (
        child.center.x - child.radius >= parent.minX - EPSILON &&
        child.center.y - child.radius >= parent.minY - EPSILON &&
        child.center.x + child.radius <= parent.maxX + EPSILON &&
        child.center.y + child.radius <= parent.maxY + EPSILON
      );
    }

    if (parent.type === "circle") {
      const dx = child.center.x - parent.center.x;
      const dy = child.center.y - parent.center.y;
      const centerDistance = Math.sqrt(dx * dx + dy * dy);
      return centerDistance + child.radius <= parent.radius + EPSILON;
    }

    if (parent.type === "polygon") {
      if (!pointInPolygon(child.center, parent.points)) return false;
      const radiusSq = child.radius * child.radius;
      for (let i = 0; i < parent.points.length; i += 1) {
        const a = parent.points[i];
        const b = parent.points[(i + 1) % parent.points.length];
        if (
          squaredDistancePointToSegment(child.center, a, b) <
          radiusSq - EPSILON
        ) {
          return false;
        }
      }
      return true;
    }
  }

  const childVertices = geometryVertices(child);
  if (!childVertices) {
    throw new TypeError(
      `unsupported child geometry type: ${child.type}`
    );
  }

  if (parent.type === "aabb" || parent.type === "circle") {
    return childVertices.every((point) =>
      pointInGeometry(point, parent)
    );
  }

  if (parent.type === "polygon") {
    return polygonContainsVerticesAndEdges(
      parent.points,
      childVertices
    );
  }

  throw new TypeError(
    `unsupported parent geometry type: ${parent.type}`
  );
}

export function pointInBounds(point, bounds) {
  return point.x >= bounds.minX - EPSILON && point.x <= bounds.maxX + EPSILON &&
    point.y >= bounds.minY - EPSILON && point.y <= bounds.maxY + EPSILON;
}

export function pointInGeometry(point, geometry) {
  assertVec2(point);
  switch (geometry.type) {
    case "aabb":
      return point.x >= geometry.minX - EPSILON && point.x <= geometry.maxX + EPSILON &&
        point.y >= geometry.minY - EPSILON && point.y <= geometry.maxY + EPSILON;
    case "circle": {
      const dx = point.x - geometry.center.x;
      const dy = point.y - geometry.center.y;
      return dx * dx + dy * dy <= geometry.radius * geometry.radius + EPSILON;
    }
    case "polygon":
      return pointInPolygon(point, geometry.points);
    default:
      throw new TypeError(`unsupported geometry type: ${geometry.type}`);
  }
}

export function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (pointOnSegment(point, a, b)) return true;
    const intersect = ((a.y > point.y) !== (b.y > point.y)) &&
      (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointOnSegment(point, a, b) {
  const cross = (point.y - a.y) * (b.x - a.x) - (point.x - a.x) * (b.y - a.y);
  if (Math.abs(cross) > EPSILON) return false;
  const dot = (point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y);
  if (dot < -EPSILON) return false;
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= len2 + EPSILON;
}

export function normalizeGeometry(geometry) {
  geometryBounds(geometry);
  if (geometry.type === "polygon") {
    return Object.freeze({
      type: "polygon",
      points: Object.freeze(geometry.points.map(cloneVec2))
    });
  }
  if (geometry.type === "circle") {
    return Object.freeze({ type: "circle", center: cloneVec2(geometry.center), radius: geometry.radius });
  }
  return Object.freeze({
    type: "aabb",
    minX: geometry.minX,
    minY: geometry.minY,
    maxX: geometry.maxX,
    maxY: geometry.maxY
  });
}

export function normalizeTransform(transform = {}) {
  const x = transform.x ?? transform.position?.x ?? 0;
  const y = transform.y ?? transform.position?.y ?? 0;
  const rotation = transform.rotation ?? 0;
  const scale = transform.scale ?? 1;
  assertFiniteNumber(x, "transform.x");
  assertFiniteNumber(y, "transform.y");
  assertFiniteNumber(rotation, "transform.rotation");
  assertFiniteNumber(scale, "transform.scale");
  if (scale <= 0) throw new RangeError("transform.scale must be > 0");
  return Object.freeze({ x, y, rotation, scale });
}

export function composeTransforms(parent, child) {
  const a = normalizeTransform(parent);
  const b = normalizeTransform(child);
  const origin = transformPoint({ x: b.x, y: b.y }, a);
  return Object.freeze({
    x: origin.x,
    y: origin.y,
    rotation: a.rotation + b.rotation,
    scale: a.scale * b.scale
  });
}

export function transformPoint(point, transform) {
  const t = normalizeTransform(transform);
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const sx = point.x * t.scale;
  const sy = point.y * t.scale;
  return {
    x: t.x + sx * c - sy * s,
    y: t.y + sx * s + sy * c
  };
}

export function inverseTransformPoint(point, transform) {
  const t = normalizeTransform(transform);
  const dx = point.x - t.x;
  const dy = point.y - t.y;
  const c = Math.cos(-t.rotation);
  const s = Math.sin(-t.rotation);
  return {
    x: (dx * c - dy * s) / t.scale,
    y: (dx * s + dy * c) / t.scale
  };
}

export function transformBounds(bounds, transform) {
  const corners = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY }
  ].map((p) => transformPoint(p, transform));
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxX: Math.max(...corners.map((p) => p.x)),
    maxY: Math.max(...corners.map((p) => p.y))
  };
}

export function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function boundsIntersect(a, b) {
  return a.minX <= b.maxX + EPSILON &&
    a.maxX >= b.minX - EPSILON &&
    a.minY <= b.maxY + EPSILON &&
    a.maxY >= b.minY - EPSILON;
}

export function segmentBounds(a, b) {
  assertVec2(a, "segment.a");
  assertVec2(b, "segment.b");
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y)
  };
}

export function squaredDistancePointToSegment(point, a, b) {
  assertVec2(point);
  assertVec2(a, "segment.a");
  assertVec2(b, "segment.b");
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const len2 = abX * abX + abY * abY;
  if (len2 <= EPSILON) return squaredDistance(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * abX + (point.y - a.y) * abY) / len2));
  const closest = { x: a.x + abX * t, y: a.y + abY * t };
  return squaredDistance(point, closest);
}

export function segmentIntersectsBounds(a, b, bounds) {
  assertVec2(a, "segment.a");
  assertVec2(b, "segment.b");
  if (!boundsIntersect(segmentBounds(a, b), bounds)) return false;
  if (pointInBounds(a, bounds) || pointInBounds(b, bounds)) return true;

  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks = [
    [-dx, a.x - bounds.minX],
    [ dx, bounds.maxX - a.x],
    [-dy, a.y - bounds.minY],
    [ dy, bounds.maxY - a.y]
  ];

  for (const [p, q] of checks) {
    if (Math.abs(p) <= EPSILON) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > t1) return false;
      if (ratio > t0) t0 = ratio;
    } else {
      if (ratio < t0) return false;
      if (ratio < t1) t1 = ratio;
    }
  }
  return t0 <= t1 + EPSILON;
}

export class StaticGeometryIndex {
  #cellSize;
  #cells = new Map();
  #items;

  constructor(items, { cellSize = 8, geometryOf = (item) => item.geometry } = {}) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError("cellSize must be > 0");
    this.#cellSize = cellSize;
    this.#items = Object.freeze([...items]);
    for (let index = 0; index < this.#items.length; index += 1) {
      const bounds = geometryBounds(geometryOf(this.#items[index]));
      for (const key of this.#keysForBounds(bounds)) {
        let bucket = this.#cells.get(key);
        if (!bucket) this.#cells.set(key, bucket = []);
        bucket.push(index);
      }
    }
    for (const bucket of this.#cells.values()) Object.freeze(bucket);
  }

  queryPoint(point, predicate = null, geometryOf = (item) => item.geometry) {
    assertVec2(point);
    const bucket = this.#cells.get(this.#key(point.x, point.y));
    if (!bucket) return [];
    const result = [];
    for (const index of bucket) {
      const item = this.#items[index];
      if ((!predicate || predicate(item)) && pointInGeometry(point, geometryOf(item))) result.push(item);
    }
    return result;
  }

  get cellCount() {
    return this.#cells.size;
  }

  #key(x, y) {
    return `${Math.floor(x / this.#cellSize)},${Math.floor(y / this.#cellSize)}`;
  }

  *#keysForBounds(bounds) {
    const minX = Math.floor(bounds.minX / this.#cellSize);
    const minY = Math.floor(bounds.minY / this.#cellSize);
    const maxX = Math.floor(bounds.maxX / this.#cellSize);
    const maxY = Math.floor(bounds.maxY / this.#cellSize);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) yield `${x},${y}`;
    }
  }
}

export class DynamicAabbIndex {
  #cellSize;
  #cells = new Map();
  #bounds = new Map();
  #memberships = new Map();

  constructor(cellSize = 64) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError("cellSize must be > 0");
    this.#cellSize = cellSize;
  }

  set(id, bounds) {
    this.delete(id);
    const keys = [...this.#keysForBounds(bounds)];
    this.#bounds.set(id, { ...bounds });
    this.#memberships.set(id, keys);
    for (const key of keys) {
      let bucket = this.#cells.get(key);
      if (!bucket) this.#cells.set(key, bucket = new Set());
      bucket.add(id);
    }
  }

  delete(id) {
    const keys = this.#memberships.get(id);
    if (!keys) return false;
    for (const key of keys) {
      const bucket = this.#cells.get(key);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.#cells.delete(key);
    }
    this.#memberships.delete(id);
    this.#bounds.delete(id);
    return true;
  }

  queryPoint(point) {
    const bucket = this.#cells.get(this.#key(point.x, point.y));
    if (!bucket) return [];
    const result = [];
    for (const id of bucket) {
      const bounds = this.#bounds.get(id);
      if (bounds && pointInBounds(point, bounds)) result.push(id);
    }
    return result;
  }

  queryBounds(bounds) {
    const candidates = new Set();
    for (const key of this.#keysForBounds(bounds)) {
      const bucket = this.#cells.get(key);
      if (!bucket) continue;
      for (const id of bucket) candidates.add(id);
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

  #key(x, y) {
    return `${Math.floor(x / this.#cellSize)},${Math.floor(y / this.#cellSize)}`;
  }

  *#keysForBounds(bounds) {
    const minX = Math.floor(bounds.minX / this.#cellSize);
    const minY = Math.floor(bounds.minY / this.#cellSize);
    const maxX = Math.floor(bounds.maxX / this.#cellSize);
    const maxY = Math.floor(bounds.maxY / this.#cellSize);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) yield `${x},${y}`;
    }
  }
}
