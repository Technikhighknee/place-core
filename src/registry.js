import {
  DynamicAabbIndex,
  DynamicPointIndex,
  geometryBounds,
  inverseTransformPoint,
  normalizeTransform,
  composeTransforms,
  pointInGeometry,
  squaredDistance,
  squaredDistancePointToSegment,
  segmentIntersectsBounds,
  transformBounds
} from "./geometry.js";
import { CompiledPlaceDefinition } from "./definition.js";
import {
  assertId,
  assertStringId,
  BoundedEventQueue,
  canonicalStringify,
  cloneJson,
  deepFreeze,
  normalizeBoolean,
  normalizeStringList
} from "./utils.js";

const PORTAL_STATE_KEYS = ["enabled", "open", "locked", "blocked", "destroyed"];

function assertPlainObject(value, label) {
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

function assertPatchKeys(value, allowedKeys, label) {
  assertPlainObject(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown field ${key}`);
    }
  }
  return value;
}

function assertVec2(value, label = "position") {
  if (!value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)) {
    throw new TypeError(`${label} must be a finite Vec2`);
  }
  return value;
}

function assertBounds(value, label = "bounds") {
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

function assertOptionalString(value, label) {
  if (value == null) return null;
  assertStringId(value, label);
  return value;
}

function normalizeFiniteDistance(
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

function normalizeAttachment(value, label) {
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

function normalizePlacement(value) {
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

function attachmentEqual(a, b) {
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

function placementEqual(a, b) {
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

function defaultLayerDomainId(placeId, layerId) {
  const placeSegment = typeof placeId === "number"
    ? `~n:${encodeDomainSegment(placeId)}`
    : encodeDomainSegment(placeId);
  return `${placeSegment}:${encodeDomainSegment(layerId)}`;
}

function typedIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function membershipKey(parentPlaceId, kind) {
  return `${typedIdKey(parentPlaceId)}\u0000${kind}`;
}

function normalizeMembership(value, label = "membership") {
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

function makeSpaceKey(instanceId, spaceId) {
  return `${typedIdKey(instanceId)}\u0000${spaceId}`;
}

function cloneState(state) {
  return {
    enabled: state.enabled,
    open: state.open,
    locked: state.locked,
    blocked: state.blocked,
    destroyed: state.destroyed
  };
}

function portalTraversableState(portal) {
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

function validateResolvedPortalRoadBindings(
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

export class PlaceInstance {
  #portalOverrides = new Map();
  #boundaryOverrides = new Map();
  #spaceOverrides = new Map();
  #dynamicPortals = new Map();
  #memberships = new Map();

  constructor(data) {
    this.id = data.id;
    this.definitionId = data.definitionId;
    this.parentId = data.parentId ?? null;
    this.layerDomains = new Map(data.layerDomains);
    this.attachments = new Map(data.attachments);
    this.placement = data.placement;
    this.metadata = cloneJson(data.metadata ?? null);

    for (const membership of data.memberships ?? []) {
      this.#memberships.set(
        membershipKey(
          membership.parentPlaceId,
          membership.kind
        ),
        membership
      );
    }
  }

  getPortalOverride(portalId) { return this.#portalOverrides.get(portalId) ?? null; }
  setPortalOverride(portalId, override) {
    if (override == null || Object.keys(override).length === 0) this.#portalOverrides.delete(portalId);
    else this.#portalOverrides.set(portalId, deepFreeze({ ...override }));
  }
  get portalOverrides() { return this.#portalOverrides; }
  get boundaryOverrides() { return this.#boundaryOverrides; }
  get spaceOverrides() { return this.#spaceOverrides; }
  get dynamicPortals() { return this.#dynamicPortals; }
  getBoundaryOverride(boundaryId) { return this.#boundaryOverrides.get(boundaryId) ?? null; }
  setBoundaryOverride(boundaryId, override) {
    if (override == null || Object.keys(override).length === 0) this.#boundaryOverrides.delete(boundaryId);
    else this.#boundaryOverrides.set(boundaryId, deepFreeze({ ...override }));
  }
  getSpaceOverride(spaceId) { return this.#spaceOverrides.get(spaceId) ?? null; }
  setSpaceOverride(spaceId, override) {
    if (override == null || Object.keys(override).length === 0) this.#spaceOverrides.delete(spaceId);
    else this.#spaceOverrides.set(spaceId, deepFreeze({ ...override }));
  }
  addDynamicPortal(portal) { this.#dynamicPortals.set(portal.id, portal); }
  removeDynamicPortal(portalId) { return this.#dynamicPortals.delete(portalId); }

  getMembership(parentPlaceId, kind = "member-of") {
    return this.#memberships.get(
      membershipKey(parentPlaceId, kind)
    ) ?? null;
  }

  getMemberships() {
    return [...this.#memberships.values()];
  }

  addMembership(membership) {
    const key = membershipKey(
      membership.parentPlaceId,
      membership.kind
    );
    if (this.#memberships.has(key)) return false;
    this.#memberships.set(key, membership);
    return true;
  }

  removeMembership(parentPlaceId, kind = "member-of") {
    return this.#memberships.delete(
      membershipKey(parentPlaceId, kind)
    );
  }
}

export class PlaceRegistry {
  #definitions = new Map();
  #instances = new Map();
  #domainBindings = new Map();
  #exteriorIndexes = new Map();
  #indexedExteriorDomains = new Map();
  #placementChildren = new Map();
  #semanticChildren = new Map();
  #membershipChildren = new Map();
  #portalRecords = new Map();
  #portalsByDomain = new Map();
  #portalEndpointIndexes = new Map();
  #traversablePortalEndpointIndexes = new Map();
  #portalEndpointRecords = new Map();
  #portalsByRoad = new Map();
  #instancePortalKeys = new Map();
  #occupancy = new Map();
  #occupancySpatialIndexes = new Map();
  #entitiesByPlace = new Map();
  #entitiesBySpace = new Map();
  #events;
  #captureEvents;
  #bridge = null;
  #sequence = 0;
  #stateRevision = 0;
  #travelRevision = 0;

  constructor(options = {}) {
    this.#captureEvents = normalizeBoolean(
      options.captureEvents,
      "captureEvents",
      { defaultValue: false }
    );
    this.#events = new BoundedEventQueue({
      limit: options.eventQueueLimit ?? 10_000,
      overflowPolicy: options.eventOverflowPolicy ?? "drop-newest"
    });
    if (options.bridge) this.attachBridge(options.bridge);
  }

  get definitions() { return this.#definitions; }
  get instances() { return this.#instances; }
  get domainBindings() { return this.#domainBindings; }
  get activeTravels() {
    if (!this._activeTravels) this._activeTravels = new Map();
    return this._activeTravels;
  }
  get pendingTravels() {
    if (!this._pendingTravels) this._pendingTravels = [];
    return this._pendingTravels;
  }
  get stateRevision() { return this.#stateRevision; }
  get travelRevision() { return this.#travelRevision; }
  get graphRevision() { return this.#travelRevision; }
  get bridge() { return this.#bridge; }

  #touchState({ travel = false } = {}) {
    this.#stateRevision += 1;
    if (travel) this.#travelRevision += 1;
  }

  attachBridge(bridge) {
    if (!bridge || typeof bridge !== "object") {
      throw new TypeError("bridge must be an object");
    }
    if (this.#bridge === bridge) return this;
    if (this.#bridge && this.#bridge !== bridge) {
      throw new Error("place-core already has a different bridge attached");
    }

    const materialized = [];
    let registryAttached = false;

    try {
      if (typeof bridge.attachRegistry === "function") {
        bridge.attachRegistry(this);
        registryAttached = true;
      }

      if (typeof bridge.materializePlace === "function") {
        const instances = [...this.#instances.values()]
          .sort((a, b) => typedIdKey(a.id).localeCompare(typedIdKey(b.id)));

        for (const instance of instances) {
          const definition = this.#definitions.get(instance.definitionId);
          const receipt = bridge.materializePlace(instance, definition);
          materialized.push({ instance, definition, receipt });

          for (const boundary of definition.boundaries) {
            bridge.syncBoundaryState?.(
              instance,
              this.getBoundary(instance.id, boundary.id)
            );
          }
          for (const portal of definition.portals) {
            bridge.syncPortalState?.(
              instance,
              portal,
              this.resolvePortal(instance.id, portal.id)
            );
          }
          for (const dynamicPortal of instance.dynamicPortals.values()) {
            bridge.syncDynamicPortal?.(
              instance,
              dynamicPortal,
              this.resolvePortal(instance.id, dynamicPortal.id)
            );
          }
        }
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const {
        instance,
        definition,
        receipt
      } of materialized.reverse()) {
        try {
          if (receipt != null &&
              typeof bridge.rollbackMaterializePlace === "function") {
            bridge.rollbackMaterializePlace(
              instance,
              definition,
              receipt
            );
          } else {
            bridge.unmaterializePlace?.(instance, definition);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (registryAttached) {
        try {
          bridge.dispose?.();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "failed to attach place-core bridge and rollback materialization"
        );
      }
      throw error;
    }

    this.#bridge = bridge;
    return this;
  }

  registerDefinition(definition) {
    if (!(definition instanceof CompiledPlaceDefinition)) throw new TypeError("registerDefinition requires a compiled place definition");
    const existing = this.#definitions.get(definition.id);
    if (existing && existing.contentHash !== definition.contentHash) {
      throw new Error(`definition ${definition.id} is already registered with another content hash`);
    }
    this.#definitions.set(definition.id, definition);
    return definition;
  }

  removeDefinition(definitionId) {
    for (const instance of this.#instances.values()) {
      if (instance.definitionId === definitionId) return false;
    }
    return this.#definitions.delete(definitionId);
  }

  getDefinition(id) { return this.#definitions.get(id) ?? null; }
  getPlace(id) { return this.#instances.get(id) ?? null; }

  getSpace(instanceId, spaceId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return null;
    const definition = this.#definitions.get(instance.definitionId);
    const space = definition.getSpace(spaceId);
    if (!space) return null;
    return { ...space, enabled: this.#spaceEnabled(instance, definition, space) };
  }

  getBoundary(instanceId, boundaryId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return null;
    const definition = this.#definitions.get(instance.definitionId);
    const boundary = definition.getBoundary(boundaryId);
    if (!boundary) return null;
    return { ...boundary, enabled: instance.getBoundaryOverride(boundaryId)?.enabled ?? boundary.enabled };
  }

  getPortal(instanceId, portalId) { return this.resolvePortal(instanceId, portalId); }

  findAnchor(instanceId, anchorId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return null;
    const definition = this.#definitions.get(instance.definitionId);
    const anchor = definition.getAnchor(anchorId);
    if (!anchor) return null;
    return { ...anchor, placeId: instanceId, domainId: instance.layerDomains.get(anchor.layerId) };
  }

  findAnchorsByTag(instanceId, tag) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return [];
    const definition = this.#definitions.get(instance.definitionId);
    return definition.getAnchorsByTag(tag).map((anchor) => ({
      ...anchor, placeId: instanceId, domainId: instance.layerDomains.get(anchor.layerId)
    }));
  }

  findNearestAnchor(instanceId, position, options = {}) {
    assertVec2(position, "findNearestAnchor.position");
    assertOptionalString(options.tag, "findNearestAnchor.tag");
    assertOptionalString(options.layerId, "findNearestAnchor.layerId");
    assertOptionalString(options.kind, "findNearestAnchor.kind");
    assertOptionalString(options.spaceId, "findNearestAnchor.spaceId");
    const instance = this.#instances.get(instanceId);
    if (!instance) return null;
    const definition = this.#definitions.get(instance.definitionId);
    const candidates = options.tag
      ? definition.getAnchorsByTag(options.tag)
      : definition.anchors;

    let best = null;
    let bestDistanceSq = Infinity;

    for (const anchor of candidates) {
      if (options.layerId != null && anchor.layerId !== options.layerId) continue;
      if (options.kind != null && anchor.kind !== options.kind) continue;
      if (options.spaceId != null && anchor.spaceId !== options.spaceId) continue;
      if (anchor.spaceId != null) {
        const space = definition.getSpace(anchor.spaceId);
        if (space && !this.#spaceEnabled(instance, definition, space)) continue;
      }

      const distanceSq = squaredDistance(position, anchor.position);
      if (distanceSq < bestDistanceSq ||
          (distanceSq === bestDistanceSq &&
           anchor.id.localeCompare(best?.id ?? "") < 0)) {
        best = anchor;
        bestDistanceSq = distanceSq;
      }
    }

    return best ? {
      ...best,
      placeId: instanceId,
      domainId: instance.layerDomains.get(best.layerId),
      distance: Math.sqrt(bestDistanceSq)
    } : null;
  }

  getAnchorsForDomain(domainId, options = {}) {
    assertStringId(domainId, "getAnchorsForDomain.domainId");
    assertOptionalString(options.tag, "getAnchorsForDomain.tag");
    assertOptionalString(options.kind, "getAnchorsForDomain.kind");
    assertOptionalString(options.spaceId, "getAnchorsForDomain.spaceId");
    const binding = this.#domainBindings.get(domainId);
    if (!binding) return [];
    const instance = this.#instances.get(binding.instanceId);
    if (!instance) return [];
    const definition = this.#definitions.get(instance.definitionId);
    const candidates = options.tag ? definition.getAnchorsByTag(options.tag) : definition.anchors;
    const result = [];

    for (const anchor of candidates) {
      if (anchor.layerId !== binding.layerId) continue;
      if (options.kind != null && anchor.kind !== options.kind) continue;
      if (options.spaceId != null && anchor.spaceId !== options.spaceId) continue;
      if (anchor.spaceId != null) {
        const space = definition.getSpace(anchor.spaceId);
        if (space && !this.#spaceEnabled(instance, definition, space)) continue;
      }
      result.push({
        ...anchor,
        placeId: instance.id,
        domainId
      });
    }

    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
  }

  findNearestAnchorInDomain(domainId, position, options = {}) {
    assertStringId(domainId, "findNearestAnchorInDomain.domainId");
    assertVec2(position, "findNearestAnchorInDomain.position");
    let best = null;
    let bestDistanceSq = Infinity;

    for (const anchor of this.getAnchorsForDomain(domainId, options)) {
      const distanceSq = squaredDistance(position, anchor.position);
      if (distanceSq < bestDistanceSq ||
          (distanceSq === bestDistanceSq && anchor.id.localeCompare(best?.id ?? "") < 0)) {
        best = anchor;
        bestDistanceSq = distanceSq;
      }
    }

    return best ? {
      ...best,
      distance: Math.sqrt(bestDistanceSq)
    } : null;
  }

  findPortalEndpointsNear(domainId, position, radius, options = {}) {
    assertStringId(domainId, "findPortalEndpointsNear.domainId");
    assertVec2(position, "findPortalEndpointsNear.position");
    const traversableOnly = normalizeBoolean(
      options.traversableOnly,
      "findPortalEndpointsNear.traversableOnly",
      { defaultValue: true }
    );
    assertOptionalString(options.kind, "findPortalEndpointsNear.kind");
    assertOptionalString(options.tag, "findPortalEndpointsNear.tag");
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError(
        "portal query radius must be a finite number >= 0"
      );
    }

    const endpointIndexes = traversableOnly
      ? this.#traversablePortalEndpointIndexes
      : this.#portalEndpointIndexes;
    const index = endpointIndexes.get(domainId);
    if (!index) return [];

    const matches = index.queryRadius(
      position,
      radius,
      (endpointKey) => {
        const endpointRecord =
          this.#portalEndpointRecords.get(endpointKey);
        if (!endpointRecord) return false;

        const portal =
          this.#portalRecords.get(endpointRecord.portalKey);
        if (!portal) return false;
        if (traversableOnly && !portal.traversable) return false;
        if (options.kind != null && portal.kind !== options.kind) {
          return false;
        }
        if (options.tag != null &&
            !portal.tags?.includes(options.tag)) {
          return false;
        }
        return endpointRecord.domainId === domainId;
      }
    );

    const result = [];
    for (const match of matches) {
      const endpointRecord =
        this.#portalEndpointRecords.get(match.id);
      if (!endpointRecord) continue;
      const portal =
        this.#portalRecords.get(endpointRecord.portalKey);
      if (!portal) continue;

      const endpoint =
        endpointRecord.side === "a" ? portal.a : portal.b;
      if (!endpoint || endpoint.domainId !== domainId) continue;

      result.push({
        portal,
        endpoint,
        side: endpointRecord.side,
        distance: match.distance
      });
    }

    result.sort((a, b) =>
      a.distance - b.distance ||
      a.portal.key.localeCompare(b.portal.key) ||
      a.side.localeCompare(b.side)
    );
    return result;
  }

  findNearestPortal(domainId, position, options = {}) {
    assertStringId(domainId, "findNearestPortal.domainId");
    assertVec2(position, "findNearestPortal.position");
    const traversableOnly = normalizeBoolean(
      options.traversableOnly,
      "findNearestPortal.traversableOnly",
      { defaultValue: true }
    );
    assertOptionalString(options.kind, "findNearestPortal.kind");
    assertOptionalString(options.tag, "findNearestPortal.tag");
    const maxDistance = normalizeFiniteDistance(
      options.maxDistance,
      "findNearestPortal.maxDistance"
    );

    const endpointIndexes = traversableOnly
      ? this.#traversablePortalEndpointIndexes
      : this.#portalEndpointIndexes;
    const index = endpointIndexes.get(domainId);
    if (!index || index.size === 0) return null;

    const match = index.findNearest(position, {
      maxDistance,
      predicate: (endpointKey) => {
        const endpointRecord =
          this.#portalEndpointRecords.get(endpointKey);
        if (!endpointRecord ||
            endpointRecord.domainId !== domainId) {
          return false;
        }

        const portal =
          this.#portalRecords.get(endpointRecord.portalKey);
        if (!portal) return false;
        if (traversableOnly && !portal.traversable) return false;
        if (options.kind != null && portal.kind !== options.kind) {
          return false;
        }
        if (options.tag != null &&
            !portal.tags?.includes(options.tag)) {
          return false;
        }
        return true;
      },
      compareIds: (leftKey, rightKey) => {
        const left = this.#portalEndpointRecords.get(leftKey);
        const right = this.#portalEndpointRecords.get(rightKey);
        if (!left || !right) {
          return String(leftKey).localeCompare(String(rightKey));
        }
        return left.portalKey.localeCompare(right.portalKey) ||
          left.side.localeCompare(right.side);
      }
    });

    if (!match) return null;

    const endpointRecord =
      this.#portalEndpointRecords.get(match.id);
    if (!endpointRecord) return null;
    const portal =
      this.#portalRecords.get(endpointRecord.portalKey);
    if (!portal) return null;

    const endpoint =
      endpointRecord.side === "a" ? portal.a : portal.b;
    if (!endpoint || endpoint.domainId !== domainId) return null;

    return {
      portal,
      endpoint,
      side: endpointRecord.side,
      distance: match.distance
    };
  }

  getBoundariesForDomain(domainId, options = {}) {
    assertStringId(domainId, "getBoundariesForDomain.domainId");
    const enabledOnly = normalizeBoolean(
      options.enabledOnly,
      "getBoundariesForDomain.enabledOnly",
      { defaultValue: false }
    );
    assertOptionalString(options.kind, "getBoundariesForDomain.kind");
    assertOptionalString(options.tag, "getBoundariesForDomain.tag");
    const binding = this.#domainBindings.get(domainId);
    if (!binding) return [];
    const instance = this.#instances.get(binding.instanceId);
    if (!instance) return [];
    const definition = this.#definitions.get(instance.definitionId);

    const result = [];
    for (const boundary of definition.boundaries) {
      if (boundary.layerId !== binding.layerId) continue;
      const resolved = this.getBoundary(instance.id, boundary.id);
      if (enabledOnly && !resolved.enabled) continue;
      if (options.kind != null && resolved.kind !== options.kind) continue;
      if (options.tag != null && !resolved.tags?.includes(options.tag)) continue;
      result.push({ ...resolved, placeId: instance.id, domainId });
    }
    return result;
  }

  boundariesIntersectingBounds(domainId, bounds, options = {}) {
    assertBounds(bounds, "boundariesIntersectingBounds.bounds");
    return this.getBoundariesForDomain(domainId, options)
      .filter((boundary) => segmentIntersectsBounds(boundary.a, boundary.b, bounds));
  }

  findNearestBoundary(domainId, position, options = {}) {
    assertStringId(domainId, "findNearestBoundary.domainId");
    assertVec2(position, "findNearestBoundary.position");
    let best = null;
    let bestDistanceSq = Infinity;
    for (const boundary of this.getBoundariesForDomain(domainId, options)) {
      const distanceSq = squaredDistancePointToSegment(position, boundary.a, boundary.b);
      if (distanceSq < bestDistanceSq ||
          (distanceSq === bestDistanceSq && boundary.id.localeCompare(best?.id ?? "") < 0)) {
        best = boundary;
        bestDistanceSq = distanceSq;
      }
    }
    return best ? { boundary: best, distance: Math.sqrt(bestDistanceSq) } : null;
  }

  placesInBounds(domainId, bounds) {
    assertStringId(domainId, "placesInBounds.domainId");
    assertBounds(bounds, "placesInBounds.bounds");
    const index = this.#exteriorIndexes.get(domainId);
    if (!index) return [];
    const result = [];
    for (const instanceId of index.queryBounds(bounds)) {
      const instance = this.#instances.get(instanceId);
      if (!instance) continue;
      result.push(instance);
    }
    result.sort((a, b) => typedIdKey(a.id).localeCompare(typedIdKey(b.id)));
    return result;
  }

  createPlace(input) {
    assertPlainObject(input, "place input");

    const allowedInputKeys = new Set([
      "id",
      "definitionId",
      "parentId",
      "layerDomains",
      "attachments",
      "placement",
      "memberships",
      "metadata"
    ]);
    for (const key of Object.keys(input)) {
      if (!allowedInputKeys.has(key)) {
        throw new Error(`place input contains unknown field ${key}`);
      }
    }

    assertId(input.id, "place instance id");
    assertStringId(input.definitionId, "definitionId");
    if (this.#instances.has(input.id)) {
      throw new Error(
        `place instance already exists: ${String(input.id)}`
      );
    }

    const definition = this.#definitions.get(input.definitionId);
    if (!definition) {
      throw new Error(
        `unknown place definition: ${input.definitionId}`
      );
    }

    if (input.parentId != null) {
      assertId(input.parentId, "parentId");
      if (!this.#instances.has(input.parentId)) {
        throw new Error(
          `unknown parent place: ${String(input.parentId)}`
        );
      }
      if (input.parentId === input.id) {
        throw new Error("place cannot parent itself");
      }
    }

    const suppliedLayerDomains = input.layerDomains == null
      ? {}
      : assertPlainObject(input.layerDomains, "layerDomains");
    const knownLayerIds = new Set(
      definition.layers.map((layer) => layer.id)
    );
    for (const layerId of Object.keys(suppliedLayerDomains)) {
      if (!knownLayerIds.has(layerId)) {
        throw new Error(
          `layerDomains contains unknown layer ${layerId}`
        );
      }
    }

    const layerDomains = new Map();
    const claimedDomains = new Map();
    for (const layer of definition.layers) {
      const domainId =
        suppliedLayerDomains[layer.id] ??
        defaultLayerDomainId(input.id, layer.id);
      assertStringId(domainId, `layerDomains.${layer.id}`);

      const claimedBy = claimedDomains.get(domainId);
      if (claimedBy != null) {
        throw new Error(
          `domain ${domainId} is assigned to multiple layers: ${claimedBy}, ${layer.id}`
        );
      }
      claimedDomains.set(domainId, layer.id);

      const existing = this.#domainBindings.get(domainId);
      if (existing) {
        throw new Error(
          `domain ${domainId} is already bound to ${String(existing.instanceId)}:${existing.layerId}`
        );
      }
      layerDomains.set(layer.id, domainId);
    }

    const attachmentsInput = input.attachments == null
      ? {}
      : assertPlainObject(input.attachments, "attachments");
    const attachments = new Map();
    for (const [slot, value] of Object.entries(attachmentsInput)) {
      assertStringId(slot, "attachment slot");
      attachments.set(
        slot,
        normalizeAttachment(value, `attachment.${slot}`)
      );
    }
    const membershipInputs = input.memberships ?? [];
    if (!Array.isArray(membershipInputs)) {
      throw new TypeError(
        "memberships must be an array"
      );
    }

    const memberships = [];
    const membershipKeys = new Set();
    for (let i = 0; i < membershipInputs.length; i += 1) {
      const membership = normalizeMembership(
        membershipInputs[i],
        `memberships[${i}]`
      );
      if (membership.parentPlaceId === input.id) {
        throw new Error(
          "place cannot have a semantic membership to itself"
        );
      }
      if (!this.#instances.has(membership.parentPlaceId)) {
        throw new Error(
          `unknown membership parent place: ${String(membership.parentPlaceId)}`
        );
      }

      const key = membershipKey(
        membership.parentPlaceId,
        membership.kind
      );
      if (membershipKeys.has(key)) {
        throw new Error(
          `duplicate semantic membership ${membership.kind} -> ${String(membership.parentPlaceId)}`
        );
      }
      membershipKeys.add(key);
      memberships.push(membership);
    }

    const placement = normalizePlacement(input.placement);
    if (placement?.parentPlaceId != null) {
      if (placement.parentPlaceId === input.id) throw new Error("place cannot be placed relative to itself");
      if (!this.#instances.has(placement.parentPlaceId)) {
        throw new Error(`unknown placement parent: ${String(placement.parentPlaceId)}`);
      }
    }

    const instance = new PlaceInstance({
      id: input.id,
      definitionId: definition.id,
      parentId: input.parentId ?? null,
      layerDomains,
      attachments,
      placement,
      memberships,
      metadata: input.metadata
    });

    this.#instances.set(instance.id, instance);
    this.#registerSemanticDependency(instance);
    this.#registerMembershipDependencies(instance);
    this.#registerPlacementDependency(instance);
    for (const [layerId, domainId] of layerDomains) {
      this.#domainBindings.set(domainId, { instanceId: instance.id, layerId });
    }
    this.#indexExterior(instance, definition);
    this.#reindexInstancePortals(instance, definition);

    let materialized = false;
    let materializationReceipt = null;
    try {
      for (const portal of definition.portals) {
        validateResolvedPortalRoadBindings(
          instance,
          definition,
          this.resolvePortal(instance.id, portal.id),
          `portal ${portal.id}`
        );
      }

      if (this.#bridge?.materializePlace) {
        materializationReceipt =
          this.#bridge.materializePlace(instance, definition);
        materialized = true;
      }
      for (const boundary of definition.boundaries) {
        this.#bridge?.syncBoundaryState?.(instance, boundary);
      }
      for (const portal of definition.portals) {
        this.#bridge?.syncPortalState?.(
          instance,
          portal,
          this.resolvePortal(instance.id, portal.id)
        );
      }
    } catch (error) {
      let rollbackError = null;
      if (materialized) {
        try {
          if (materializationReceipt != null &&
              typeof this.#bridge?.rollbackMaterializePlace === "function") {
            this.#bridge.rollbackMaterializePlace(
              instance,
              definition,
              materializationReceipt
            );
          } else {
            this.#bridge?.unmaterializePlace?.(instance, definition);
          }
        } catch (cleanupError) {
          rollbackError = cleanupError;
        }
      }
      this.#removePlaceInternal(instance.id, false, {
        touchRevision: false,
        emitEvent: false
      });
      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to create place ${String(instance.id)} and rollback bridge state`
        );
      }
      throw error;
    }

    this.#touchState({ travel: true });
    this.#refreshTrackedOccupancy(
      this.#collectTrackedEntitiesForIndexedPlaces([instance.id])
    );
    this.emit("place-created", { placeId: instance.id, definitionId: definition.id });
    return instance;
  }

  removePlace(instanceId) {
    return this.#removePlaceInternal(instanceId, true);
  }

  #removePlaceInternal(
    instanceId,
    callBridge,
    { touchRevision = true, emitEvent = true } = {}
  ) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return false;
    const semanticChildren = this.#semanticChildren.get(instanceId);
    if (semanticChildren?.size) {
      const childId = [...semanticChildren][0];
      throw new Error(
        `cannot remove place ${String(instanceId)} while child ${String(childId)} exists`
      );
    }

    const membershipChildren =
      this.#membershipChildren.get(instanceId);
    if (membershipChildren?.size) {
      const childId = [...membershipChildren.keys()][0];
      throw new Error(
        `cannot remove place ${String(instanceId)} while semantic membership child ${String(childId)} exists`
      );
    }

    const placementChildren = this.#placementChildren.get(instanceId);
    if (placementChildren?.size) {
      throw new Error(`cannot remove place ${String(instanceId)} while relative placements depend on it`);
    }
    const definition = this.#definitions.get(instance.definitionId);
    if (callBridge && this.#entitiesByPlace.get(instanceId)?.size) {
      throw new Error(`cannot remove occupied place ${String(instanceId)}`);
    }
    if (callBridge) this.#bridge?.unmaterializePlace?.(instance, definition);
    this.clearEntityOccupancyForPlace(instanceId);
    for (const domainId of instance.layerDomains.values()) this.#domainBindings.delete(domainId);
    this.#unindexExterior(instance);
    this.#unregisterSemanticDependency(instance);
    this.#unregisterMembershipDependencies(instance);
    this.#unregisterPlacementDependency(instance);
    this.#removeInstancePortals(instance.id);
    this.#instances.delete(instance.id);
    if (touchRevision) this.#touchState({ travel: true });
    if (emitEvent) {
      this.emit("place-removed", {
        placeId: instanceId,
        definitionId: instance.definitionId
      });
    }
    return true;
  }

  getDomainBinding(domainId) { return this.#domainBindings.get(domainId) ?? null; }
  domainForLayer(instanceId, layerId) {
    return this.#instances.get(instanceId)?.layerDomains.get(layerId) ?? null;
  }

  resolveEndpoint(instanceId, endpoint) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    if (endpoint.kind === "local") {
      const domainId = instance.layerDomains.get(endpoint.layerId);
      if (!domainId) throw new Error(`place ${String(instanceId)} has no domain for layer ${endpoint.layerId}`);
      return {
        domainId,
        position: endpoint.position,
        nodeId: endpoint.nodeId,
        placeId: instanceId,
        spaceId: endpoint.spaceId,
        layerId: endpoint.layerId,
        metadata: endpoint.metadata ?? null
      };
    }
    if (endpoint.kind === "external") {
      const attachment = instance.attachments.get(endpoint.slot);
      if (!attachment) return null;
      return {
        ...attachment,
        layerId: null
      };
    }
    if (endpoint.kind === "resolved") return endpoint;
    throw new TypeError(`unsupported endpoint kind: ${endpoint.kind}`);
  }

  resolvePortal(instanceId, portalId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return null;
    const definition = this.#definitions.get(instance.definitionId);
    const dynamic = instance.dynamicPortals.get(portalId);
    const source = dynamic ?? definition.getPortal(portalId);
    if (!source) return null;
    const override = dynamic ? null : instance.getPortalOverride(portalId);
    const merged = override ? { ...source, ...override } : source;
    const a = this.resolveEndpoint(instanceId, merged.a);
    const b = this.resolveEndpoint(instanceId, merged.b);
    const connected = Boolean(a && b);
    const resolved = {
      ...merged,
      instanceId,
      definitionId: definition.id,
      a,
      b,
      connected,
      source: dynamic ? "dynamic" : "definition"
    };
    return {
      ...resolved,
      traversable: portalTraversableState(resolved)
    };
  }

  setBoundaryState(instanceId, boundaryId, patch) {
    assertPatchKeys(
      patch,
      ["enabled"],
      "boundary state patch"
    );
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    const definition = this.#definitions.get(instance.definitionId);
    const boundary = definition.getBoundary(boundaryId);
    if (!boundary) throw new Error(`unknown boundary ${boundaryId} on place ${String(instanceId)}`);
    const currentEnabled = instance.getBoundaryOverride(boundaryId)?.enabled ?? boundary.enabled;
    const enabled = normalizeBoolean(
      patch.enabled,
      `boundary(${boundaryId}).enabled`,
      { defaultValue: currentEnabled }
    );
    const resolved = { ...boundary, enabled };
    if (enabled === currentEnabled) return resolved;

    const previousOverride = instance.getBoundaryOverride(boundaryId);
    const previousResolved = { ...boundary, enabled: currentEnabled };
    instance.setBoundaryOverride(
      boundaryId,
      enabled === boundary.enabled ? null : { enabled }
    );

    try {
      this.#bridge?.syncBoundaryState?.(instance, resolved);
    } catch (error) {
      instance.setBoundaryOverride(boundaryId, previousOverride);
      let rollbackError = null;
      try {
        this.#bridge?.syncBoundaryState?.(instance, previousResolved);
      } catch (restoreError) {
        rollbackError = restoreError;
      }
      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to update boundary ${boundaryId} and restore bridge state`
        );
      }
      throw error;
    }

    this.#touchState({ travel: boundary.roadBindings?.length > 0 });
    this.emit("boundary-state-changed", {
      placeId: instanceId,
      boundaryId,
      enabled
    });
    return resolved;
  }

  setSpaceState(instanceId, spaceId, patch) {
    assertPatchKeys(
      patch,
      ["enabled"],
      "space state patch"
    );
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    const definition = this.#definitions.get(instance.definitionId);
    const space = definition.getSpace(spaceId);
    if (!space) throw new Error(`unknown space ${spaceId} on place ${String(instanceId)}`);
    const affectedEntities = [...(this.#entitiesByPlace.get(instanceId) ?? [])];
    const baseEnabled = true;
    const currentEnabled = instance.getSpaceOverride(spaceId)?.enabled ?? baseEnabled;
    const enabled = normalizeBoolean(
      patch.enabled,
      `space(${spaceId}).enabled`,
      { defaultValue: currentEnabled }
    );
    if (enabled === currentEnabled) return { ...space, enabled };

    instance.setSpaceOverride(spaceId, enabled === baseEnabled ? null : { enabled });
    this.#touchState({ travel: true });
    this.#refreshTrackedOccupancy(affectedEntities);
    this.emit("space-state-changed", { placeId: instanceId, spaceId, enabled });
    return { ...space, enabled };
  }

  setAttachment(instanceId, slot, value) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    assertStringId(slot, "attachment slot");
    const definition = this.#definitions.get(instance.definitionId);
    const nextAttachment = normalizeAttachment(value, `attachment.${slot}`);
    const previousAttachment = instance.attachments.get(slot) ?? null;
    if (attachmentEqual(previousAttachment, nextAttachment)) return previousAttachment;

    const referencedByPortal = definition.portals.some((portal) =>
      [portal.a, portal.b].some((endpoint) =>
        endpoint.kind === "external" && endpoint.slot === slot
      )
    );

    instance.attachments.set(slot, nextAttachment);
    try {
      for (const portal of definition.portals) {
        if (![portal.a, portal.b].some((endpoint) =>
          endpoint.kind === "external" && endpoint.slot === slot
        )) continue;
        validateResolvedPortalRoadBindings(
          instance,
          definition,
          this.resolvePortal(instanceId, portal.id),
          `portal ${portal.id}`
        );
      }
    } catch (error) {
      if (previousAttachment) instance.attachments.set(slot, previousAttachment);
      else instance.attachments.delete(slot);
      throw error;
    }

    const affectedPortals = definition.portals.filter((portal) =>
      [portal.a, portal.b].some((endpoint) =>
        endpoint.kind === "external" && endpoint.slot === slot
      )
    );

    this.#reindexInstancePortals(instance, definition);
    try {
      for (const portal of affectedPortals) {
        this.#bridge?.syncPortalState?.(
          instance,
          portal,
          this.resolvePortal(instanceId, portal.id)
        );
      }
    } catch (error) {
      if (previousAttachment) instance.attachments.set(slot, previousAttachment);
      else instance.attachments.delete(slot);
      this.#reindexInstancePortals(instance, definition);

      let rollbackError = null;
      try {
        for (const portal of affectedPortals) {
          this.#bridge?.syncPortalState?.(
            instance,
            portal,
            this.resolvePortal(instanceId, portal.id)
          );
        }
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to update attachment ${slot} and restore bridge state`
        );
      }
      throw error;
    }

    this.#touchState({ travel: referencedByPortal });
    this.emit("place-attachment-changed", {
      placeId: instanceId,
      slot,
      attachment: cloneJson(instance.attachments.get(slot))
    });
    return instance.attachments.get(slot);
  }

  clearAttachment(instanceId, slot) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    assertStringId(slot, "attachment slot");
    if (!instance.attachments.has(slot)) return false;

    const definition = this.#definitions.get(instance.definitionId);
    const referencedByPortal = definition.portals.some((portal) =>
      [portal.a, portal.b].some((endpoint) =>
        endpoint.kind === "external" && endpoint.slot === slot
      )
    );
    const previousAttachment = instance.attachments.get(slot);
    const affectedPortals = definition.portals.filter((portal) =>
      [portal.a, portal.b].some((endpoint) =>
        endpoint.kind === "external" && endpoint.slot === slot
      )
    );

    instance.attachments.delete(slot);
    this.#reindexInstancePortals(instance, definition);

    try {
      for (const portal of affectedPortals) {
        this.#bridge?.syncPortalState?.(
          instance,
          portal,
          this.resolvePortal(instanceId, portal.id)
        );
      }
    } catch (error) {
      instance.attachments.set(slot, previousAttachment);
      this.#reindexInstancePortals(instance, definition);

      let rollbackError = null;
      try {
        for (const portal of affectedPortals) {
          this.#bridge?.syncPortalState?.(
            instance,
            portal,
            this.resolvePortal(instanceId, portal.id)
          );
        }
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to clear attachment ${slot} and restore bridge state`
        );
      }
      throw error;
    }

    this.#touchState({ travel: referencedByPortal });
    this.emit("place-attachment-changed", {
      placeId: instanceId,
      slot,
      attachment: null
    });
    return true;
  }

  setPlacement(instanceId, placement) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    const next = normalizePlacement(placement);
    if (placementEqual(instance.placement, next)) return instance.placement;
    if (next?.parentPlaceId != null) {
      if (!this.#instances.has(next.parentPlaceId)) {
        throw new Error(`unknown placement parent: ${String(next.parentPlaceId)}`);
      }
      this.#assertPlacementParentDoesNotCycle(instanceId, next.parentPlaceId);
    }

    const affected = this.#collectPlacementDescendants(instanceId);
    const affectedEntities = new Set(
      this.#collectTrackedEntitiesForIndexedPlaces(affected)
    );
    for (const id of affected) this.#unindexExterior(this.#instances.get(id));

    this.#unregisterPlacementDependency(instance);
    instance.placement = next;
    this.#registerPlacementDependency(instance);

    for (const id of affected) {
      const child = this.#instances.get(id);
      if (!child) continue;
      this.#indexExterior(child, this.#definitions.get(child.definitionId));
    }

    for (const entityId of this.#collectTrackedEntitiesForIndexedPlaces(affected)) {
      affectedEntities.add(entityId);
    }

    this.#touchState();
    this.#refreshTrackedOccupancy(affectedEntities);
    this.emit("place-placement-changed", {
      placeId: instanceId,
      placement: cloneJson(instance.placement),
      affectedPlaceCount: affected.length,
      affectedEntityCount: affectedEntities.size
    });
    return instance.placement;
  }

  getResolvedPlacement(instanceId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return null;
    return this.#resolvePlacement(instanceId);
  }

  setParent(instanceId, parentId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) {
      throw new Error(
        `unknown place instance: ${String(instanceId)}`
      );
    }
    if (parentId != null) {
      assertId(parentId, "parentId");
      if (!this.#instances.has(parentId)) {
        throw new Error(
          `unknown parent place: ${String(parentId)}`
        );
      }
    }
    if (parentId === instanceId) {
      throw new Error("place cannot parent itself");
    }
    if (parentId != null) {
      this.#assertSemanticEdgeDoesNotCycle(
        instanceId,
        parentId
      );
    }
    if (instance.parentId === (parentId ?? null)) {
      return instance;
    }
    const affectedEntities = [...(this.#entitiesByPlace.get(instanceId) ?? [])];
    this.#unregisterSemanticDependency(instance);
    instance.parentId = parentId ?? null;
    this.#registerSemanticDependency(instance);
    this.#touchState();
    this.#refreshTrackedOccupancy(affectedEntities);
    this.emit("place-parent-changed", {
      placeId: instanceId,
      parentId: instance.parentId
    });
    return instance;
  }

  getMemberships(instanceId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return [];

    return instance.getMemberships()
      .slice()
      .sort((a, b) =>
        typedIdKey(a.parentPlaceId)
          .localeCompare(typedIdKey(b.parentPlaceId)) ||
        a.kind.localeCompare(b.kind)
      );
  }

  addMembership(instanceId, input) {
    const instance = this.#instances.get(instanceId);
    if (!instance) {
      throw new Error(
        `unknown place instance: ${String(instanceId)}`
      );
    }

    const membership = normalizeMembership(
      input,
      "membership"
    );
    if (!this.#instances.has(membership.parentPlaceId)) {
      throw new Error(
        `unknown membership parent place: ${String(membership.parentPlaceId)}`
      );
    }
    if (membership.parentPlaceId === instanceId) {
      throw new Error(
        "place cannot have a semantic membership to itself"
      );
    }

    if (instance.getMembership(
      membership.parentPlaceId,
      membership.kind
    )) {
      throw new Error(
        `semantic membership already exists: ${membership.kind} -> ${String(membership.parentPlaceId)}`
      );
    }

    this.#assertSemanticEdgeDoesNotCycle(
      instanceId,
      membership.parentPlaceId
    );

    const affectedEntities = [
      ...(this.#entitiesByPlace.get(instanceId) ?? [])
    ];

    instance.addMembership(membership);
    this.#registerMembershipDependency(
      instance.id,
      membership
    );

    this.#touchState();
    this.#refreshTrackedOccupancy(affectedEntities);
    this.emit("place-membership-added", {
      placeId: instanceId,
      membership
    });
    return membership;
  }

  removeMembership(
    instanceId,
    parentPlaceId,
    kind = "member-of"
  ) {
    assertId(parentPlaceId, "parentPlaceId");
    assertStringId(kind, "membership kind");

    const instance = this.#instances.get(instanceId);
    if (!instance) return false;

    const membership = instance.getMembership(
      parentPlaceId,
      kind
    );
    if (!membership) return false;

    const affectedEntities = [
      ...(this.#entitiesByPlace.get(instanceId) ?? [])
    ];

    instance.removeMembership(parentPlaceId, kind);
    this.#unregisterMembershipDependency(
      instance.id,
      membership
    );

    this.#touchState();
    this.#refreshTrackedOccupancy(affectedEntities);
    this.emit("place-membership-removed", {
      placeId: instanceId,
      membership
    });
    return true;
  }

  getSemanticAncestors(
    instanceId,
    { includeSelf = false } = {}
  ) {
    if (!this.#instances.has(instanceId)) return [];
    const closure = this.#semanticClosure([instanceId]);
    return includeSelf
      ? closure
      : closure.filter((id) => id !== instanceId);
  }

  setPortalState(instanceId, portalId, patch) {
    assertPatchKeys(
      patch,
      PORTAL_STATE_KEYS,
      "portal state patch"
    );
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    const definition = this.#definitions.get(instance.definitionId);
    const base = definition.getPortal(portalId);
    if (!base) {
      const dynamic = instance.dynamicPortals.get(portalId);
      if (!dynamic) throw new Error(`unknown portal ${portalId} on place ${String(instanceId)}`);
      const before = this.resolvePortal(instanceId, portalId);
      const prospectiveState = {};
      let changed = false;
      for (const key of PORTAL_STATE_KEYS) {
        const value = normalizeBoolean(
          patch[key],
          `dynamic portal(${portalId}).${key}`,
          { defaultValue: dynamic[key] }
        );
        prospectiveState[key] = value;
        if (value !== dynamic[key]) changed = true;
      }
      if (!changed) return before;

      const prospective = {
        ...before,
        ...prospectiveState
      };
      if (before.traversable !== portalTraversableState(prospective)) {
        validateResolvedPortalRoadBindings(
          instance,
          definition,
          prospective,
          `dynamic portal ${portalId}`
        );
      }

      const previousState = Object.fromEntries(
        PORTAL_STATE_KEYS.map((key) => [key, dynamic[key]])
      );
      for (const key of PORTAL_STATE_KEYS) {
        dynamic[key] = prospectiveState[key];
      }

      this.#reindexInstancePortals(instance, definition);
      const resolved = this.resolvePortal(instanceId, portalId);

      try {
        this.#bridge?.syncPortalState?.(instance, dynamic, resolved);
      } catch (error) {
        for (const key of PORTAL_STATE_KEYS) {
          dynamic[key] = previousState[key];
        }
        this.#reindexInstancePortals(instance, definition);

        let rollbackError = null;
        try {
          this.#bridge?.syncPortalState?.(instance, dynamic, before);
        } catch (restoreError) {
          rollbackError = restoreError;
        }

        if (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `failed to update dynamic portal ${portalId} and restore bridge state`
          );
        }
        throw error;
      }

      this.#touchState({
        travel: before.traversable !== resolved.traversable
      });
      this.emit("portal-state-changed", {
        placeId: instanceId,
        portalId,
        state: cloneState(resolved)
      });
      return resolved;
    }

    const current = { ...base, ...(instance.getPortalOverride(portalId) ?? {}) };
    let changed = false;
    const next = {};
    for (const key of PORTAL_STATE_KEYS) {
      const value = normalizeBoolean(
        patch[key],
        `portal(${portalId}).${key}`,
        { defaultValue: current[key] }
      );
      if (value !== current[key]) changed = true;
      if (value !== base[key]) next[key] = value;
    }
    if (!changed) return this.resolvePortal(instanceId, portalId);

    const before = this.resolvePortal(instanceId, portalId);
    const prospective = {
      ...before,
      ...Object.fromEntries(
        PORTAL_STATE_KEYS.map((key) => [
          key,
          normalizeBoolean(
            patch[key],
            `portal(${portalId}).${key}`,
            { defaultValue: current[key] }
          )
        ])
      )
    };
    if (before.traversable !== portalTraversableState(prospective)) {
      validateResolvedPortalRoadBindings(
        instance,
        definition,
        prospective,
        `portal ${portalId}`
      );
    }

    const previousOverride = instance.getPortalOverride(portalId);
    instance.setPortalOverride(portalId, next);
    this.#reindexInstancePortals(instance, definition);
    const resolved = this.resolvePortal(instanceId, portalId);

    try {
      this.#bridge?.syncPortalState?.(instance, base, resolved);
    } catch (error) {
      instance.setPortalOverride(portalId, previousOverride);
      this.#reindexInstancePortals(instance, definition);

      let rollbackError = null;
      try {
        this.#bridge?.syncPortalState?.(instance, base, before);
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to update portal ${portalId} and restore bridge state`
        );
      }
      throw error;
    }

    this.#touchState({
      travel: before.traversable !== resolved.traversable
    });
    this.emit("portal-state-changed", {
      placeId: instanceId,
      portalId,
      state: cloneState(resolved)
    });
    return resolved;
  }

  addInstancePortal(instanceId, spec) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    assertStringId(spec?.id, "dynamic portal id");
    const definition = this.#definitions.get(instance.definitionId);
    if (definition.getPortal(spec.id) || instance.dynamicPortals.has(spec.id)) throw new Error(`portal already exists: ${spec.id}`);
    const normalizeResolved = (endpoint, label) => {
      if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
        throw new TypeError(`${label} must be an endpoint object`);
      }
      assertStringId(endpoint.domainId, `${label}.domainId`);
      if (!endpoint.position ||
          !Number.isFinite(endpoint.position.x) ||
          !Number.isFinite(endpoint.position.y)) {
        throw new TypeError(`${label}.position must be a Vec2`);
      }
      if (endpoint.nodeId != null) {
        assertStringId(endpoint.nodeId, `${label}.nodeId`);
      }
      if (endpoint.placeId != null) {
        assertId(endpoint.placeId, `${label}.placeId`);
      }
      if (endpoint.spaceId != null) {
        assertStringId(endpoint.spaceId, `${label}.spaceId`);
      }
      if (endpoint.layerId != null) {
        assertStringId(endpoint.layerId, `${label}.layerId`);
      }

      return deepFreeze({
        kind: "resolved",
        domainId: endpoint.domainId,
        position: { x: endpoint.position.x, y: endpoint.position.y },
        nodeId: endpoint.nodeId ?? null,
        placeId: endpoint.placeId ?? null,
        spaceId: endpoint.spaceId ?? null,
        layerId: endpoint.layerId ?? null,
        metadata: cloneJson(endpoint.metadata ?? null)
      });
    };
    const transitionCost = spec.transitionCost ?? 0;
    if (!Number.isFinite(transitionCost) || transitionCost < 0) {
      throw new RangeError(
        `dynamic portal ${spec.id} transitionCost must be a finite number >= 0`
      );
    }

    const kind = spec.kind ?? "portal";
    assertStringId(kind, `dynamic portal ${spec.id}.kind`);

    const portal = {
      id: spec.id,
      kind,
      tags: normalizeStringList(
        spec.tags,
        `dynamic portal ${spec.id}.tags`,
        { defaultValue: [] }
      ),
      a: normalizeResolved(spec.a, "portal.a"),
      b: normalizeResolved(spec.b, "portal.b"),
      bidirectional: normalizeBoolean(
        spec.bidirectional,
        `dynamic portal ${spec.id}.bidirectional`,
        { defaultValue: true }
      ),
      transitionCost,
      enabled: normalizeBoolean(
        spec.enabled,
        `dynamic portal ${spec.id}.enabled`,
        { defaultValue: true }
      ),
      open: normalizeBoolean(
        spec.open,
        `dynamic portal ${spec.id}.open`,
        { defaultValue: true }
      ),
      locked: normalizeBoolean(
        spec.locked,
        `dynamic portal ${spec.id}.locked`,
        { defaultValue: false }
      ),
      blocked: normalizeBoolean(
        spec.blocked,
        `dynamic portal ${spec.id}.blocked`,
        { defaultValue: false }
      ),
      destroyed: normalizeBoolean(
        spec.destroyed,
        `dynamic portal ${spec.id}.destroyed`,
        { defaultValue: false }
      ),
      blocksWhenClosed: normalizeBoolean(
        spec.blocksWhenClosed,
        `dynamic portal ${spec.id}.blocksWhenClosed`,
        { defaultValue: false }
      ),
      roadBindings: (spec.roadBindings ?? []).map((binding, index) => {
        assertStringId(binding.layerId, `dynamic portal roadBindings[${index}].layerId`);
        assertStringId(binding.roadId, `dynamic portal roadBindings[${index}].roadId`);
        if (!instance.layerDomains.has(binding.layerId)) throw new Error(`dynamic portal road binding references unknown layer ${binding.layerId}`);
        return { layerId: binding.layerId, roadId: binding.roadId };
      }),
      metadata: cloneJson(spec.metadata ?? null)
    };
    const resolvedPortal = {
      ...portal,
      connected: true,
      traversable: portalTraversableState(portal)
    };
    validateResolvedPortalRoadBindings(
      instance,
      definition,
      resolvedPortal,
      `dynamic portal ${portal.id}`
    );

    instance.addDynamicPortal(portal);
    this.#reindexInstancePortals(instance, definition);
    const resolved = this.resolvePortal(instanceId, portal.id);

    try {
      this.#bridge?.syncDynamicPortal?.(instance, portal, resolved);
    } catch (error) {
      let rollbackError = null;
      try {
        this.#bridge?.removeDynamicPortal?.(instance, resolved);
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      instance.removeDynamicPortal(portal.id);
      this.#reindexInstancePortals(instance, definition);

      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to add dynamic portal ${portal.id} and restore bridge state`
        );
      }
      throw error;
    }

    this.#touchState({ travel: true });
    this.emit("portal-added", {
      placeId: instanceId,
      portalId: portal.id
    });
    return resolved;
  }

  removeInstancePortal(instanceId, portalId) {
    const instance = this.#instances.get(instanceId);
    if (!instance || !instance.dynamicPortals.has(portalId)) return false;
    const resolved = this.resolvePortal(instanceId, portalId);
    const dynamic = instance.dynamicPortals.get(portalId);

    try {
      this.#bridge?.removeDynamicPortal?.(instance, resolved);
    } catch (error) {
      let rollbackError = null;
      try {
        this.#bridge?.syncDynamicPortal?.(instance, dynamic, resolved);
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to remove dynamic portal ${portalId} and restore bridge state`
        );
      }
      throw error;
    }

    instance.removeDynamicPortal(portalId);
    const definition = this.#definitions.get(instance.definitionId);
    this.#reindexInstancePortals(instance, definition);
    this.#touchState({ travel: true });
    this.emit("portal-removed", {
      placeId: instanceId,
      portalId
    });
    return true;
  }

  getPortalsForDomain(domainId) {
    const keys = this.#portalsByDomain.get(domainId);
    if (!keys) return [];
    return [...keys].map((key) => this.#portalRecords.get(key)).filter(Boolean);
  }

  getPortalsForRoad(domainId, roadId) {
    const keys = this.#portalsByRoad.get(domainId)?.get(roadId);
    if (!keys) return [];
    return [...keys]
      .sort()
      .map((key) => this.#portalRecords.get(key))
      .filter(Boolean);
  }

  getPortalRecord(key) { return this.#portalRecords.get(key) ?? null; }

  locate(domainId, position) {
    assertStringId(domainId, "locate.domainId");
    assertVec2(position, "locate.position");
    const places = [];
    const spaces = [];
    const seenPlaces = new Set();

    const binding = this.#domainBindings.get(domainId);
    if (binding) {
      const instance = this.#instances.get(binding.instanceId);
      if (instance) {
        const definition = this.#definitions.get(instance.definitionId);
        for (const id of this.#placeChain(instance.id)) {
          if (!seenPlaces.has(id)) {
            places.push(id);
            seenPlaces.add(id);
          }
        }
        for (const space of definition.locateSpaces(binding.layerId, position)) {
          if (!this.#spaceEnabled(instance, definition, space)) continue;
          spaces.push({ placeId: instance.id, spaceId: space.id, layerId: binding.layerId, kind: space.kind });
        }
      }
    }

    const exteriorIndex = this.#exteriorIndexes.get(domainId);
    if (exteriorIndex) {
      for (const instanceId of exteriorIndex.queryPoint(position)) {
        const instance = this.#instances.get(instanceId);
        if (!instance?.placement || instance.placement.containment !== "footprint") continue;
        const definition = this.#definitions.get(instance.definitionId);
        if (!definition.footprint) continue;
        const resolvedPlacement = this.#resolvePlacement(instance.id);
        if (!resolvedPlacement || resolvedPlacement.domainId !== domainId) continue;
        const local = inverseTransformPoint(position, resolvedPlacement.transform);
        if (!pointInGeometry(local, definition.footprint)) continue;
        for (const id of this.#placeChain(instance.id)) {
          if (!seenPlaces.has(id)) {
            places.push(id);
            seenPlaces.add(id);
          }
        }
      }
    }

    return deepFreeze({
      domainId,
      position: { x: position.x, y: position.y },
      places,
      spaces
    });
  }

  locateEntity(entity) {
    if (!entity) throw new TypeError("entity is required");
    return this.locate(entity.domainId ?? "default", entity.position);
  }

  syncEntityOccupancy(entity) {
    assertId(entity?.id, "entity.id");
    const next = this.locateEntity(entity);
    const previous = this.#occupancy.get(entity.id) ?? null;

    if (previous && this.#sameLocation(previous, next)) {
      this.#unindexOccupancyPoint(entity.id, previous);
      this.#occupancy.set(entity.id, next);
      this.#indexOccupancyPoint(entity.id, next);
      return next;
    }

    if (previous) {
      this.#removeOccupancy(entity.id, previous);
      this.#unindexOccupancyPoint(entity.id, previous);
    }

    this.#occupancy.set(entity.id, next);
    this.#addOccupancy(entity.id, next);
    this.#indexOccupancyPoint(entity.id, next);
    this.#emitLocationTransitions(entity.id, previous, next);
    return next;
  }

  removeEntityOccupancy(entityId) {
    const previous = this.#occupancy.get(entityId);
    if (!previous) return false;
    this.#removeOccupancy(entityId, previous);
    this.#unindexOccupancyPoint(entityId, previous);
    this.#occupancy.delete(entityId);
    this.#emitLocationTransitions(entityId, previous, null);
    return true;
  }

  getEntityLocation(entityId) { return this.#occupancy.get(entityId) ?? null; }
  entitiesInPlace(instanceId) { return new Set(this.#entitiesByPlace.get(instanceId) ?? []); }
  entitiesInSpace(instanceId, spaceId) { return new Set(this.#entitiesBySpace.get(makeSpaceKey(instanceId, spaceId)) ?? []); }

  clearEntityOccupancyForPlace(instanceId) {
    const entities = [...(this.#entitiesByPlace.get(instanceId) ?? [])];
    for (const entityId of entities) this.removeEntityOccupancy(entityId);
  }

  emit(type, data = {}) {
    if (!this.#captureEvents) return null;
    const event = deepFreeze({ sequence: ++this.#sequence, type, ...cloneJson(data) });
    this.#events.push(event);
    return event;
  }

  setEventCapture(enabled) {
    this.#captureEvents = normalizeBoolean(enabled, "event capture");
  }
  drainEvents(target = []) { return this.#events.drain(target); }
  peekEvents() { return this.#events.peek(); }
  getEventQueueStats() {
    return { size: this.#events.size, limit: this.#events.limit, overflowPolicy: this.#events.overflowPolicy, dropped: this.#events.dropped };
  }

  getDiagnostics() {
    let portalOverrideCount = 0;
    let boundaryOverrideCount = 0;
    let spaceOverrideCount = 0;
    let dynamicPortalCount = 0;
    for (const instance of this.#instances.values()) {
      portalOverrideCount += instance.portalOverrides.size;
      boundaryOverrideCount += instance.boundaryOverrides.size;
      spaceOverrideCount += instance.spaceOverrides.size;
      dynamicPortalCount += instance.dynamicPortals.size;
    }
    let footprintIndexCells = 0;
    for (const index of this.#exteriorIndexes.values()) {
      footprintIndexCells += index.cellCount;
    }

    let portalRoadBindingCount = 0;
    for (const roads of this.#portalsByRoad.values()) {
      for (const portalKeys of roads.values()) {
        portalRoadBindingCount += portalKeys.size;
      }
    }

    let traversablePortalEndpointCount = 0;
    for (const index of this.#traversablePortalEndpointIndexes.values()) {
      traversablePortalEndpointCount += index.size;
    }

    return {
      definitionCount: this.#definitions.size,
      instanceCount: this.#instances.size,
      domainBindingCount: this.#domainBindings.size,
      portalRecordCount: this.#portalRecords.size,
      portalEndpointCount: this.#portalEndpointRecords.size,
      portalEndpointDomainCount: this.#portalEndpointIndexes.size,
      traversablePortalEndpointCount,
      traversablePortalEndpointDomainCount:
        this.#traversablePortalEndpointIndexes.size,
      portalRoadBindingCount,
      portalRoadDomainCount: this.#portalsByRoad.size,
      portalOverrideCount,
      boundaryOverrideCount,
      spaceOverrideCount,
      dynamicPortalCount,
      occupiedEntityCount: this.#occupancy.size,
      occupancySpatialDomainCount: this.#occupancySpatialIndexes.size,
      stateRevision: this.#stateRevision,
      travelRevision: this.#travelRevision,
      graphRevision: this.#travelRevision,
      footprintIndexCells,
      eventQueueSize: this.#events.size,
      droppedEventCount: this.#events.dropped
    };
  }

  assertInternalConsistency() {
    for (const [domainId, binding] of this.#domainBindings) {
      const instance = this.#instances.get(binding.instanceId);
      if (!instance) throw new Error(`domain ${domainId} references missing instance`);
      if (instance.layerDomains.get(binding.layerId) !== domainId) throw new Error(`domain ${domainId} binding mismatch`);
    }
    for (const instance of this.#instances.values()) {
      const definition = this.#definitions.get(instance.definitionId);
      if (!definition) throw new Error(`instance ${String(instance.id)} references missing definition`);
      if (instance.parentId != null) {
        if (!this.#instances.has(instance.parentId)) throw new Error(`instance ${String(instance.id)} references missing parent`);
        if (!this.#semanticChildren.get(instance.parentId)?.has(instance.id)) {
          throw new Error(`instance ${String(instance.id)} missing semantic dependency index`);
        }
      }
      if (instance.placement?.parentPlaceId != null) {
        if (!this.#instances.has(instance.placement.parentPlaceId)) {
          throw new Error(`instance ${String(instance.id)} references missing placement parent`);
        }
        this.#assertPlacementParentDoesNotCycle(instance.id, instance.placement.parentPlaceId);
        if (!this.#placementChildren.get(instance.placement.parentPlaceId)?.has(instance.id)) {
          throw new Error(`instance ${String(instance.id)} missing placement dependency index`);
        }
      }
      const visited = new Set();
      let current = instance;
      while (current?.parentId != null) {
        if (visited.has(current.id)) throw new Error(`place parent cycle involving ${String(current.id)}`);
        visited.add(current.id);
        current = this.#instances.get(current.parentId);
      }
    }
    for (const [key, record] of this.#portalRecords) {
      if (!this.#instances.has(record.instanceId)) throw new Error(`portal record ${key} references missing instance`);
      if (!record.connected || !record.a || !record.b) throw new Error(`portal record ${key} is disconnected`);
      const instance = this.#instances.get(record.instanceId);
      for (const binding of record.roadBindings ?? []) {
        const domainId = instance?.layerDomains.get(binding.layerId);
        if (!domainId ||
            !this.#portalsByRoad.get(domainId)?.get(binding.roadId)?.has(key)) {
          throw new Error(
            `portal record ${key} missing road binding index for ${binding.roadId}`
          );
        }
      }
      for (const [side, endpoint] of [["a", record.a], ["b", record.b]]) {
        const domainId = endpoint.domainId;
        if (!this.#portalsByDomain.get(domainId)?.has(key)) {
          throw new Error(`portal record ${key} missing domain adjacency`);
        }
        const endpointKey = `${key}\u0000${side}`;
        const endpointRecord = this.#portalEndpointRecords.get(endpointKey);
        if (!endpointRecord ||
            endpointRecord.portalKey !== key ||
            endpointRecord.domainId !== domainId ||
            endpointRecord.side !== side) {
          throw new Error(`portal record ${key} missing endpoint spatial record`);
        }
        if (!this.#portalEndpointIndexes.get(domainId)?.getPoint(endpointKey)) {
          throw new Error(
            `portal record ${key} missing endpoint spatial index entry`
          );
        }

        const traversablePoint =
          this.#traversablePortalEndpointIndexes
            .get(domainId)
            ?.getPoint(endpointKey) ??
          null;
        if (record.traversable && !traversablePoint) {
          throw new Error(
            `traversable portal record ${key} missing traversable endpoint index entry`
          );
        }
        if (!record.traversable && traversablePoint) {
          throw new Error(
            `blocked portal record ${key} leaked into traversable endpoint index`
          );
        }
      }
    }
    if (this.#portalEndpointRecords.size !== this.#portalRecords.size * 2) {
      throw new Error("portal endpoint spatial record count drift");
    }

    let traversableEndpointCount = 0;
    for (const index of this.#traversablePortalEndpointIndexes.values()) {
      traversableEndpointCount += index.size;
    }
    let expectedTraversableEndpointCount = 0;
    for (const record of this.#portalRecords.values()) {
      if (record.traversable) expectedTraversableEndpointCount += 2;
    }
    if (traversableEndpointCount !== expectedTraversableEndpointCount) {
      throw new Error("traversable portal endpoint index count drift");
    }
    return this.getDiagnostics();
  }

  #spaceEnabled(instance, definition, space) {
    let current = space;
    while (current) {
      if (instance.getSpaceOverride(current.id)?.enabled === false) return false;
      current = current.parentSpaceId == null ? null : definition.getSpace(current.parentSpaceId);
    }
    return true;
  }

  #indexExterior(instance, definition) {
    if (!instance?.placement || instance.placement.containment !== "footprint" || !definition?.footprint) return;
    const resolved = this.#resolvePlacement(instance.id);
    if (!resolved) return;
    const localBounds = geometryBounds(definition.footprint);
    const bounds = transformBounds(localBounds, resolved.transform);
    let index = this.#exteriorIndexes.get(resolved.domainId);
    if (!index) this.#exteriorIndexes.set(resolved.domainId, index = new DynamicAabbIndex());
    index.set(instance.id, bounds);
    this.#indexedExteriorDomains.set(instance.id, resolved.domainId);
  }

  #unindexExterior(instance) {
    if (!instance) return;
    const domainId = this.#indexedExteriorDomains.get(instance.id);
    if (domainId == null) return;
    const index = this.#exteriorIndexes.get(domainId);
    if (index) {
      index.delete(instance.id);
      if (index.size === 0) this.#exteriorIndexes.delete(domainId);
    }
    this.#indexedExteriorDomains.delete(instance.id);
  }

  #registerSemanticDependency(instance) {
    const parentId = instance?.parentId;
    if (parentId == null) return;
    let children = this.#semanticChildren.get(parentId);
    if (!children) this.#semanticChildren.set(parentId, children = new Set());
    children.add(instance.id);
  }

  #unregisterSemanticDependency(instance) {
    const parentId = instance?.parentId;
    if (parentId == null) return;
    const children = this.#semanticChildren.get(parentId);
    children?.delete(instance.id);
    if (children?.size === 0) {
      this.#semanticChildren.delete(parentId);
    }
  }

  #registerMembershipDependency(childId, membership) {
    let children = this.#membershipChildren.get(
      membership.parentPlaceId
    );
    if (!children) {
      this.#membershipChildren.set(
        membership.parentPlaceId,
        children = new Map()
      );
    }

    children.set(
      childId,
      (children.get(childId) ?? 0) + 1
    );
  }

  #unregisterMembershipDependency(childId, membership) {
    const children = this.#membershipChildren.get(
      membership.parentPlaceId
    );
    if (!children) return;

    const count = children.get(childId) ?? 0;
    if (count <= 1) {
      children.delete(childId);
    } else {
      children.set(childId, count - 1);
    }
    if (children.size === 0) {
      this.#membershipChildren.delete(
        membership.parentPlaceId
      );
    }
  }

  #registerMembershipDependencies(instance) {
    for (const membership of instance.getMemberships()) {
      this.#registerMembershipDependency(
        instance.id,
        membership
      );
    }
  }

  #unregisterMembershipDependencies(instance) {
    for (const membership of instance.getMemberships()) {
      this.#unregisterMembershipDependency(
        instance.id,
        membership
      );
    }
  }

  #semanticParentIds(instanceId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return [];

    const parents = new Map();
    if (instance.parentId != null) {
      parents.set(
        typedIdKey(instance.parentId),
        instance.parentId
      );
    }

    for (const membership of instance.getMemberships()) {
      parents.set(
        typedIdKey(membership.parentPlaceId),
        membership.parentPlaceId
      );
    }

    return [...parents.values()]
      .sort((a, b) =>
        typedIdKey(a).localeCompare(typedIdKey(b))
      );
  }

  #assertSemanticEdgeDoesNotCycle(instanceId, parentId) {
    const targetKey = typedIdKey(instanceId);
    const stack = [parentId];
    const visited = new Set();

    while (stack.length) {
      const currentId = stack.pop();
      const currentKey = typedIdKey(currentId);
      if (currentKey === targetKey) {
        throw new Error("place semantic membership cycle");
      }
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);

      const parents = this.#semanticParentIds(currentId);
      for (let i = parents.length - 1; i >= 0; i -= 1) {
        stack.push(parents[i]);
      }
    }
  }

  #semanticClosure(instanceIds) {
    const output = [];
    const permanent = new Set();
    const temporary = new Set();

    const visit = (instanceId) => {
      const key = typedIdKey(instanceId);
      if (permanent.has(key)) return;
      if (temporary.has(key)) {
        throw new Error("place semantic membership cycle");
      }

      const instance = this.#instances.get(instanceId);
      if (!instance) return;

      temporary.add(key);
      for (const parentId of this.#semanticParentIds(instanceId)) {
        visit(parentId);
      }
      temporary.delete(key);
      permanent.add(key);
      output.push(instanceId);
    };

    const roots = [...instanceIds]
      .sort((a, b) =>
        typedIdKey(a).localeCompare(typedIdKey(b))
      );
    for (const instanceId of roots) {
      visit(instanceId);
    }

    return output;
  }

  #registerPlacementDependency(instance) {
    const parentId = instance?.placement?.parentPlaceId;
    if (parentId == null) return;
    let children = this.#placementChildren.get(parentId);
    if (!children) this.#placementChildren.set(parentId, children = new Set());
    children.add(instance.id);
  }

  #unregisterPlacementDependency(instance) {
    const parentId = instance?.placement?.parentPlaceId;
    if (parentId == null) return;
    const children = this.#placementChildren.get(parentId);
    children?.delete(instance.id);
    if (children?.size === 0) this.#placementChildren.delete(parentId);
  }

  #collectPlacementDescendants(instanceId) {
    const result = [];
    const queue = [instanceId];
    const visited = new Set();
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      if (visited.has(id)) throw new Error("placement dependency cycle");
      visited.add(id);
      result.push(id);
      const children = this.#placementChildren.get(id);
      if (children) queue.push(...[...children].sort((a, b) => typedIdKey(a).localeCompare(typedIdKey(b))));
    }
    return result;
  }

  #assertPlacementParentDoesNotCycle(instanceId, parentId) {
    let cursorId = parentId;
    const visited = new Set([typedIdKey(instanceId)]);
    while (cursorId != null) {
      const key = typedIdKey(cursorId);
      if (visited.has(key)) throw new Error("place placement cycle");
      visited.add(key);
      const cursor = this.#instances.get(cursorId);
      cursorId = cursor?.placement?.parentPlaceId ?? null;
    }
  }

  #resolvePlacement(instanceId) {
    const chain = [];
    const visited = new Set();
    let current = this.#instances.get(instanceId);
    while (current?.placement) {
      const key = typedIdKey(current.id);
      if (visited.has(key)) throw new Error("place placement cycle");
      visited.add(key);
      chain.push(current.placement);
      if (current.placement.domainId != null) break;
      current = this.#instances.get(current.placement.parentPlaceId);
    }

    if (!chain.length || chain[chain.length - 1].domainId == null) return null;

    const root = chain.pop();
    let transform = root.transform;
    const domainId = root.domainId;
    while (chain.length) {
      const child = chain.pop();
      transform = composeTransforms(transform, child.transform);
    }

    return deepFreeze({
      domainId,
      transform,
      containment: this.#instances.get(instanceId)?.placement?.containment ?? "none"
    });
  }

  #portalKey(instanceId, portalId) { return `${typedIdKey(instanceId)}\u0000${portalId}`; }

  #removeInstancePortals(instanceId) {
    const keys = this.#instancePortalKeys.get(instanceId);
    if (!keys) return;
    for (const key of keys) {
      const record = this.#portalRecords.get(key);
      if (!record) continue;

      const instance = this.#instances.get(record.instanceId);
      if (instance) {
        for (const binding of record.roadBindings ?? []) {
          const domainId = instance.layerDomains.get(binding.layerId);
          if (!domainId) continue;
          const roads = this.#portalsByRoad.get(domainId);
          const keysForRoad = roads?.get(binding.roadId);
          keysForRoad?.delete(key);
          if (keysForRoad?.size === 0) roads.delete(binding.roadId);
          if (roads?.size === 0) this.#portalsByRoad.delete(domainId);
        }
      }

      for (const [side, endpoint] of [["a", record.a], ["b", record.b]]) {
        const domainId = endpoint.domainId;
        const set = this.#portalsByDomain.get(domainId);
        set?.delete(key);
        if (set?.size === 0) this.#portalsByDomain.delete(domainId);

        const endpointKey = `${key}\u0000${side}`;
        const endpointIndex = this.#portalEndpointIndexes.get(domainId);
        endpointIndex?.delete(endpointKey);
        if (endpointIndex?.size === 0) {
          this.#portalEndpointIndexes.delete(domainId);
        }

        const traversableIndex =
          this.#traversablePortalEndpointIndexes.get(domainId);
        traversableIndex?.delete(endpointKey);
        if (traversableIndex?.size === 0) {
          this.#traversablePortalEndpointIndexes.delete(domainId);
        }

        this.#portalEndpointRecords.delete(endpointKey);
      }
      this.#portalRecords.delete(key);
    }
    this.#instancePortalKeys.delete(instanceId);
  }

  #reindexInstancePortals(instance, definition) {
    this.#removeInstancePortals(instance.id);
    const keys = new Set();
    const portalIds = [
      ...definition.portals.map((portal) => portal.id),
      ...instance.dynamicPortals.keys()
    ];
    for (const portalId of portalIds) {
      const resolved = this.resolvePortal(instance.id, portalId);
      if (!resolved?.connected || !resolved.a || !resolved.b) continue;
      const key = this.#portalKey(instance.id, portalId);
      const record = deepFreeze({ key, ...resolved });
      this.#portalRecords.set(key, record);
      keys.add(key);
      for (const domainId of new Set([record.a.domainId, record.b.domainId])) {
        let set = this.#portalsByDomain.get(domainId);
        if (!set) this.#portalsByDomain.set(domainId, set = new Set());
        set.add(key);
      }

      for (const binding of record.roadBindings ?? []) {
        const domainId = instance.layerDomains.get(binding.layerId);
        if (!domainId) continue;
        let roads = this.#portalsByRoad.get(domainId);
        if (!roads) this.#portalsByRoad.set(domainId, roads = new Map());
        let roadKeys = roads.get(binding.roadId);
        if (!roadKeys) roads.set(binding.roadId, roadKeys = new Set());
        roadKeys.add(key);
      }

      for (const [side, endpoint] of [["a", record.a], ["b", record.b]]) {
        const endpointKey = `${key}\u0000${side}`;
        this.#portalEndpointRecords.set(endpointKey, {
          portalKey: key,
          side,
          domainId: endpoint.domainId
        });
        let endpointIndex = this.#portalEndpointIndexes.get(endpoint.domainId);
        if (!endpointIndex) {
          this.#portalEndpointIndexes.set(
            endpoint.domainId,
            endpointIndex = new DynamicPointIndex()
          );
        }
        endpointIndex.set(endpointKey, endpoint.position);

        if (record.traversable) {
          let traversableIndex =
            this.#traversablePortalEndpointIndexes.get(
              endpoint.domainId
            );
          if (!traversableIndex) {
            this.#traversablePortalEndpointIndexes.set(
              endpoint.domainId,
              traversableIndex = new DynamicPointIndex()
            );
          }
          traversableIndex.set(endpointKey, endpoint.position);
        }
      }
    }
    if (keys.size > 0) this.#instancePortalKeys.set(instance.id, keys);
    else this.#instancePortalKeys.delete(instance.id);
  }

  #placeChain(instanceId) {
    const chain = [];
    const visited = new Set();
    let current = this.#instances.get(instanceId);
    while (current) {
      if (visited.has(current.id)) throw new Error(`place parent cycle involving ${String(current.id)}`);
      visited.add(current.id);
      chain.push(current.id);
      current = current.parentId == null ? null : this.#instances.get(current.parentId);
    }
    return chain.reverse();
  }

  #sameLocation(a, b) {
    if (!a || !b || a.domainId !== b.domainId) return false;
    if (a.places.length !== b.places.length || a.spaces.length !== b.spaces.length) return false;
    for (let i = 0; i < a.places.length; i += 1) if (a.places[i] !== b.places[i]) return false;
    for (let i = 0; i < a.spaces.length; i += 1) {
      if (a.spaces[i].placeId !== b.spaces[i].placeId || a.spaces[i].spaceId !== b.spaces[i].spaceId) return false;
    }
    return true;
  }

  #collectTrackedEntitiesForIndexedPlaces(instanceIds) {
    const result = new Set();
    for (const instanceId of instanceIds) {
      const domainId = this.#indexedExteriorDomains.get(instanceId);
      if (domainId == null) continue;
      const bounds = this.#exteriorIndexes.get(domainId)?.getBounds(instanceId);
      if (!bounds) continue;
      for (const entityId of this.#trackedEntitiesInBounds(domainId, bounds)) {
        result.add(entityId);
      }
    }
    return [...result];
  }

  #indexOccupancyPoint(entityId, location) {
    let index = this.#occupancySpatialIndexes.get(location.domainId);
    if (!index) {
      this.#occupancySpatialIndexes.set(
        location.domainId,
        index = new DynamicAabbIndex()
      );
    }
    const { x, y } = location.position;
    index.set(entityId, { minX: x, minY: y, maxX: x, maxY: y });
  }

  #unindexOccupancyPoint(entityId, location) {
    const index = this.#occupancySpatialIndexes.get(location.domainId);
    if (!index) return;
    index.delete(entityId);
    if (index.size === 0) this.#occupancySpatialIndexes.delete(location.domainId);
  }

  #refreshTrackedOccupancy(entityIds) {
    for (const entityId of [...new Set(entityIds)]) {
      const previous = this.#occupancy.get(entityId);
      if (!previous) continue;
      const next = this.locate(previous.domainId, previous.position);
      if (this.#sameLocation(previous, next)) {
        this.#occupancy.set(entityId, next);
        continue;
      }
      this.#removeOccupancy(entityId, previous);
      this.#occupancy.set(entityId, next);
      this.#addOccupancy(entityId, next);
      this.#emitLocationTransitions(entityId, previous, next);
    }
  }

  #trackedEntitiesInBounds(domainId, bounds) {
    return this.#occupancySpatialIndexes.get(domainId)?.queryBounds(bounds) ?? [];
  }

  #addOccupancy(entityId, location) {
    for (const placeId of location.places) {
      let set = this.#entitiesByPlace.get(placeId);
      if (!set) this.#entitiesByPlace.set(placeId, set = new Set());
      set.add(entityId);
    }
    for (const space of location.spaces) {
      const key = makeSpaceKey(space.placeId, space.spaceId);
      let set = this.#entitiesBySpace.get(key);
      if (!set) this.#entitiesBySpace.set(key, set = new Set());
      set.add(entityId);
    }
  }

  #removeOccupancy(entityId, location) {
    for (const placeId of location.places) {
      const set = this.#entitiesByPlace.get(placeId);
      set?.delete(entityId);
      if (set?.size === 0) this.#entitiesByPlace.delete(placeId);
    }
    for (const space of location.spaces) {
      const key = makeSpaceKey(space.placeId, space.spaceId);
      const set = this.#entitiesBySpace.get(key);
      set?.delete(entityId);
      if (set?.size === 0) this.#entitiesBySpace.delete(key);
    }
  }

  #emitLocationTransitions(entityId, previous, next) {
    const beforePlaces = new Set(previous?.places ?? []);
    const afterPlaces = new Set(next?.places ?? []);
    for (const placeId of beforePlaces) if (!afterPlaces.has(placeId)) this.emit("place-leave", { entityId, placeId });
    for (const placeId of afterPlaces) if (!beforePlaces.has(placeId)) this.emit("place-enter", { entityId, placeId });

    const beforeSpaces = new Map((previous?.spaces ?? []).map((x) => [makeSpaceKey(x.placeId, x.spaceId), x]));
    const afterSpaces = new Map((next?.spaces ?? []).map((x) => [makeSpaceKey(x.placeId, x.spaceId), x]));
    for (const [key, value] of beforeSpaces) if (!afterSpaces.has(key)) this.emit("space-leave", { entityId, ...value });
    for (const [key, value] of afterSpaces) if (!beforeSpaces.has(key)) this.emit("space-enter", { entityId, ...value });
  }
}

export function isPortalTraversable(portal) {
  return portalTraversableState(portal);
}
