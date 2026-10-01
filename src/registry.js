import {
  DynamicAabbIndex,
  DynamicPointIndex,
  geometryBounds,
  inverseTransformPoint,
  pointInGeometry,
  squaredDistance,
  distancePointToSegment,
  segmentIntersectsBounds,
  transformBounds
} from "./geometry.js";
import { CompiledPlaceDefinition } from "./definition.js";
import {
  assertId,
  assertStringId,
  BoundedEventQueue,
  cloneJson,
  compareStrings,
  deepFreeze,
  normalizeBoolean,
  normalizeStringList,
  tupleKey
} from "./utils.js";
import { PlaceInstance } from "./registry/place-instance.js";
import { OccupancyIndex } from "./registry/occupancy-index.js";
import { PlacementGraphIndex } from "./registry/placement-graph.js";
import { SemanticGraphIndex } from "./registry/semantic-graph.js";
import {
  PORTAL_STATE_KEYS,
  PLACE_INSTANCE_MUTATION_TOKEN,
  PLACE_REGISTRY_BRIDGE_ATTACH_TOKEN,
  PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
  abortEnteredTravelPortal,
  bindTravelRuntimeBridge,
  getTravelRuntimeBridge,
  ReadonlyMapView,
  assertPlainObject,
  assertPatchKeys,
  assertVec2,
  assertBounds,
  assertOptionalString,
  normalizeFiniteDistance,
  normalizeAttachment,
  normalizePlacement,
  attachmentEqual,
  placementEqual,
  defaultLayerDomainId,
  typedIdKey,
  membershipKey,
  normalizeMembership,
  cloneState,
  snapshotTravelState,
  portalTraversableState,
  validateResolvedPortalRoadBindings
} from "./registry/support.js";

export { PlaceInstance };

function nearestAnchorResult(candidates, position) {
  if (candidates.length === 0) return null;

  let scale = Math.max(
    1,
    Math.abs(position.x),
    Math.abs(position.y)
  );
  for (const anchor of candidates) {
    scale = Math.max(
      scale,
      Math.abs(anchor.position.x),
      Math.abs(anchor.position.y)
    );
  }

  let best = null;
  let bestScaledDistance = Infinity;

  for (const anchor of candidates) {
    const scaledDistance = Math.hypot(
      position.x / scale -
        anchor.position.x / scale,
      position.y / scale -
        anchor.position.y / scale
    );

    if (
      best === null ||
      scaledDistance < bestScaledDistance ||
      (
        scaledDistance === bestScaledDistance &&
        compareStrings(anchor.id, best.id) < 0
      )
    ) {
      best = anchor;
      bestScaledDistance = scaledDistance;
    }
  }

  return {
    anchor: best,
    distance: Math.hypot(
      position.x - best.position.x,
      position.y - best.position.y
    )
  };
}

function nearestBoundaryResult(boundaries, position) {
  if (boundaries.length === 0) return null;

  let scale = Math.max(
    1,
    Math.abs(position.x),
    Math.abs(position.y)
  );
  for (const boundary of boundaries) {
    scale = Math.max(
      scale,
      Math.abs(boundary.a.x),
      Math.abs(boundary.a.y),
      Math.abs(boundary.b.x),
      Math.abs(boundary.b.y)
    );
  }

  const scaledPosition = {
    x: position.x / scale,
    y: position.y / scale
  };
  let best = null;
  let bestScaledDistance = Infinity;

  for (const boundary of boundaries) {
    const scaledDistance =
      distancePointToSegment(
        scaledPosition,
        {
          x: boundary.a.x / scale,
          y: boundary.a.y / scale
        },
        {
          x: boundary.b.x / scale,
          y: boundary.b.y / scale
        }
      );

    if (
      best === null ||
      scaledDistance < bestScaledDistance ||
      (
        scaledDistance === bestScaledDistance &&
        compareStrings(boundary.id, best.id) < 0
      )
    ) {
      best = boundary;
      bestScaledDistance = scaledDistance;
    }
  }

  return {
    boundary: best,
    distance: distancePointToSegment(
      position,
      best.a,
      best.b
    )
  };
}

export class PlaceRegistry {
  #definitions = new Map();
  #instances = new Map();
  #domainBindings = new Map();
  #definitionsView;
  #instancesView;
  #domainBindingsView;
  #exteriorIndexes = new Map();
  #indexedExteriorDomains = new Map();
  #spaceEnabledCache = new Map();
  #placementGraph = new PlacementGraphIndex(this.#instances);
  #semanticGraph = new SemanticGraphIndex(this.#instances);
  #portalRecords = new Map();
  #portalsByDomain = new Map();
  #portalEndpointIndexes = new Map();
  #traversablePortalEndpointIndexes = new Map();
  #portalEndpointRecords = new Map();
  #portalsByRoad = new Map();
  #instancePortalKeys = new Map();
  #occupancyIndex;
  #activeTravels = new Map();
  #activeTravelsView;
  #pendingTravels = [];
  #events;
  #captureEvents;
  #bridge = null;
  #sequence = 0;
  #stateRevision = 0;
  #travelRevision = 0;

