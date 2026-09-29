import { normalizeTransform } from "../geometry.js";
import {
  assertId,
  assertStringId,
  canonicalStringify,
  cloneJson,
  deepFreeze
} from "../utils.js";

export const PORTAL_STATE_KEYS = ["enabled", "open", "locked", "blocked", "destroyed"];
export const PLACE_INSTANCE_MUTATION_TOKEN =
  Symbol("place-core-instance-mutation");

export class ReadonlyMapView {
  #map;

  constructor(map) {
    this.#map = map;
    Object.freeze(this);
  }

  get size() { return this.#map.size; }
  get(key) { return this.#map.get(key); }
  has(key) { return this.#map.has(key); }
  keys() { return this.#map.keys(); }
  values() { return this.#map.values(); }
  entries() { return this.#map.entries(); }
  [Symbol.iterator]() { return this.#map[Symbol.iterator](); }

  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this.#map) {
      callback.call(thisArg, value, key, this);
    }
  }
}

export function assertPlainObject(value, label) {
  if (!value ||
      typeof value !== "object" ||
      Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

export function assertPatchKeys(value, allowedKeys, label) {
  assertPlainObject(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown field ${key}`);
    }
  }
  return value;
}

export function assertVec2(value, label = "position") {
  if (!value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)) {
    throw new TypeError(`${label} must be a finite Vec2`);
  }
  return value;
}

export function assertBounds(value, label = "bounds") {
  if (!value ||
      typeof value !== "object" ||
      Array.isArray(value)) {
    throw new TypeError(`${label} must be finite bounds`);
  }

  for (const key of ["minX", "minY", "maxX", "maxY"]) {
    if (!Number.isFinite(value[key])) {
      throw new TypeError(`${label}.${key} must be finite`);
    }
  }

  if (value.minX > value.maxX || value.minY > value.maxY) {
    throw new RangeError(
      `${label} minimums must not exceed maximums`
    );
  }
  return value;
}

export function assertOptionalString(value, label) {
  if (value == null) return null;
  assertStringId(value, label);
  return value;
}

export function normalizeFiniteDistance(
  value,
  label,
  { defaultValue = Infinity } = {}
) {
  if (value == null) return defaultValue;
  if (value === Infinity) return Infinity;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${label} must be a finite number >= 0 or Infinity`
    );
  }
  return value;
}

export function normalizeAttachment(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is required`);
  }
  assertStringId(value.domainId, `${label}.domainId`);
  if (!value.position ||
      !Number.isFinite(value.position.x) ||
      !Number.isFinite(value.position.y)) {
    throw new TypeError(`${label}.position must be a Vec2`);
  }
  if (value.nodeId != null) {
    assertStringId(value.nodeId, `${label}.nodeId`);
  }
  if (value.placeId != null) {
    assertId(value.placeId, `${label}.placeId`);
  }
  if (value.spaceId != null) {
    assertStringId(value.spaceId, `${label}.spaceId`);
  }

  return deepFreeze({
    domainId: value.domainId,
    position: { x: value.position.x, y: value.position.y },
    nodeId: value.nodeId ?? null,
    placeId: value.placeId ?? null,
    spaceId: value.spaceId ?? null,
    metadata: cloneJson(value.metadata ?? null)
  });
}

export function normalizePlacement(value) {
  if (!value) return null;
  const hasDomain = value.domainId != null;
  const hasParent = value.parentPlaceId != null;
  if (hasDomain === hasParent) {
    throw new TypeError("placement must specify exactly one of domainId or parentPlaceId");
  }
  if (hasDomain) assertStringId(value.domainId, "placement.domainId");
  if (hasParent) assertId(value.parentPlaceId, "placement.parentPlaceId");
  const containment = value.containment ?? "none";
  if (containment !== "none" && containment !== "footprint") {
    throw new TypeError("placement.containment must be \"none\" or \"footprint\"");
  }
  return deepFreeze({
    domainId: hasDomain ? value.domainId : null,
    parentPlaceId: hasParent ? value.parentPlaceId : null,
    transform: normalizeTransform(value.transform),
    containment
  });
}

export function attachmentEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.domainId === b.domainId &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.nodeId === b.nodeId &&
    a.placeId === b.placeId &&
    a.spaceId === b.spaceId &&
    canonicalStringify(a.metadata) === canonicalStringify(b.metadata);
}

export function placementEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.domainId === b.domainId &&
    a.parentPlaceId === b.parentPlaceId &&
    a.containment === b.containment &&
    a.transform.x === b.transform.x &&
    a.transform.y === b.transform.y &&
    a.transform.rotation === b.transform.rotation &&
    a.transform.scale === b.transform.scale;
}

function encodeDomainSegment(value) {
  return encodeURIComponent(String(value));
}

export function defaultLayerDomainId(placeId, layerId) {
  const placeSegment = typeof placeId === "number"
    ? `~n:${encodeDomainSegment(placeId)}`
    : encodeDomainSegment(placeId);
  return `${placeSegment}:${encodeDomainSegment(layerId)}`;
}

export function typedIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

export function membershipKey(parentPlaceId, kind) {
  return `${typedIdKey(parentPlaceId)}\u0000${kind}`;
}

export function normalizeMembership(value, label = "membership") {
  assertPlainObject(value, label);
  const allowed = new Set([
    "parentPlaceId",
    "kind",
    "metadata"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${label} contains unknown field ${key}`
      );
    }
  }

  assertId(
    value.parentPlaceId,
    `${label}.parentPlaceId`
  );
  const kind = value.kind ?? "member-of";
  assertStringId(kind, `${label}.kind`);

  return deepFreeze({
    parentPlaceId: value.parentPlaceId,
    kind,
    metadata: cloneJson(value.metadata ?? null)
  });
}

export function makeSpaceKey(instanceId, spaceId) {
  return `${typedIdKey(instanceId)}\u0000${spaceId}`;
}

export function cloneState(state) {
  return {
    enabled: state.enabled,
    open: state.open,
    locked: state.locked,
    blocked: state.blocked,
    destroyed: state.destroyed
  };
}

export function portalTraversableState(portal) {
  if (portal.connected === false) return false;
  if (!portal.enabled || portal.locked || portal.blocked || portal.destroyed) return false;
  if (portal.blocksWhenClosed && !portal.open) return false;
  return true;
}

function portalBindingsForDomain(instance, portal, domainId) {
  return (portal.roadBindings ?? []).filter((binding) =>
    instance.layerDomains.get(binding.layerId) === domainId
  );
}

export function validateResolvedPortalRoadBindings(
  instance,
  definition,
  portal,
  label = "portal"
) {
  for (const binding of portal.roadBindings ?? []) {
    const layer = definition.getLayer(binding.layerId);
    if (!layer) {
      throw new Error(
        `${label} road binding references unknown layer ${binding.layerId}`
      );
    }
    if (layer.topologyId == null) {
      throw new Error(
        `${label} road binding requires navigation topology on layer ${binding.layerId}`
      );
    }

    if (layer.navigation &&
        !layer.navigation.roads.some(
          (road) => road.id === binding.roadId
        )) {
      throw new Error(
        `${label} references unknown navigation road ${binding.roadId}`
      );
    }
  }

  if (!portal?.connected || !portal.a || !portal.b) return;
  if (portal.a.domainId !== portal.b.domainId) return;

  const domainId = portal.a.domainId;
  const thresholdBindings = portalBindingsForDomain(
    instance,
    portal,
    domainId
  );
  const crossesSpaces =
    portal.a.spaceId != null &&
    portal.b.spaceId != null &&
    portal.a.spaceId !== portal.b.spaceId;
  const needsPhysicalEnforcement =
    crossesSpaces ||
    (portal.transitionCost ?? 0) > 0 ||
    !portalTraversableState(portal);

  if (needsPhysicalEnforcement && thresholdBindings.length === 0) {
    throw new Error(
      `${label} requires a road binding in domain ${domainId} for same-domain physical enforcement`
    );
  }

  if (thresholdBindings.length === 0) return;

  let allowsForward = false;
  let allowsReverse = false;
  let verifiedEmbeddedRoad = false;

  for (const binding of thresholdBindings) {
    const layer = definition.getLayer(binding.layerId);
    if (!layer?.navigation) continue;

    const road = layer.navigation.roads.find(
      (candidate) => candidate.id === binding.roadId
    );
    if (!road) continue;
    verifiedEmbeddedRoad = true;

    if (portal.a.nodeId == null || portal.b.nodeId == null) {
      throw new Error(
        `${label} with a same-domain threshold road binding requires nodeId on both endpoints`
      );
    }

    const forward =
      road.from === portal.a.nodeId &&
      road.to === portal.b.nodeId;
    const reverse =
      road.from === portal.b.nodeId &&
      road.to === portal.a.nodeId;

    if (!forward && !reverse) {
      throw new Error(
        `${label} road binding ${binding.roadId} does not connect its endpoint nodes`
      );
    }

    allowsForward ||= forward || (reverse && road.bidirectional);
    allowsReverse ||= reverse || (forward && road.bidirectional);
  }

  if (!verifiedEmbeddedRoad) return;

  if (!allowsForward) {
    throw new Error(
      `${label} threshold roads do not allow traversal from endpoint a to b`
    );
  }

  if (portal.bidirectional) {
    if (!allowsReverse) {
      throw new Error(
        `${label} is bidirectional but its threshold roads do not allow traversal from endpoint b to a`
      );
    }
  } else if (allowsReverse) {
    throw new Error(
      `${label} is unidirectional but its threshold roads allow reverse traversal`
    );
  }
}
