import {
  DynamicAabbIndex,
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
  cloneJson,
  deepFreeze
} from "./utils.js";

const PORTAL_STATE_KEYS = ["enabled", "open", "locked", "blocked", "destroyed"];

function normalizeAttachment(value, label) {
  if (!value || typeof value !== "object") throw new TypeError(`${label} is required`);
  assertStringId(value.domainId, `${label}.domainId`);
  if (!value.position || !Number.isFinite(value.position.x) || !Number.isFinite(value.position.y)) {
    throw new TypeError(`${label}.position must be a Vec2`);
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

function typedIdKey(id) {
  return `${typeof id}:${String(id)}`;
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

export class PlaceInstance {
  #portalOverrides = new Map();
  #boundaryOverrides = new Map();
  #spaceOverrides = new Map();
  #dynamicPortals = new Map();

  constructor(data) {
    this.id = data.id;
    this.definitionId = data.definitionId;
    this.parentId = data.parentId ?? null;
    this.layerDomains = new Map(data.layerDomains);
    this.attachments = new Map(data.attachments);
    this.placement = data.placement;
    this.metadata = cloneJson(data.metadata ?? null);
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
}

export class PlaceRegistry {
  #definitions = new Map();
  #instances = new Map();
  #domainBindings = new Map();
  #exteriorIndexes = new Map();
  #indexedExteriorDomains = new Map();
  #placementChildren = new Map();
  #semanticChildren = new Map();
  #portalRecords = new Map();
  #portalsByDomain = new Map();
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
    this.#captureEvents = options.captureEvents === true;
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
    if (!bridge || typeof bridge !== "object") throw new TypeError("bridge must be an object");
    this.#bridge = bridge;
    if (typeof bridge.attachRegistry === "function") bridge.attachRegistry(this);
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
    const instance = this.#instances.get(instanceId);
    if (!instance) return null;
    const definition = this.#definitions.get(instance.definitionId);
    const candidates = options.tag ? definition.getAnchorsByTag(options.tag) : definition.anchors;
    let best = null;
    let bestDistanceSq = Infinity;
    for (const anchor of candidates) {
      if (options.layerId != null && anchor.layerId !== options.layerId) continue;
      const dx = anchor.position.x - position.x;
      const dy = anchor.position.y - position.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq) { best = anchor; bestDistanceSq = distanceSq; }
    }
    return best ? { ...best, placeId: instanceId, domainId: instance.layerDomains.get(best.layerId), distance: Math.sqrt(bestDistanceSq) } : null;
  }

  getAnchorsForDomain(domainId, options = {}) {
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

  findNearestPortal(domainId, position, options = {}) {
    let best = null;
    let bestDistanceSq = Infinity;

    for (const portal of this.getPortalsForDomain(domainId)) {
      if (options.traversableOnly !== false && !portal.traversable) continue;
      if (options.kind != null && portal.kind !== options.kind) continue;
      if (options.tag != null && !portal.tags?.includes(options.tag)) continue;

      const endpoint = portal.a.domainId === domainId
        ? portal.a
        : portal.b.domainId === domainId
          ? portal.b
          : null;
      if (!endpoint) continue;

      const distanceSq = squaredDistance(position, endpoint.position);
      if (distanceSq < bestDistanceSq ||
          (distanceSq === bestDistanceSq && portal.key.localeCompare(best?.portal.key ?? "") < 0)) {
        best = { portal, endpoint };
        bestDistanceSq = distanceSq;
      }
    }

    return best ? {
      portal: best.portal,
      endpoint: best.endpoint,
      distance: Math.sqrt(bestDistanceSq)
    } : null;
  }

  getBoundariesForDomain(domainId, options = {}) {
    const binding = this.#domainBindings.get(domainId);
    if (!binding) return [];
    const instance = this.#instances.get(binding.instanceId);
    if (!instance) return [];
    const definition = this.#definitions.get(instance.definitionId);

    const result = [];
    for (const boundary of definition.boundaries) {
      if (boundary.layerId !== binding.layerId) continue;
      const resolved = this.getBoundary(instance.id, boundary.id);
      if (options.enabledOnly === true && !resolved.enabled) continue;
      if (options.kind != null && resolved.kind !== options.kind) continue;
      if (options.tag != null && !resolved.tags?.includes(options.tag)) continue;
      result.push({ ...resolved, placeId: instance.id, domainId });
    }
    return result;
  }

  boundariesIntersectingBounds(domainId, bounds, options = {}) {
    return this.getBoundariesForDomain(domainId, options)
      .filter((boundary) => segmentIntersectsBounds(boundary.a, boundary.b, bounds));
  }

  findNearestBoundary(domainId, position, options = {}) {
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
    assertId(input?.id, "place instance id");
    assertStringId(input?.definitionId, "definitionId");
    if (this.#instances.has(input.id)) throw new Error(`place instance already exists: ${input.id}`);
    const definition = this.#definitions.get(input.definitionId);
    if (!definition) throw new Error(`unknown place definition: ${input.definitionId}`);
    if (input.parentId != null && !this.#instances.has(input.parentId)) throw new Error(`unknown parent place: ${input.parentId}`);

    const layerDomains = new Map();
    const suppliedLayerDomains = input.layerDomains ?? {};
    for (const layer of definition.layers) {
      const domainId = suppliedLayerDomains[layer.id] ?? `${String(input.id)}:${layer.id}`;
      assertStringId(domainId, `layerDomains.${layer.id}`);
      const existing = this.#domainBindings.get(domainId);
      if (existing) throw new Error(`domain ${domainId} is already bound to ${String(existing.instanceId)}:${existing.layerId}`);
      layerDomains.set(layer.id, domainId);
    }

    const attachments = new Map();
    for (const [slot, value] of Object.entries(input.attachments ?? {})) {
      assertStringId(slot, "attachment slot");
      attachments.set(slot, normalizeAttachment(value, `attachment.${slot}`));
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
      metadata: input.metadata
    });

    this.#instances.set(instance.id, instance);
    this.#registerSemanticDependency(instance);
    this.#registerPlacementDependency(instance);
    for (const [layerId, domainId] of layerDomains) {
      this.#domainBindings.set(domainId, { instanceId: instance.id, layerId });
    }
    this.#indexExterior(instance, definition);
    this.#reindexInstancePortals(instance, definition);
    this.#touchState({ travel: true });

    try {
      this.#bridge?.materializePlace?.(instance, definition);
      for (const boundary of definition.boundaries) this.#bridge?.syncBoundaryState?.(instance, boundary);
      for (const portal of definition.portals) this.#bridge?.syncPortalState?.(instance, portal, this.resolvePortal(instance.id, portal.id));
    } catch (error) {
      this.#removePlaceInternal(instance.id, false);
      throw error;
    }

    this.#refreshTrackedOccupancy(
      this.#collectTrackedEntitiesForIndexedPlaces([instance.id])
    );
    this.emit("place-created", { placeId: instance.id, definitionId: definition.id });
    return instance;
  }

  removePlace(instanceId) {
    return this.#removePlaceInternal(instanceId, true);
  }

  #removePlaceInternal(instanceId, callBridge) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return false;
    const semanticChildren = this.#semanticChildren.get(instanceId);
    if (semanticChildren?.size) {
      const childId = [...semanticChildren][0];
      throw new Error(`cannot remove place ${String(instanceId)} while child ${String(childId)} exists`);
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
    this.#unregisterPlacementDependency(instance);
    this.#removeInstancePortals(instance.id);
    this.#instances.delete(instance.id);
    this.#touchState({ travel: true });
    this.emit("place-removed", { placeId: instanceId, definitionId: instance.definitionId });
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
        layerId: endpoint.layerId
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
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    const definition = this.#definitions.get(instance.definitionId);
    const boundary = definition.getBoundary(boundaryId);
    if (!boundary) throw new Error(`unknown boundary ${boundaryId} on place ${String(instanceId)}`);
    const enabled = patch.enabled === undefined
      ? (instance.getBoundaryOverride(boundaryId)?.enabled ?? boundary.enabled)
      : Boolean(patch.enabled);
    instance.setBoundaryOverride(boundaryId, enabled === boundary.enabled ? null : { enabled });
    this.#touchState({ travel: true });
    const resolved = { ...boundary, enabled };
    this.#bridge?.syncBoundaryState?.(instance, resolved);
    this.emit("boundary-state-changed", { placeId: instanceId, boundaryId, enabled });
    return resolved;
  }

  setSpaceState(instanceId, spaceId, patch) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    const definition = this.#definitions.get(instance.definitionId);
    const space = definition.getSpace(spaceId);
    if (!space) throw new Error(`unknown space ${spaceId} on place ${String(instanceId)}`);
    const affectedEntities = [...(this.#entitiesByPlace.get(instanceId) ?? [])];
    const baseEnabled = true;
    const enabled = patch.enabled === undefined
      ? (instance.getSpaceOverride(spaceId)?.enabled ?? baseEnabled)
      : Boolean(patch.enabled);
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
    instance.attachments.set(slot, normalizeAttachment(value, `attachment.${slot}`));
    this.#reindexInstancePortals(instance, definition);
    this.#touchState({ travel: true });
    for (const portal of definition.portals) {
      if ([portal.a, portal.b].some((endpoint) => endpoint.kind === "external" && endpoint.slot === slot)) {
        this.#bridge?.syncPortalState?.(instance, portal, this.resolvePortal(instanceId, portal.id));
      }
    }
    this.emit("place-attachment-changed", { placeId: instanceId, slot, attachment: cloneJson(instance.attachments.get(slot)) });
    return instance.attachments.get(slot);
  }

  clearAttachment(instanceId, slot) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    assertStringId(slot, "attachment slot");
    if (!instance.attachments.has(slot)) return false;

    const definition = this.#definitions.get(instance.definitionId);
    instance.attachments.delete(slot);
    this.#reindexInstancePortals(instance, definition);
    this.#touchState({ travel: true });

    for (const portal of definition.portals) {
      if ([portal.a, portal.b].some((endpoint) =>
        endpoint.kind === "external" && endpoint.slot === slot
      )) {
        this.#bridge?.syncPortalState?.(
          instance,
          portal,
          this.resolvePortal(instanceId, portal.id)
        );
      }
    }

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
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    if (parentId != null && !this.#instances.has(parentId)) throw new Error(`unknown parent place: ${String(parentId)}`);
    if (parentId === instanceId) throw new Error("place cannot parent itself");
    let cursor = parentId == null ? null : this.#instances.get(parentId);
    while (cursor) {
      if (cursor.id === instanceId) throw new Error("place parent cycle");
      cursor = cursor.parentId == null ? null : this.#instances.get(cursor.parentId);
    }
    if (instance.parentId === (parentId ?? null)) return instance;
    const affectedEntities = [...(this.#entitiesByPlace.get(instanceId) ?? [])];
    this.#unregisterSemanticDependency(instance);
    instance.parentId = parentId ?? null;
    this.#registerSemanticDependency(instance);
    this.#touchState();
    this.#refreshTrackedOccupancy(affectedEntities);
    this.emit("place-parent-changed", { placeId: instanceId, parentId: instance.parentId });
    return instance;
  }

  setPortalState(instanceId, portalId, patch) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    const definition = this.#definitions.get(instance.definitionId);
    const base = definition.getPortal(portalId);
    if (!base) {
      const dynamic = instance.dynamicPortals.get(portalId);
      if (!dynamic) throw new Error(`unknown portal ${portalId} on place ${String(instanceId)}`);
      for (const key of PORTAL_STATE_KEYS) {
        if (patch[key] !== undefined) dynamic[key] = Boolean(patch[key]);
      }
      this.#reindexInstancePortals(instance, definition);
      this.#touchState({ travel: true });
      const resolved = this.resolvePortal(instanceId, portalId);
      this.#bridge?.syncPortalState?.(instance, dynamic, resolved);
      this.emit("portal-state-changed", { placeId: instanceId, portalId, state: cloneState(resolved) });
      return resolved;
    }

    const current = { ...base, ...(instance.getPortalOverride(portalId) ?? {}) };
    const next = {};
    for (const key of PORTAL_STATE_KEYS) {
      const value = patch[key] === undefined ? current[key] : Boolean(patch[key]);
      if (value !== base[key]) next[key] = value;
    }
    instance.setPortalOverride(portalId, next);
    this.#reindexInstancePortals(instance, definition);
    this.#touchState({ travel: true });
    const resolved = this.resolvePortal(instanceId, portalId);
    this.#bridge?.syncPortalState?.(instance, base, resolved);
    this.emit("portal-state-changed", { placeId: instanceId, portalId, state: cloneState(resolved) });
    return resolved;
  }

  addInstancePortal(instanceId, spec) {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new Error(`unknown place instance: ${String(instanceId)}`);
    assertStringId(spec?.id, "dynamic portal id");
    const definition = this.#definitions.get(instance.definitionId);
    if (definition.getPortal(spec.id) || instance.dynamicPortals.has(spec.id)) throw new Error(`portal already exists: ${spec.id}`);
    const normalizeResolved = (endpoint, label) => {
      assertStringId(endpoint?.domainId, `${label}.domainId`);
      if (!endpoint.position || !Number.isFinite(endpoint.position.x) || !Number.isFinite(endpoint.position.y)) {
        throw new TypeError(`${label}.position must be a Vec2`);
      }
      return {
        kind: "resolved",
        domainId: endpoint.domainId,
        position: { x: endpoint.position.x, y: endpoint.position.y },
        nodeId: endpoint.nodeId ?? null,
        placeId: endpoint.placeId ?? null,
        spaceId: endpoint.spaceId ?? null,
        layerId: endpoint.layerId ?? null
      };
    };
    const portal = {
      id: spec.id,
      kind: spec.kind ?? "portal",
      tags: [...new Set(spec.tags ?? [])],
      a: normalizeResolved(spec.a, "portal.a"),
      b: normalizeResolved(spec.b, "portal.b"),
      bidirectional: spec.bidirectional !== false,
      transitionCost: Number.isFinite(spec.transitionCost) ? Math.max(0, spec.transitionCost) : 0,
      enabled: spec.enabled !== false,
      open: spec.open !== false,
      locked: spec.locked === true,
      blocked: spec.blocked === true,
      destroyed: spec.destroyed === true,
      blocksWhenClosed: spec.blocksWhenClosed === true,
      roadBindings: (spec.roadBindings ?? []).map((binding, index) => {
        assertStringId(binding.layerId, `dynamic portal roadBindings[${index}].layerId`);
        assertStringId(binding.roadId, `dynamic portal roadBindings[${index}].roadId`);
        if (!instance.layerDomains.has(binding.layerId)) throw new Error(`dynamic portal road binding references unknown layer ${binding.layerId}`);
        return { layerId: binding.layerId, roadId: binding.roadId };
      }),
      metadata: cloneJson(spec.metadata ?? null)
    };
    instance.addDynamicPortal(portal);
    this.#reindexInstancePortals(instance, definition);
    this.#touchState({ travel: true });
    this.#bridge?.syncDynamicPortal?.(instance, portal, this.resolvePortal(instanceId, portal.id));
    this.emit("portal-added", { placeId: instanceId, portalId: portal.id });
    return this.resolvePortal(instanceId, portal.id);
  }

  removeInstancePortal(instanceId, portalId) {
    const instance = this.#instances.get(instanceId);
    if (!instance || !instance.dynamicPortals.has(portalId)) return false;
    const resolved = this.resolvePortal(instanceId, portalId);
    this.#bridge?.removeDynamicPortal?.(instance, resolved);
    instance.removeDynamicPortal(portalId);
    const definition = this.#definitions.get(instance.definitionId);
    this.#reindexInstancePortals(instance, definition);
    this.#touchState({ travel: true });
    this.emit("portal-removed", { placeId: instanceId, portalId });
    return true;
  }

  getPortalsForDomain(domainId) {
    const keys = this.#portalsByDomain.get(domainId);
    if (!keys) return [];
    return [...keys].map((key) => this.#portalRecords.get(key)).filter(Boolean);
  }

  getPortalRecord(key) { return this.#portalRecords.get(key) ?? null; }

  locate(domainId, position) {
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

  setEventCapture(enabled) { this.#captureEvents = Boolean(enabled); }
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
    for (const index of this.#exteriorIndexes.values()) footprintIndexCells += index.cellCount;
    return {
      definitionCount: this.#definitions.size,
      instanceCount: this.#instances.size,
      domainBindingCount: this.#domainBindings.size,
      portalRecordCount: this.#portalRecords.size,
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
      for (const domainId of [record.a.domainId, record.b.domainId]) {
        if (!this.#portalsByDomain.get(domainId)?.has(key)) throw new Error(`portal record ${key} missing domain adjacency`);
      }
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
    if (children?.size === 0) this.#semanticChildren.delete(parentId);
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
      for (const domainId of [record.a.domainId, record.b.domainId]) {
        const set = this.#portalsByDomain.get(domainId);
        set?.delete(key);
        if (set?.size === 0) this.#portalsByDomain.delete(domainId);
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