  constructor(options = {}) {
    assertPlainObject(options, "PlaceRegistry options");
    const allowedOptionKeys = new Set([
      "bridge",
      "captureEvents",
      "eventQueueLimit",
      "eventOverflowPolicy"
    ]);
    for (const key of Object.keys(options)) {
      if (!allowedOptionKeys.has(key)) {
        throw new Error(
          `PlaceRegistry options contains unknown field ${key}`
        );
      }
    }

    this.#definitionsView =
      new ReadonlyMapView(this.#definitions);
    this.#instancesView =
      new ReadonlyMapView(this.#instances);
    this.#domainBindingsView =
      new ReadonlyMapView(this.#domainBindings);
    this.#activeTravelsView =
      new ReadonlyMapView(
        this.#activeTravels,
        (state) =>
          snapshotTravelState(state)
      );

    this.#captureEvents = normalizeBoolean(
      options.captureEvents,
      "captureEvents",
      { defaultValue: false }
    );
    this.#events = new BoundedEventQueue({
      limit: options.eventQueueLimit ?? 10_000,
      overflowPolicy: options.eventOverflowPolicy ?? "drop-newest"
    });
    this.#occupancyIndex = new OccupancyIndex({
      locate: (domainId, position) =>
        this.locate(domainId, position),
      emit: (type, data) => this.emit(type, data)
    });
    if (options.bridge) this.attachWorldCoreBridge(options.bridge);
  }

  get definitions() { return this.#definitionsView; }
  get instances() { return this.#instancesView; }
  get domainBindings() { return this.#domainBindingsView; }
  get activeTravels() {
    return this.#activeTravelsView;
  }

  get pendingTravels() {
    return Object.freeze(
      this.#pendingTravels.map((pending) =>
        deepFreeze(cloneJson(pending))
      )
    );
  }

  #assertTravelMutationToken(token) {
    if (token !== PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN) {
      throw new Error(
        "travel state mutation is internal to place-core"
      );
    }
  }

  _getActiveTravel(token, entityId) {
    this.#assertTravelMutationToken(token);
    return this.#activeTravels.get(entityId) ?? null;
  }

  _hasActiveTravel(token, entityId) {
    this.#assertTravelMutationToken(token);
    return this.#activeTravels.has(entityId);
  }

  _setActiveTravel(token, entityId, state) {
    this.#assertTravelMutationToken(token);
    this.#activeTravels.set(entityId, state);
    return state;
  }

  _deleteActiveTravel(token, entityId) {
    this.#assertTravelMutationToken(token);
    return this.#activeTravels.delete(entityId);
  }

  _activeTravelIds(token) {
    this.#assertTravelMutationToken(token);
    return [...this.#activeTravels.keys()]
      .sort((a, b) =>
        compareStrings(
          typedIdKey(a),
          typedIdKey(b)
        )
      );
  }

  _activeTravelCount(token) {
    this.#assertTravelMutationToken(token);
    return this.#activeTravels.size;
  }

  _pushPendingTravel(token, pending) {
    this.#assertTravelMutationToken(token);
    const copy = cloneJson(pending);

    // Pending travel is retained intent, not an actively maintained plan.
    // Once execution is detached, structural freshness can no longer be
    // guaranteed against later registry mutations.
    if (
      copy?.savedState &&
      typeof copy.savedState === "object"
    ) {
      copy.savedState.planStale = true;
    }

    const stored =
      deepFreeze(copy);
    this.#pendingTravels.push(stored);
    return stored;
  }

  _handleWorldEntityRemoved(token, entityId) {
    this.#assertTravelMutationToken(token);

    const state = this.#activeTravels.get(entityId) ?? null;
    if (state) {
      abortEnteredTravelPortal(
        this,
        state,
        "entity-removed"
      );
      this.#activeTravels.delete(entityId);
      state.status = "failed";
      state.failureReason = "entity-removed";
      this.emit("travel-failed", {
        entityId,
        reason: "entity-removed",
        target: state.target
      });
    }

    const occupancyRemoved =
      this.#occupancyIndex.remove(entityId);

    return {
      travelRemoved: state != null,
      occupancyRemoved
    };
  }
  get stateRevision() { return this.#stateRevision; }
  get travelRevision() { return this.#travelRevision; }
  get bridge() { return this.#bridge; }

  #touchState({ travel = false } = {}) {
    this.#stateRevision += 1;
    if (travel) this.#travelRevision += 1;
  }

  attachWorldCoreBridge(bridge) {
    if (!bridge || typeof bridge !== "object") {
      throw new TypeError("bridge must be an object");
    }
    if (this.#bridge === bridge) return this;
    if (this.#bridge && this.#bridge !== bridge) {
      throw new Error("place-core already has a different bridge attached");
    }

    for (const state of this.#activeTravels.values()) {
      const owner =
        getTravelRuntimeBridge(state);
      if (owner != null && owner !== bridge) {
        throw new Error(
          "cannot attach a WorldCoreBridge different from the one owning active travel"
        );
      }
    }

    const materialized = [];
    let registryAttached = false;

    try {
      if (typeof bridge.attachRegistry === "function") {
        bridge.attachRegistry(
          this,
          () => {
            if (this.#bridge === bridge) {
              this.#bridge = null;
            }
          },
          PLACE_REGISTRY_BRIDGE_ATTACH_TOKEN
        );
        registryAttached = true;
      }

      if (typeof bridge.materializePlace === "function") {
        const instances = [...this.#instances.values()]
          .sort((a, b) => compareStrings(typedIdKey(a.id), typedIdKey(b.id)));

        for (const instance of instances) {
          const definition = this.#definitions.get(instance.definitionId);
          const receipt = bridge.materializePlace(instance, definition);
          materialized.push({ instance, definition, receipt });

          for (const boundary of definition.boundaries) {
            bridge.syncBoundaryState?.(
              instance,
              this.resolveBoundary(instance.id, boundary.id)
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

    for (const state of this.#activeTravels.values()) {
      bindTravelRuntimeBridge(
        state,
        bridge
      );
    }
    this.#bridge = bridge;
    return this;
  }

  registerDefinition(definition) {
    if (!(definition instanceof CompiledPlaceDefinition)) {
      throw new TypeError(
        "registerDefinition requires a compiled place definition"
      );
    }
    const existing = this.#definitions.get(definition.id);
    if (existing && existing.contentHash !== definition.contentHash) {
      throw new Error(`definition ${definition.id} is already registered with another content hash`);
    }
    this.#definitions.set(definition.id, definition);
    return definition;
  }

  removeDefinition(definitionId) {
    const definition =
      this.#definitions.get(
        definitionId
      );
    if (!definition) return false;

    for (const instance of this.#instances.values()) {
      if (instance.definitionId === definitionId) return false;
    }

    this.#bridge
      ?.releaseDefinitionTopologies
      ?.(definition);

    return this.#definitions.delete(
      definitionId
    );
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

  resolveBoundary(instanceId, boundaryId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return null;
    const definition = this.#definitions.get(instance.definitionId);
    const boundary = definition.getBoundary(boundaryId);
    if (!boundary) return null;
    return { ...boundary, enabled: instance.getBoundaryOverride(boundaryId)?.enabled ?? boundary.enabled };
  }

  resolveAnchor(instanceId, anchorId) {
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
    assertPatchKeys(
      options,
      ["tag", "layerId", "kind", "spaceId"],
      "findNearestAnchor options"
    );
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

    const eligible = [];
    for (const anchor of candidates) {
      if (options.layerId != null && anchor.layerId !== options.layerId) continue;
      if (options.kind != null && anchor.kind !== options.kind) continue;
      if (options.spaceId != null && anchor.spaceId !== options.spaceId) continue;
      if (anchor.spaceId != null) {
        const space = definition.getSpace(anchor.spaceId);
        if (space && !this.#spaceEnabled(instance, definition, space)) continue;
      }
      eligible.push(anchor);
    }

    if (options.layerId == null) {
      const layers = new Set(
        eligible.map((anchor) => anchor.layerId)
      );
      if (layers.size > 1) {
        throw new Error(
          "findNearestAnchor requires layerId when candidates span multiple spatial layers"
        );
      }
    }

    const nearest =
      nearestAnchorResult(
        eligible,
        position
      );

    return nearest ? {
      ...nearest.anchor,
      placeId: instanceId,
      domainId:
        instance.layerDomains.get(
          nearest.anchor.layerId
        ),
      distance: nearest.distance
    } : null;
  }

  getAnchorsForDomain(domainId, options = {}) {
    assertPatchKeys(
      options,
      ["tag", "kind", "spaceId"],
      "getAnchorsForDomain options"
    );
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

    result.sort((a, b) => compareStrings(a.id, b.id));
    return result;
  }

  findNearestAnchorInDomain(domainId, position, options = {}) {
    assertStringId(domainId, "findNearestAnchorInDomain.domainId");
    assertVec2(position, "findNearestAnchorInDomain.position");
    const nearest =
      nearestAnchorResult(
        this.getAnchorsForDomain(
          domainId,
          options
        ),
        position
      );

    return nearest ? {
      ...nearest.anchor,
      distance: nearest.distance
    } : null;
  }

  findPortalEndpointsNear(domainId, position, radius, options = {}) {
    assertPatchKeys(
      options,
      ["traversableOnly", "kind", "tag"],
      "findPortalEndpointsNear options"
    );
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
      compareStrings(a.portal.key, b.portal.key) ||
      compareStrings(a.side, b.side)
    );
    return result;
  }

  findNearestPortal(domainId, position, options = {}) {
    assertPatchKeys(
      options,
      ["traversableOnly", "kind", "tag", "maxDistance"],
      "findNearestPortal options"
    );
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
          return compareStrings(String(leftKey), String(rightKey));
        }
        return compareStrings(left.portalKey, right.portalKey) ||
          compareStrings(left.side, right.side);
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
    assertPatchKeys(
      options,
      ["enabledOnly", "kind", "tag"],
      "getBoundariesForDomain options"
    );
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
      const resolved = this.resolveBoundary(instance.id, boundary.id);
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
    return nearestBoundaryResult(
      this.getBoundariesForDomain(
        domainId,
        options
      ),
      position
    );
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
    result.sort((a, b) => compareStrings(typedIdKey(a.id), typedIdKey(b.id)));
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
      const suppliedDomainId =
        Object.hasOwn(suppliedLayerDomains, layer.id)
          ? suppliedLayerDomains[layer.id]
          : undefined;
      const domainId =
        suppliedDomainId ??
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
      if (placement.parentPlaceId === input.id) {
        throw new Error(
          "place cannot be placed relative to itself"
        );
      }
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

    let registered = false;
    let materialized = false;
    let materializationReceipt = null;
    try {
      this.#instances.set(instance.id, instance);
      registered = true;
      this.#semanticGraph.registerPrimary(instance);
      this.#semanticGraph.registerMemberships(instance);
      this.#placementGraph.register(instance);
      for (const [layerId, domainId] of layerDomains) {
        this.#domainBindings.set(
          domainId,
          deepFreeze({
            instanceId: instance.id,
            layerId
          })
        );
      }
      this.#validateInstancePortals(
        instance,
        definition
      );
      this.#indexExterior(instance, definition);
      this.#reindexInstancePortals(instance, definition);

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
      let localRollbackError = null;
      if (registered) {
        try {
          this.#removePlaceInternal(instance.id, false, {
            touchRevision: false,
            emitEvent: false
          });
        } catch (cleanupError) {
          localRollbackError = cleanupError;
        }
      }

      if (rollbackError || localRollbackError) {
        const errors = [
          error,
          rollbackError,
          localRollbackError
        ].filter(Boolean);
        const rollbackLabel =
          rollbackError && localRollbackError
            ? "bridge and local state"
            : rollbackError
              ? "bridge state"
              : "local state";
        throw new AggregateError(
          errors,
          `failed to create place ${String(instance.id)} and rollback ${rollbackLabel}`
        );
      }
      throw error;
    }

    this.#touchState({ travel: true });
    this.#occupancyIndex.refresh(
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
    const semanticChild =
      this.#semanticGraph.firstPrimaryChild(instanceId);
    if (semanticChild != null) {
      throw new Error(
        `cannot remove place ${String(instanceId)} while child ${String(semanticChild)} exists`
      );
    }

    const membershipChild =
      this.#semanticGraph.firstMembershipChild(instanceId);
    if (membershipChild != null) {
      throw new Error(
        `cannot remove place ${String(instanceId)} while semantic membership child ${String(membershipChild)} exists`
      );
    }

    if (this.#placementGraph.hasChildren(instanceId)) {
      throw new Error(`cannot remove place ${String(instanceId)} while relative placements depend on it`);
    }
    const definition = this.#definitions.get(instance.definitionId);
    if (callBridge && this.#occupancyIndex.hasInPlace(instanceId)) {
      throw new Error(`cannot remove occupied place ${String(instanceId)}`);
    }
    if (callBridge) this.#bridge?.unmaterializePlace?.(instance, definition);
    this.clearEntityOccupancyForPlace(instanceId);
    for (const domainId of instance.layerDomains.values()) this.#domainBindings.delete(domainId);
    this.#unindexExterior(instance);
    this.#semanticGraph.unregisterPrimary(instance);
    this.#semanticGraph.unregisterMemberships(instance);
    this.#placementGraph.unregister(instance);
    this.#removeInstancePortals(instance.id);
    this.#semanticGraph.deleteCached(instance.id);
    this.#spaceEnabledCache.delete(instance.id);
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
  getLayerDomain(instanceId, layerId) {
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
      enabled === boundary.enabled ? null : { enabled },
      PLACE_INSTANCE_MUTATION_TOKEN
    );

    try {
      this.#bridge?.syncBoundaryState?.(instance, resolved);
    } catch (error) {
      instance.setBoundaryOverride(
        boundaryId,
        previousOverride,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
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
    const affectedEntities = [...this.#occupancyIndex.entitiesInPlace(instanceId)];
    const baseEnabled = true;
    const currentEnabled = instance.getSpaceOverride(spaceId)?.enabled ?? baseEnabled;
    const enabled = normalizeBoolean(
      patch.enabled,
      `space(${spaceId}).enabled`,
      { defaultValue: currentEnabled }
    );
    if (enabled === currentEnabled) {
      return {
        ...space,
        enabled:
          this.#spaceEnabled(
            instance,
            definition,
            space
          )
      };
    }

    instance.setSpaceOverride(
      spaceId,
      enabled === baseEnabled ? null : { enabled },
      PLACE_INSTANCE_MUTATION_TOKEN
    );
    this.#spaceEnabledCache.delete(instanceId);
    this.#touchState({ travel: true });
    this.#occupancyIndex.refresh(affectedEntities);
    this.emit("space-state-changed", {
      placeId: instanceId,
      spaceId,
      enabled
    });
    return {
      ...space,
      enabled:
        this.#spaceEnabled(
          instance,
          definition,
          space
        )
    };
  }

  #validateInstancePortals(
    instance,
    definition,
    additionalPortals = []
  ) {
    const thresholdRoadOwners = new Map();

    const validate = (portal, label) => {
      validateResolvedPortalRoadBindings(
        instance,
        definition,
        portal,
        label
      );

      if (
        !portal?.connected ||
        !portal.a ||
        !portal.b ||
        portal.a.domainId !== portal.b.domainId
      ) {
        return;
      }

      const domainId = portal.a.domainId;
      for (const binding of portal.roadBindings ?? []) {
        if (
          instance.layerDomains.get(binding.layerId) !==
          domainId
        ) {
          continue;
        }

        const key = tupleKey(
          domainId,
          binding.roadId
        );
        const owner = thresholdRoadOwners.get(key);
        if (
          owner != null &&
          owner.portalId !== portal.id
        ) {
          throw new Error(
            `navigation road ${binding.roadId} in domain ${domainId} is already bound as a threshold by portal ${owner.portalId}; ${label} cannot also own it`
          );
        }

        thresholdRoadOwners.set(key, {
          portalId: portal.id,
          label
        });
      }
    };

    for (const portal of definition.portals) {
      validate(
        this.resolvePortal(
          instance.id,
          portal.id
        ),
        `portal ${portal.id}`
      );
    }

    for (const portal of
      instance.dynamicPortals.values()) {
      validate(
        this.resolvePortal(
          instance.id,
          portal.id
        ),
        `dynamic portal ${portal.id}`
      );
    }

    for (const portal of additionalPortals) {
      validate(
        portal,
        `dynamic portal ${portal.id}`
      );
    }
  }

  #restorePortalBridgeStates(
    instance,
    portals
  ) {
    const errors = [];

    for (const portal of portals) {
      try {
        this.#bridge?.syncPortalState?.(
          instance,
          portal,
          this.resolvePortal(
            instance.id,
            portal.id
          )
        );
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "failed to restore portal bridge states"
      );
    }
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

    instance.setAttachment(
      slot,
      nextAttachment,
      PLACE_INSTANCE_MUTATION_TOKEN
    );
    try {
      this.#validateInstancePortals(
        instance,
        definition
      );
    } catch (error) {
      if (previousAttachment) instance.setAttachment(
        slot,
        previousAttachment,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
      else instance.deleteAttachment(
        slot,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
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
      if (previousAttachment) instance.setAttachment(
        slot,
        previousAttachment,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
      else instance.deleteAttachment(
        slot,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
      this.#reindexInstancePortals(instance, definition);

      let rollbackError = null;
      try {
        this.#restorePortalBridgeStates(
          instance,
          affectedPortals
        );
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

    instance.deleteAttachment(
        slot,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
    try {
      this.#validateInstancePortals(
        instance,
        definition
      );
    } catch (error) {
      instance.setAttachment(
        slot,
        previousAttachment,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
      throw error;
    }

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
      instance.setAttachment(
        slot,
        previousAttachment,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
      this.#reindexInstancePortals(instance, definition);

      let rollbackError = null;
      try {
        this.#restorePortalBridgeStates(
          instance,
          affectedPortals
        );
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
      this.#placementGraph.assertParentDoesNotCycle(instanceId, next.parentPlaceId);
    }

    const affected =
      this.#placementGraph.collectDescendants(
        instanceId
      );
    const affectedEntities = new Set(
      this.#collectTrackedEntitiesForIndexedPlaces(
        affected
      )
    );
    const previousPlacement = instance.placement;

    for (const id of affected) {
      this.#unindexExterior(
        this.#instances.get(id)
      );
    }

    this.#placementGraph.unregister(instance);
    instance.setPlacement(
      next,
      PLACE_INSTANCE_MUTATION_TOKEN
    );
    this.#placementGraph.register(instance);

    try {
      for (const id of affected) {
        const child = this.#instances.get(id);
        if (!child) continue;
        this.#indexExterior(
          child,
          this.#definitions.get(
            child.definitionId
          )
        );
      }
    } catch (error) {
      let rollbackError = null;
      try {
        for (const id of affected) {
          this.#unindexExterior(
            this.#instances.get(id)
          );
        }

        this.#placementGraph.unregister(instance);
        instance.setPlacement(
          previousPlacement,
          PLACE_INSTANCE_MUTATION_TOKEN
        );
        this.#placementGraph.register(instance);

        for (const id of affected) {
          const child = this.#instances.get(id);
          if (!child) continue;
          this.#indexExterior(
            child,
            this.#definitions.get(
              child.definitionId
            )
          );
        }
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to update placement for ${String(instanceId)} and restore exterior indexes`
        );
      }
      throw error;
    }

    for (
      const entityId of
      this.#collectTrackedEntitiesForIndexedPlaces(
        affected
      )
    ) {
      affectedEntities.add(entityId);
    }

    this.#touchState();
    this.#occupancyIndex.refresh(affectedEntities);
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
    return this.#placementGraph.resolve(instanceId);
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
      this.#semanticGraph.assertEdgeDoesNotCycle(
        instanceId,
        parentId,
        "place parent cycle through semantic membership graph"
      );
    }
    if (instance.parentId === (parentId ?? null)) {
      return instance;
    }
    const affectedEntities = [...this.#occupancyIndex.entitiesInPlace(instanceId)];
    this.#semanticGraph.unregisterPrimary(instance);
    instance.setParentId(
      parentId ?? null,
      PLACE_INSTANCE_MUTATION_TOKEN
    );
    this.#semanticGraph.registerPrimary(instance);
    this.#semanticGraph.invalidateClosureDescendants(
      instanceId
    );
    this.#touchState();
    this.#occupancyIndex.refresh(affectedEntities);
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
        compareStrings(
          typedIdKey(a.parentPlaceId),
          typedIdKey(b.parentPlaceId)
        ) ||
        compareStrings(a.kind, b.kind)
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

    this.#semanticGraph.assertEdgeDoesNotCycle(
      instanceId,
      membership.parentPlaceId
    );

    const affectedEntities = [
      ...this.#occupancyIndex.entitiesInPlace(instanceId)
    ];

    instance.addMembership(
      membership,
      PLACE_INSTANCE_MUTATION_TOKEN
    );
    this.#semanticGraph.registerMembership(
      instance.id,
      membership
    );
    this.#semanticGraph.invalidateClosureDescendants(
      instanceId
    );

    this.#touchState();
    this.#occupancyIndex.refresh(affectedEntities);
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
      ...this.#occupancyIndex.entitiesInPlace(instanceId)
    ];

    instance.removeMembership(
      parentPlaceId,
      kind,
      PLACE_INSTANCE_MUTATION_TOKEN
    );
    this.#semanticGraph.unregisterMembership(
      instance.id,
      membership
    );
    this.#semanticGraph.invalidateClosureDescendants(
      instanceId
    );

    this.#touchState();
    this.#occupancyIndex.refresh(affectedEntities);
    this.emit("place-membership-removed", {
      placeId: instanceId,
      membership
    });
    return true;
  }

  getSemanticAncestors(
    instanceId,
    options = {}
  ) {
    assertPatchKeys(
      options,
      ["includeSelf"],
      "getSemanticAncestors options"
    );
    const includeSelf = normalizeBoolean(
      options.includeSelf,
      "getSemanticAncestors.includeSelf",
      { defaultValue: false }
    );

    if (!this.#instances.has(instanceId)) {
      return [];
    }
    const closure =
      this.#semanticGraph.closure(
        [instanceId]
      );
    return includeSelf
      ? closure
      : closure.filter(
          (id) => id !== instanceId
        );
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
      const dynamic =
        instance.dynamicPortals.get(portalId);
      if (!dynamic) {
        throw new Error(
          `unknown portal ${portalId} on place ${String(instanceId)}`
        );
      }

      const before =
        this.resolvePortal(instanceId, portalId);
      const prospectiveState = {};
      let changed = false;

      for (const key of PORTAL_STATE_KEYS) {
        const value = normalizeBoolean(
          patch[key],
          `dynamic portal(${portalId}).${key}`,
          { defaultValue: dynamic[key] }
        );
        prospectiveState[key] = value;
        if (value !== dynamic[key]) {
          changed = true;
        }
      }

      if (!changed) return before;

      const nextDynamic = deepFreeze({
        ...dynamic,
        ...prospectiveState
      });
      const prospective = {
        ...before,
        ...prospectiveState
      };

      if (before.traversable !==
          portalTraversableState(prospective)) {
        validateResolvedPortalRoadBindings(
          instance,
          definition,
          prospective,
          `dynamic portal ${portalId}`
        );
      }

      instance.replaceDynamicPortal(
        portalId,
        nextDynamic,
        PLACE_INSTANCE_MUTATION_TOKEN
      );

      this.#reindexInstancePortals(
        instance,
        definition
      );
      const resolved =
        this.resolvePortal(instanceId, portalId);

      try {
        this.#bridge?.syncPortalState?.(
          instance,
          nextDynamic,
          resolved
        );
      } catch (error) {
        instance.replaceDynamicPortal(
          portalId,
          dynamic,
          PLACE_INSTANCE_MUTATION_TOKEN
        );
        this.#reindexInstancePortals(
          instance,
          definition
        );

        let rollbackError = null;
        try {
          this.#bridge?.syncPortalState?.(
            instance,
            dynamic,
            before
          );
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
        travel:
          before.traversable !==
          resolved.traversable
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
    instance.setPortalOverride(
      portalId,
      next,
      PLACE_INSTANCE_MUTATION_TOKEN
    );
    this.#reindexInstancePortals(instance, definition);
    const resolved = this.resolvePortal(instanceId, portalId);

    try {
      this.#bridge?.syncPortalState?.(instance, base, resolved);
    } catch (error) {
      instance.setPortalOverride(
        portalId,
        previousOverride,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
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

  addPortal(instanceId, spec) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    assertPatchKeys(
      spec,
      [
        "id",
        "kind",
        "tags",
        "a",
        "b",
        "bidirectional",
        "transitionCost",
        "enabled",
        "open",
        "locked",
        "blocked",
        "destroyed",
        "blocksWhenClosed",
        "roadBindings",
        "metadata"
      ],
      "dynamic portal"
    );
    assertStringId(spec.id, "dynamic portal id");
    const definition = this.#definitions.get(instance.definitionId);
    if (definition.getPortal(spec.id) ||
        instance.dynamicPortals.has(spec.id)) {
      throw new Error(
        `portal already exists: ${spec.id}`
      );
    }
    const normalizeResolved = (endpoint, label) => {
      assertPatchKeys(
        endpoint,
        [
          "domainId",
          "position",
          "nodeId",
          "placeId",
          "layerId",
          "spaceId",
          "metadata"
        ],
        label
      );
      assertStringId(endpoint.domainId, `${label}.domainId`);
      assertVec2(endpoint.position, `${label}.position`);
      assertPatchKeys(
        endpoint.position,
        ["x", "y"],
        `${label}.position`
      );
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

    const roadBindingsInput =
      spec.roadBindings ?? [];
    if (!Array.isArray(roadBindingsInput)) {
      throw new TypeError(
        "dynamic portal roadBindings must be an array"
      );
    }
    const roadBindings =
      roadBindingsInput.map((binding, index) => {
        assertPatchKeys(
          binding,
          ["layerId", "roadId"],
          `dynamic portal roadBindings[${index}]`
        );
        assertStringId(
          binding.layerId,
          `dynamic portal roadBindings[${index}].layerId`
        );
        assertStringId(
          binding.roadId,
          `dynamic portal roadBindings[${index}].roadId`
        );
        if (!instance.layerDomains.has(binding.layerId)) {
          throw new Error(
            `dynamic portal road binding references unknown layer ${binding.layerId}`
          );
        }
        return {
          layerId: binding.layerId,
          roadId: binding.roadId
        };
      });

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
      roadBindings,
      metadata: cloneJson(spec.metadata ?? null)
    };
    const resolvedPortal = {
      ...portal,
      connected: true,
      traversable: portalTraversableState(portal)
    };
    this.#validateInstancePortals(
      instance,
      definition,
      [resolvedPortal]
    );

    instance.addDynamicPortal(
      portal,
      PLACE_INSTANCE_MUTATION_TOKEN
    );
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

      instance.removeDynamicPortal(
        portal.id,
        PLACE_INSTANCE_MUTATION_TOKEN
      );
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

  removePortal(instanceId, portalId) {
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

    instance.removeDynamicPortal(
      portalId,
      PLACE_INSTANCE_MUTATION_TOKEN
    );
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
    return [...keys]
      .sort(compareStrings)
      .map((key) =>
        this.#portalRecords.get(key)
      )
      .filter(Boolean);
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
      const exteriorIds =
        exteriorIndex.queryPoint(position)
          .sort((a, b) =>
            compareStrings(
              typedIdKey(a),
              typedIdKey(b)
            )
          );

      for (const instanceId of exteriorIds) {
        const instance = this.#instances.get(instanceId);
        if (!instance?.placement || instance.placement.containment !== "footprint") continue;
        const definition = this.#definitions.get(instance.definitionId);
        if (!definition.footprint) continue;
        const resolvedPlacement = this.#placementGraph.resolve(instance.id);
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

    const semanticPlaces =
      this.#semanticGraph.closure(places);

    return deepFreeze({
      domainId,
      position: { x: position.x, y: position.y },
      places,
      semanticPlaces,
      spaces
    });
  }

  locateEntity(entity) {
    if (!entity) throw new TypeError("entity is required");
    return this.locate(entity.domainId ?? "default", entity.position);
  }

  updateEntityOccupancy(entity) {
    assertId(entity?.id, "entity.id");
    return this.#occupancyIndex.update(
      entity.id,
      this.locateEntity(entity)
    );
  }

  removeEntityOccupancy(entityId) {
    return this.#occupancyIndex.remove(entityId);
  }

  getEntityLocation(entityId) {
    return this.#occupancyIndex.get(entityId);
  }

  entitiesInPlace(instanceId) {
    return this.#occupancyIndex.entitiesInPlace(instanceId);
  }

  entitiesInSpace(instanceId, spaceId) {
    return this.#occupancyIndex.entitiesInSpace(
      instanceId,
      spaceId
    );
  }

  clearEntityOccupancyForPlace(instanceId) {
    this.#occupancyIndex.clearPlace(instanceId);
  }

  emit(type, data = {}) {
    if (!this.#captureEvents) return null;
    const event = deepFreeze({
      ...cloneJson(data),
      sequence: ++this.#sequence,
      type
    });
    this.#events.push(event);
    return event;
  }

  setEventCapture(enabled) {
    this.#captureEvents = normalizeBoolean(enabled, "event capture");
  }
  drainEvents(target = []) { return this.#events.drain(target); }
  peekEvents() { return this.#events.peek(); }
  getEventQueueStats() {
    return {
      size: this.#events.size,
      limit: this.#events.limit,
      overflowPolicy: this.#events.overflowPolicy,
      dropped: this.#events.dropped
    };
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

    let semanticMembershipCount = 0;
    for (const instance of this.#instances.values()) {
      semanticMembershipCount +=
        instance.getMemberships().length;
    }

    return {
      definitionCount: this.#definitions.size,
      instanceCount: this.#instances.size,
      domainBindingCount: this.#domainBindings.size,
      semanticMembershipCount,
      semanticMembershipParentCount:
        this.#semanticGraph.membershipParentCount,
      semanticClosureCacheSize:
        this.#semanticGraph.closureCacheSize,
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
      occupiedEntityCount: this.#occupancyIndex.size,
      occupancySpatialDomainCount:
        this.#occupancyIndex.spatialDomainCount,
      stateRevision: this.#stateRevision,
      travelRevision: this.#travelRevision,
      footprintIndexCells,
      eventQueueSize: this.#events.size,
      droppedEventCount: this.#events.dropped
    };
  }

  assertInternalConsistency() {
    for (const [instanceId, cache] of
      this.#spaceEnabledCache) {
      const instance =
        this.#instances.get(instanceId);
      if (!instance) {
        throw new Error(
          `space enabled cache references missing instance ${String(instanceId)}`
        );
      }
      const definition =
        this.#definitions.get(
          instance.definitionId
        );
      for (const [spaceId, enabled] of cache) {
        if (!definition?.getSpace(spaceId) ||
            typeof enabled !== "boolean") {
          throw new Error(
            `space enabled cache drift for ${String(instanceId)}:${spaceId}`
          );
        }
      }
    }

    for (const [domainId, binding] of this.#domainBindings) {
      const instance = this.#instances.get(binding.instanceId);
      if (!instance) throw new Error(`domain ${domainId} references missing instance`);
      if (instance.layerDomains.get(binding.layerId) !== domainId) {
        throw new Error(
          `domain ${domainId} binding mismatch`
        );
      }
    }
    for (const instance of this.#instances.values()) {
      const definition = this.#definitions.get(instance.definitionId);
      if (!definition) throw new Error(`instance ${String(instance.id)} references missing definition`);
      this.#semanticGraph.assertInstanceIndexed(instance);
      this.#validateInstancePortals(
        instance,
        definition
      );
    }

    this.#semanticGraph.assertConsistency();
    this.#placementGraph.assertConsistency();

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
        const endpointKey = tupleKey(key, side);
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
    if (instance.spaceOverrides.size === 0) {
      return true;
    }

    let cache =
      this.#spaceEnabledCache.get(instance.id);
    if (!cache) {
      cache = new Map();
      this.#spaceEnabledCache.set(
        instance.id,
        cache
      );
    }

    if (cache.has(space.id)) {
      return cache.get(space.id);
    }

    const path = [];
    let current = space;
    let enabled = true;

    while (current) {
      if (cache.has(current.id)) {
        enabled = cache.get(current.id);
        break;
      }

      path.push(current);
      if (
        instance.getSpaceOverride(current.id)
          ?.enabled === false
      ) {
        enabled = false;
        break;
      }

      current =
        current.parentSpaceId == null
          ? null
          : definition.getSpace(
              current.parentSpaceId
            );
    }

    while (path.length) {
      const candidate = path.pop();
      if (
        instance.getSpaceOverride(
          candidate.id
        )?.enabled === false
      ) {
        enabled = false;
      }
      cache.set(candidate.id, enabled);
    }

    return cache.get(space.id) ?? enabled;
  }

  #indexExterior(instance, definition) {
    if (!instance?.placement || instance.placement.containment !== "footprint" || !definition?.footprint) return;
    const resolved = this.#placementGraph.resolve(instance.id);
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

  #portalKey(instanceId, portalId) {
    return tupleKey(
      typedIdKey(instanceId),
      portalId
    );
  }

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

        const endpointKey = tupleKey(key, side);
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
        const endpointKey = tupleKey(key, side);
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

  #collectTrackedEntitiesForIndexedPlaces(instanceIds) {
    const result = new Set();

    for (const instanceId of instanceIds) {
      const domainId =
        this.#indexedExteriorDomains.get(instanceId);
      if (domainId == null) continue;

      const bounds = this.#exteriorIndexes
        .get(domainId)
        ?.getBounds(instanceId);
      if (!bounds) continue;

      for (const entityId of
        this.#occupancyIndex.queryBounds(domainId, bounds)) {
        result.add(entityId);
      }
    }

    return [...result];
  }

}

export function isPortalTraversable(portal) {
  return portalTraversableState(portal);
}
