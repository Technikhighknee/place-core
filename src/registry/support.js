import { normalizeTransform } from "../geometry.js";
import {
  assertId,
  assertStringId,
  canonicalStringify,
  cloneJson,
  deepFreeze,
  tupleKey
} from "../utils.js";

export const PORTAL_STATE_KEYS = ["enabled", "open", "locked", "blocked", "destroyed"];
export const PLACE_INSTANCE_MUTATION_TOKEN =
  Symbol("place-core-instance-mutation");
export const PLACE_REGISTRY_BRIDGE_ATTACH_TOKEN =
  Symbol("place-core-bridge-attach");
export const PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN =
  Symbol("place-core-travel-mutation");

const activeTravelBridges = new WeakMap();

export function bindTravelRuntimeBridge(
  state,
  bridge
) {
  if (!state || typeof state !== "object") {
    throw new TypeError(
      "active travel state must be an object"
    );
  }
  if (!bridge || typeof bridge !== "object") {
    throw new TypeError(
      "active travel bridge must be an object"
    );
  }

  const existing =
    activeTravelBridges.get(state);
  if (existing && existing !== bridge) {
    throw new Error(
      "active travel is already bound to a different WorldCoreBridge"
    );
  }

  activeTravelBridges.set(state, bridge);
  return state;
}

export function getTravelRuntimeBridge(state) {
  if (!state || typeof state !== "object") {
    return null;
  }
  return activeTravelBridges.get(state) ?? null;
}

export function abortEnteredTravelPortal(
  registry,
  state,
  reason
) {
  if (!state?.portalEntered) {
    return false;
  }

  const step =
    state.plan?.steps?.[state.stepIndex] ??
    null;

  state.portalEntered = false;
  state.portalTransitionRemaining = 0;

  if (step?.type !== "traverse-portal") {
    return false;
  }

  registry.emit?.("portal-abort", {
    entityId: state.entityId,
    portalKey: step.portalKey,
    placeId: step.placeId,
    portalId: step.portalId,
    fromDomainId: step.fromDomainId,
    toDomainId: step.toDomainId,
    reason
  });
  return true;
}

export class ReadonlyMapView {
  #map;
  #project;

  constructor(map, project = (value) => value) {
    this.#map = map;
    this.#project = project;
    Object.freeze(this);
  }

  get size() { return this.#map.size; }
  get(key) {
    const value = this.#map.get(key);
    return value === undefined
      ? undefined
      : this.#project(value);
  }
  has(key) { return this.#map.has(key); }
  keys() { return this.#map.keys(); }

  *values() {
    for (const value of this.#map.values()) {
      yield this.#project(value);
    }
  }

  *entries() {
    for (const [key, value] of this.#map) {
      yield [key, this.#project(value)];
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(callback, thisArg = undefined) {
    for (const [key, value] of this.#map) {
      callback.call(
        thisArg,
        this.#project(value),
        key,
        this
      );
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
  assertPatchKeys(
    value,
    [
      "domainId",
      "position",
      "nodeId",
      "placeId",
      "spaceId",
      "metadata"
    ],
    label
  );
  assertStringId(value.domainId, `${label}.domainId`);
  assertVec2(value.position, `${label}.position`);
  assertPatchKeys(
    value.position,
    ["x", "y"],
    `${label}.position`
  );
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
  if (value == null) return null;
  assertPatchKeys(
    value,
    [
      "domainId",
      "parentPlaceId",
      "transform",
      "containment"
    ],
    "placement"
  );
  if (value.transform != null) {
    assertPatchKeys(
      value.transform,
      ["x", "y", "position", "rotation", "scale"],
      "placement.transform"
    );
    if (value.transform.position != null) {
      assertVec2(
        value.transform.position,
        "placement.transform.position"
      );
      assertPatchKeys(
        value.transform.position,
        ["x", "y"],
        "placement.transform.position"
      );
    }
  }
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
  return tupleKey(
    typedIdKey(parentPlaceId),
    kind
  );
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
  return tupleKey(
    typedIdKey(instanceId),
    spaceId
  );
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

  const endpointDomains = new Set([
    portal.a.domainId,
    portal.b.domainId
  ]);

  for (const binding of portal.roadBindings ?? []) {
    const bindingDomainId =
      instance.layerDomains.get(
        binding.layerId
      ) ??
      null;

    if (
      bindingDomainId != null &&
      !endpointDomains.has(
        bindingDomainId
      )
    ) {
      throw new Error(
        `${label} road binding ${binding.roadId} belongs to unrelated domain ${bindingDomainId}`
      );
    }
  }

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


export function snapshotTravelState(state) {
  if (state == null) return null;

  const options = {
    ...(state.options ?? {})
  };

  if (options.journeyOptions !== undefined) {
    options.journeyOptions =
      deepFreeze(cloneJson(options.journeyOptions));
  }
  if (options.excludedPortalKeys !== undefined) {
    options.excludedPortalKeys =
      Object.freeze([...options.excludedPortalKeys]);
  }
  if (options.excludedDomainPairs !== undefined) {
    options.excludedDomainPairs =
      Object.freeze([...options.excludedDomainPairs]);
  }

  const snapshot = {
    ...state,
    target: deepFreeze(cloneJson(state.target)),
    plan: state.plan,
    options: deepFreeze(options)
  };

  return deepFreeze(snapshot);
}
