import {
  DynamicAabbIndex,
  geometryBounds,
  normalizeTransform,
  squaredDistance,
  transformBounds,
  transformPoint
} from "./geometry.js";
import { compilePlace, CompiledPlaceDefinition } from "./definition.js";
import {
  assertId,
  assertStringId,
  BoundedEventQueue,
  cloneJson,
  deepFreeze
} from "./utils.js";

const PORTAL_STATE_KEYS = new Set([
  "enabled", "open", "locked", "blocked", "destroyed", "blocksWhenClosed"
]);

const BOUNDARY_STATE_KEYS = new Set(["enabled"]);

function occupancyKey(placeId, spaceId) {
  return `${String(placeId)}\u0000${spaceId}`;
}

function addToSetMap(map, key, value) {
  let set = map.get(key);
  if (!set) map.set(key, set = new Set());
  set.add(value);
}

function removeFromSetMap(map, key, value) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

function validateResolvedEndpoint(endpoint, label = "endpoint") {
  if (!endpoint || typeof endpoint !== "object") throw new TypeError(`${label} is required`);
  assertStringId(endpoint.domainId, `${label}.domainId`);
  if (!endpoint.position || !Number.isFinite(endpoint.position.x) || !Number.isFinite(endpoint.position.y)) {
    throw new TypeError(`${label}.position requires finite x/y`);
  }
}

function cloneResolvedEndpoint(endpoint) {
  if (!endpoint) return null;
  return deepFreeze({
    domainId: endpoint.domainId,
    position: { x: endpoint.position.x, y: endpoint.position.y },
    nodeId: endpoint.nodeId ?? null,
    placeId: endpoint.placeId ?? null,
    layerId: endpoint.layerId ?? null,
    spaceId: endpoint.spaceId ?? null,
    slot: endpoint.slot ?? null
  });
}

function normalizeDynamicPortal(portal) {
  assertStringId(portal.id, "dynamic portal id");
  validateResolvedEndpoint(portal.a, `dynamic portal ${portal.id}.a`);
  validateResolvedEndpoint(portal.b, `dynamic portal ${portal.id}.b`);
  return deepFreeze({
    id: portal.id,
    kind: portal.kind ?? "portal",
    tags: Object.freeze([...new Set(portal.tags ?? [])]),
    a: cloneResolvedEndpoint(portal.a),
    b: cloneResolvedEndpoint(portal.b),
    bidirectional: portal.bidirectional !== false,
    transitionCost: Number.isFinite(portal.transitionCost) ? Math.max(0, portal.transitionCost) : 0,
    enabled: portal.enabled !== false,
    open: portal.open !== false,
    locked: portal.locked === true,
    blocked: portal.blocked === true,
    destroyed: portal.destroyed === true,
    blocksWhenClosed: portal.blocksWhenClosed === true,
    roadBindings: Object.freeze((portal.roadBindings ?? []).map((binding) => deepFreeze({
      layerId: binding.layerId ?? null,
      domainId: binding.domainId ?? null,
      roadId: assertStringId(binding.roadId, "dynamic portal road binding roadId")
    }))),
    metadata: deepFreeze(cloneJson(portal.metadata ?? null)),
    dynamic: true
  });
}

export function isPortalTraversable(portal) {
  if (!portal || portal.enabled === false || portal.blocked === true) return false;
  if (portal.destroyed === true) return true;
  if (portal.locked === true) return false;
  if (portal.blocksWhenClosed === true && portal.open === false) return false;
  return true;
}

export class PlaceInstance {
  constructor({
    id,
    definition,
    layerDomains,
    parentPlaceId = null,
    placement = null,
    placementDomainId = null,
    metadata = null
  }) {
    assertId(id, "place instance id");
    this.id = id;
    this.definitionId = definition.id;
    this.definitionHash = definition.contentHash;
    this.parentPlaceId = parentPlaceId;
    this.placement = normalizeTransform(placement ?? {});
    this.placementDomainId = placementDomainId;
    this.layerDomains = new Map(layerDomains);
    this.portalOverrides = new Map();
    this.boundaryOverrides = new Map();
    this.dynamicPortals = new Map();
    this.externalBindings = new Map();
    this.metadata = cloneJson(metadata);
    this.revision = 0;
  }

  setPlacement(placement, placementDomainId = this.placementDomainId) {
    this.placement = normalizeTransform(placement);
    this.placementDomainId = placementDomainId;
    this.revision += 1;
  }

  setExternalBinding(slot, endpoint) {
    assertStringId(slot, "external slot");
    validateResolvedEndpoint(endpoint, `external binding ${slot}`);
    this.externalBindings.set(slot, cloneResolvedEndpoint({ ...endpoint, slot }));
    this.revision += 1;
  }

  clearExternalBinding(slot) {
    const removed = this.externalBindings.delete(slot);
    if (removed) this.revision += 1;
    return removed;
  }
}

export class PlaceRegistry {
  #events;
  #bridge = null;
  #footprintIndexes = new Map();
  #entityContexts = new Map();
  #placeOccupants = new Map();
  #spaceOccupants = new Map();

  constructor({
    eventQueueLimit = 10_000,
    eventOverflowPolicy = "drop-newest",
    footprintCellSize = 128
  } = {}) {
    this.definitions = new Map();
    this.instances = new Map();
    this.domainBindings = new Map();
    this.graphRevision = 0;
    this.time = 0;
    this.footprintCellSize = footprintCellSize;
    this.#events = new BoundedEventQueue({
      limit: eventQueueLimit,
      overflowPolicy: eventOverflowPolicy
    });
  }

  attachWorldCoreBridge(bridge) {
    this.#bridge = bridge ?? null;
    bridge?.attachRegistry?.(this);
    return this;
  }

  registerDefinition(input, options) {
    const definition = input instanceof CompiledPlaceDefinition ? input : compilePlace(input, options);
    const existing = this.definitions.get(definition.id);
    if (existing && existing.contentHash !== definition.contentHash) {
      throw new Error(`place definition ${definition.id} already registered with a different content hash`);
    }
    if (!existing) {
      this.definitions.set(definition.id, definition);
      this.graphRevision += 1;
    }
    return existing ?? definition;
  }

  removeDefinition(definitionId) {
    for (const instance of this.instances.values()) {
      if (instance.definitionId === definitionId) {
        throw new Error(`cannot remove definition ${definitionId} while instance ${String(instance.id)} uses it`);
      }
    }
    const removed = this.definitions.delete(definitionId);
    if (removed) this.graphRevision += 1;
    return removed;
  }

  createPlace({
    id,
    definitionId,
    layerDomains = null,
    parentPlaceId = null,
    placement = null,
    placementDomainId = null,
    externalBindings = null,
    metadata = null
  }) {
    assertId(id, "place id");
    if (this.instances.has(id)) throw new Error(`place instance already exists: ${String(id)}`);
    const definition = this.definitions.get(definitionId);
    if (!definition) throw new Error(`unknown place definition: ${definitionId}`);
    if (parentPlaceId != null && !this.instances.has(parentPlaceId)) {
      throw new Error(`unknown parent place: ${String(parentPlaceId)}`);
    }

    const domainMap = new Map();
    for (const layer of definition.layers) {
      const supplied = layerDomains instanceof Map ? layerDomains.get(layer.id) : layerDomains?.[layer.id];
      const domainId = supplied ?? `place:${String(id)}:${layer.id}`;
      assertStringId(domainId, `domain for layer ${layer.id}`);
      if (this.domainBindings.has(domainId)) throw new Error(`world domain already bound to a place layer: ${domainId}`);
      domainMap.set(layer.id, domainId);
    }

    const instance = new PlaceInstance({
      id,
      definition,
      layerDomains: domainMap,
      parentPlaceId,
      placement,
      placementDomainId,
      metadata
    });

    if (externalBindings) {
      for (const [slot, endpoint] of Object.entries(externalBindings)) {
        instance.setExternalBinding(slot, endpoint);
      }
      instance.revision = 0;
    }

    this.instances.set(id, instance);
    for (const [layerId, domainId] of domainMap) {
      this.domainBindings.set(domainId, { placeId: id, layerId });
    }

    try {
      this.#bridge?.materializePlace?.(instance, definition);
      for (const portal of definition.portals) {
        this.#bridge?.syncPortalState?.(instance, portal, this.resolvePortal(id, portal.id));
      }
      for (const boundary of definition.boundaries) {
        this.#bridge?.syncBoundaryState?.(instance, this.resolveBoundary(id, boundary.id));
      }
      this.#reindexFootprint(instance, definition);
    } catch (error) {
      for (const domainId of domainMap.values()) this.domainBindings.delete(domainId);
      this.instances.delete(id);
      throw error;
    }

    this.graphRevision += 1;
    this.emitEvent("place-created", { placeId: id, definitionId });
    return instance;
  }

  removePlace(placeId) {
    const instance = this.instances.get(placeId);
    if (!instance) return false;
    for (const child of this.instances.values()) {
      if (child.parentPlaceId === placeId) throw new Error(`cannot remove place ${String(placeId)} while child ${String(child.id)} exists`);
    }
    const occupants = this.#placeOccupants.get(placeId);
    if (occupants?.size) throw new Error(`cannot remove occupied place ${String(placeId)}`);

    const definition = this.definitions.get(instance.definitionId);
    this.#bridge?.unmaterializePlace?.(instance, definition);

    for (const domainId of instance.layerDomains.values()) this.domainBindings.delete(domainId);
    this.#unindexFootprint(instance);
    this.instances.delete(placeId);
    this.graphRevision += 1;
    this.emitEvent("place-removed", { placeId, definitionId: instance.definitionId });
    return true;
  }

  getDefinition(id) { return this.definitions.get(id) ?? null; }
  getPlace(id) { return this.instances.get(id) ?? null; }

  getLayerDomain(placeId, layerId) {
    return this.instances.get(placeId)?.layerDomains.get(layerId) ?? null;
  }

  getDomainBinding(domainId) {
    return this.domainBindings.get(domainId) ?? null;
  }

  setPlacement(placeId, placement, placementDomainId) {
    const instance = this.#requirePlace(placeId);
    const definition = this.#requireDefinition(instance.definitionId);
    this.#unindexFootprint(instance);
    instance.setPlacement(placement, placementDomainId);
    this.#reindexFootprint(instance, definition);
    this.graphRevision += 1;
    this.emitEvent("place-moved", { placeId, placement: instance.placement, placementDomainId: instance.placementDomainId });
    return instance;
  }

  setExternalBinding(placeId, slot, endpoint) {
    const instance = this.#requirePlace(placeId);
    instance.setExternalBinding(slot, endpoint);
    this.graphRevision += 1;
    this.emitEvent("external-binding-changed", { placeId, slot });
    return instance.externalBindings.get(slot);
  }

  clearExternalBinding(placeId, slot) {
    const instance = this.#requirePlace(placeId);
    const removed = instance.clearExternalBinding(slot);
    if (removed) {
      this.graphRevision += 1;
      this.emitEvent("external-binding-changed", { placeId, slot, cleared: true });
    }
    return removed;
  }

  resolvePortal(placeId, portalId) {
    const instance = this.#requirePlace(placeId);
    const definition = this.#requireDefinition(instance.definitionId);
    const dynamic = instance.dynamicPortals.get(portalId);
    if (dynamic) return dynamic;
    const portal = definition.getPortal(portalId);
    if (!portal) return null;
    const override = instance.portalOverrides.get(portalId) ?? null;
    return deepFreeze({
      ...portal,
      ...(override ?? {}),
      a: this.#resolveEndpoint(instance, portal.a),
      b: this.#resolveEndpoint(instance, portal.b),
      placeId,
      dynamic: false
    });
  }

  *resolvedPortals(placeId = null) {
    const instances = placeId == null ? this.instances.values() : [this.#requirePlace(placeId)];
    for (const instance of instances) {
      const definition = this.#requireDefinition(instance.definitionId);
      for (const portal of definition.portals) yield this.resolvePortal(instance.id, portal.id);
      for (const portal of instance.dynamicPortals.values()) yield portal;
    }
  }

  setPortalState(placeId, portalId, patch) {
    const instance = this.#requirePlace(placeId);
    if (!patch || typeof patch !== "object") throw new TypeError("portal state patch is required");

    const dynamic = instance.dynamicPortals.get(portalId);
    if (dynamic) {
      const next = { ...dynamic };
      for (const [key, value] of Object.entries(patch)) {
        if (!PORTAL_STATE_KEYS.has(key)) throw new Error(`unsupported portal state property: ${key}`);
        if (typeof value !== "boolean") throw new TypeError(`portal state ${key} must be boolean`);
        next[key] = value;
      }
      const normalized = normalizeDynamicPortal(next);
      instance.dynamicPortals.set(portalId, normalized);
      instance.revision += 1;
      this.graphRevision += 1;
      this.#bridge?.syncDynamicPortal?.(instance, normalized, normalized);
      this.emitEvent("portal-state-changed", { placeId, portalId, state: patch, dynamic: true });
      return normalized;
    }

    const definition = this.#requireDefinition(instance.definitionId);
    const portal = definition.getPortal(portalId);
    if (!portal) throw new Error(`unknown portal ${portalId} in place ${String(placeId)}`);
    const previous = instance.portalOverrides.get(portalId) ?? {};
    const next = { ...previous };
    for (const [key, value] of Object.entries(patch)) {
      if (!PORTAL_STATE_KEYS.has(key)) throw new Error(`unsupported portal state property: ${key}`);
      if (typeof value !== "boolean") throw new TypeError(`portal state ${key} must be boolean`);
      if (value === portal[key]) delete next[key];
      else next[key] = value;
    }
    if (Object.keys(next).length === 0) instance.portalOverrides.delete(portalId);
    else instance.portalOverrides.set(portalId, deepFreeze(next));
    instance.revision += 1;
    this.graphRevision += 1;
    const resolved = this.resolvePortal(placeId, portalId);
    this.#bridge?.syncPortalState?.(instance, portal, resolved);
    this.emitEvent("portal-state-changed", { placeId, portalId, state: patch, dynamic: false });
    return resolved;
  }

  addPortal(placeId, portal) {
    const instance = this.#requirePlace(placeId);
    const definition = this.#requireDefinition(instance.definitionId);
    if (definition.getPortal(portal.id) || instance.dynamicPortals.has(portal.id)) {
      throw new Error(`portal already exists: ${portal.id}`);
    }
    const normalized = normalizeDynamicPortal({ ...portal, placeId });
    instance.dynamicPortals.set(normalized.id, normalized);
    instance.revision += 1;
    this.graphRevision += 1;
    this.#bridge?.syncDynamicPortal?.(instance, normalized, normalized);
    this.emitEvent("portal-added", { placeId, portalId: normalized.id });
    return normalized;
  }

  removePortal(placeId, portalId) {
    const instance = this.#requirePlace(placeId);
    const portal = instance.dynamicPortals.get(portalId);
    if (!portal) throw new Error("only dynamic instance portals may be removed");
    this.#bridge?.removeDynamicPortal?.(instance, portal);
    instance.dynamicPortals.delete(portalId);
    instance.revision += 1;
    this.graphRevision += 1;
    this.emitEvent("portal-removed", { placeId, portalId });
    return true;
  }

  resolveBoundary(placeId, boundaryId) {
    const instance = this.#requirePlace(placeId);
    const definition = this.#requireDefinition(instance.definitionId);
    const boundary = definition.getBoundary(boundaryId);
    if (!boundary) return null;
    return deepFreeze({
      ...boundary,
      ...(instance.boundaryOverrides.get(boundaryId) ?? {}),
      placeId
    });
  }

  setBoundaryState(placeId, boundaryId, patch) {
    const instance = this.#requirePlace(placeId);
    const definition = this.#requireDefinition(instance.definitionId);
    const boundary = definition.getBoundary(boundaryId);
    if (!boundary) throw new Error(`unknown boundary ${boundaryId} in place ${String(placeId)}`);
    const previous = instance.boundaryOverrides.get(boundaryId) ?? {};
    const next = { ...previous };
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!BOUNDARY_STATE_KEYS.has(key)) throw new Error(`unsupported boundary state property: ${key}`);
      if (typeof value !== "boolean") throw new TypeError(`boundary state ${key} must be boolean`);
      if (value === boundary[key]) delete next[key];
      else next[key] = value;
    }
    if (Object.keys(next).length === 0) instance.boundaryOverrides.delete(boundaryId);
    else instance.boundaryOverrides.set(boundaryId, deepFreeze(next));
    instance.revision += 1;
    this.graphRevision += 1;
    const resolved = this.resolveBoundary(placeId, boundaryId);
    this.#bridge?.syncBoundaryState?.(instance, resolved);
    this.emitEvent("boundary-state-changed", { placeId, boundaryId, state: patch });
    return resolved;
  }

  locate(domainId, position) {
    const binding = this.domainBindings.get(domainId);
    if (!binding) return {
      domainId,
      position: { x: position.x, y: position.y },
      placeId: null,
      layerId: null,
      places: [],
      spaces: [],
      deepestSpace: null
    };
    const instance = this.#requirePlace(binding.placeId);
    const definition = this.#requireDefinition(instance.definitionId);
    const spaces = definition.locateSpaces(binding.layerId, position);
    return {
      domainId,
      position: { x: position.x, y: position.y },
      placeId: instance.id,
      layerId: binding.layerId,
      places: this.#placeChain(instance.id),
      spaces,
      deepestSpace: spaces.length ? spaces[spaces.length - 1] : null
    };
  }

  locateEntity(entity) {
    if (!entity) throw new TypeError("entity is required");
    return this.locate(entity.domainId ?? "default", entity.position);
  }

  placesAt(domainId, position) {
    const index = this.#footprintIndexes.get(domainId);
    if (!index) return [];
    const ids = index.queryPoint(position);
    const result = [];
    for (const id of ids) {
      const instance = this.instances.get(id);
      const definition = instance && this.definitions.get(instance.definitionId);
      if (!instance || !definition?.footprint) continue;
      const local = this.#toLocalPlacementPoint(position, instance);
      if (definition.footprint && this.#pointInDefinitionFootprint(local, definition)) result.push(instance);
    }
    return result;
  }

  resolveAnchor(placeId, anchorId) {
    const instance = this.#requirePlace(placeId);
    const definition = this.#requireDefinition(instance.definitionId);
    const anchor = definition.getAnchor(anchorId);
    if (!anchor) return null;
    return deepFreeze({
      ...anchor,
      placeId,
      domainId: instance.layerDomains.get(anchor.layerId)
    });
  }

  findAnchors({ placeId = null, tag = null, kind = null, spaceId = null } = {}) {
    const result = [];
    const instances = placeId == null ? this.instances.values() : [this.#requirePlace(placeId)];
    for (const instance of instances) {
      const definition = this.#requireDefinition(instance.definitionId);
      let candidates;
      if (tag != null) candidates = definition.getAnchorsByTag(tag);
      else if (spaceId != null) candidates = definition.getAnchorsForSpace(spaceId);
      else candidates = definition.anchors;
      for (const anchor of candidates) {
        if (kind != null && anchor.kind !== kind) continue;
        if (spaceId != null && anchor.spaceId !== spaceId) continue;
        result.push(this.resolveAnchor(instance.id, anchor.id));
      }
    }
    return result;
  }

  findNearestAnchor({ domainId, position, tag = null, kind = null, placeId = null } = {}) {
    let best = null;
    let bestD2 = Infinity;
    for (const anchor of this.findAnchors({ placeId, tag, kind })) {
      if (anchor.domainId !== domainId) continue;
      const d2 = squaredDistance(position, anchor.position);
      if (d2 < bestD2 || (d2 === bestD2 && anchor.id < best.id)) {
        best = anchor;
        bestD2 = d2;
      }
    }
    return best ? { anchor: best, distance: Math.sqrt(bestD2) } : null;
  }

  updateEntityOccupancy(entity) {
    assertId(entity.id, "entity.id");
    const next = this.locateEntity(entity);
    const previous = this.#entityContexts.get(entity.id) ?? null;
    const prevPlace = previous?.placeId ?? null;
    const nextPlace = next.placeId ?? null;

    if (prevPlace !== nextPlace) {
      if (prevPlace != null) {
        removeFromSetMap(this.#placeOccupants, prevPlace, entity.id);
        this.emitEvent("place-leave", { entityId: entity.id, placeId: prevPlace });
      }
      if (nextPlace != null) {
        addToSetMap(this.#placeOccupants, nextPlace, entity.id);
        this.emitEvent("place-enter", { entityId: entity.id, placeId: nextPlace });
      }
    }

    const previousSpaceIds = new Set(previous?.spaces?.map((space) => space.id) ?? []);
    const nextSpaceIds = new Set(next.spaces.map((space) => space.id));

    if (prevPlace != null) {
      for (const spaceId of previousSpaceIds) {
        if (prevPlace === nextPlace && nextSpaceIds.has(spaceId)) continue;
        removeFromSetMap(this.#spaceOccupants, occupancyKey(prevPlace, spaceId), entity.id);
        this.emitEvent("space-leave", { entityId: entity.id, placeId: prevPlace, spaceId });
      }
    }
    if (nextPlace != null) {
      for (const spaceId of nextSpaceIds) {
        if (prevPlace === nextPlace && previousSpaceIds.has(spaceId)) continue;
        addToSetMap(this.#spaceOccupants, occupancyKey(nextPlace, spaceId), entity.id);
        this.emitEvent("space-enter", { entityId: entity.id, placeId: nextPlace, spaceId });
      }
    }

    this.#entityContexts.set(entity.id, next);
    return next;
  }

  removeEntityOccupancy(entityId) {
    const previous = this.#entityContexts.get(entityId);
    if (!previous) return false;
    if (previous.placeId != null) {
      removeFromSetMap(this.#placeOccupants, previous.placeId, entityId);
      for (const space of previous.spaces) {
        removeFromSetMap(this.#spaceOccupants, occupancyKey(previous.placeId, space.id), entityId);
      }
    }
    this.#entityContexts.delete(entityId);
    return true;
  }

  entitiesInPlace(placeId) {
    return this.#placeOccupants.get(placeId) ?? EMPTY_SET;
  }

  entitiesInSpace(placeId, spaceId) {
    return this.#spaceOccupants.get(occupancyKey(placeId, spaceId)) ?? EMPTY_SET;
  }

  emitEvent(type, data = {}) {
    const event = deepFreeze({ time: this.time, type, ...cloneJson(data) });
    this.#events.push(event);
    return event;
  }

  drainEvents(target = []) { return this.#events.drain(target); }
  peekEvents() { return this.#events.peek(); }

  configureEventQueue(options) {
    this.#events.configure(options);
    return { limit: this.#events.limit, overflowPolicy: this.#events.overflowPolicy };
  }

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
    let dynamicPortalCount = 0;
    let externalBindingCount = 0;
    for (const instance of this.instances.values()) {
      portalOverrideCount += instance.portalOverrides.size;
      boundaryOverrideCount += instance.boundaryOverrides.size;
      dynamicPortalCount += instance.dynamicPortals.size;
      externalBindingCount += instance.externalBindings.size;
    }
    let footprintCells = 0;
    for (const index of this.#footprintIndexes.values()) footprintCells += index.cellCount;
    return {
      definitionCount: this.definitions.size,
      instanceCount: this.instances.size,
      boundDomainCount: this.domainBindings.size,
      portalOverrideCount,
      boundaryOverrideCount,
      dynamicPortalCount,
      externalBindingCount,
      occupancyEntityCount: this.#entityContexts.size,
      occupiedPlaceCount: this.#placeOccupants.size,
      occupiedSpaceCount: this.#spaceOccupants.size,
      footprintDomainCount: this.#footprintIndexes.size,
      footprintCells,
      graphRevision: this.graphRevision,
      eventQueueSize: this.#events.size,
      droppedEventCount: this.#events.dropped
    };
  }

  assertInternalConsistency() {
    for (const [domainId, binding] of this.domainBindings) {
      const instance = this.instances.get(binding.placeId);
      if (!instance) throw new Error(`domain ${domainId} references missing place ${String(binding.placeId)}`);
      if (instance.layerDomains.get(binding.layerId) !== domainId) {
        throw new Error(`domain binding mismatch for ${domainId}`);
      }
    }
    for (const instance of this.instances.values()) {
      const definition = this.definitions.get(instance.definitionId);
      if (!definition) throw new Error(`place ${String(instance.id)} references missing definition`);
      if (definition.contentHash !== instance.definitionHash) throw new Error(`definition hash mismatch for place ${String(instance.id)}`);
      for (const [layerId, domainId] of instance.layerDomains) {
        const binding = this.domainBindings.get(domainId);
        if (!binding || binding.placeId !== instance.id || binding.layerId !== layerId) {
          throw new Error(`missing domain reverse binding for ${domainId}`);
        }
      }
      for (const portalId of instance.portalOverrides.keys()) {
        if (!definition.getPortal(portalId)) throw new Error(`orphan portal override ${portalId}`);
      }
      for (const boundaryId of instance.boundaryOverrides.keys()) {
        if (!definition.getBoundary(boundaryId)) throw new Error(`orphan boundary override ${boundaryId}`);
      }
    }
    return this.getDiagnostics();
  }

  #resolveEndpoint(instance, endpoint) {
    if (endpoint.kind === "local") {
      return deepFreeze({
        domainId: instance.layerDomains.get(endpoint.layerId),
        position: { x: endpoint.position.x, y: endpoint.position.y },
        nodeId: endpoint.nodeId,
        placeId: instance.id,
        layerId: endpoint.layerId,
        spaceId: endpoint.spaceId,
        slot: null
      });
    }
    return instance.externalBindings.get(endpoint.slot) ?? null;
  }

  #placeChain(placeId) {
    const chain = [];
    const seen = new Set();
    let current = this.instances.get(placeId);
    while (current) {
      if (seen.has(current.id)) throw new Error("place parent cycle detected");
      seen.add(current.id);
      chain.push(current);
      current = current.parentPlaceId == null ? null : this.instances.get(current.parentPlaceId);
    }
    chain.reverse();
    return chain;
  }

  #requirePlace(id) {
    const place = this.instances.get(id);
    if (!place) throw new Error(`unknown place: ${String(id)}`);
    return place;
  }

  #requireDefinition(id) {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`unknown place definition: ${id}`);
    return definition;
  }

  #reindexFootprint(instance, definition) {
    if (!definition.footprint || !instance.placementDomainId) return;
    let index = this.#footprintIndexes.get(instance.placementDomainId);
    if (!index) this.#footprintIndexes.set(
      instance.placementDomainId,
      index = new DynamicAabbIndex(this.footprintCellSize)
    );
    index.set(instance.id, transformBounds(geometryBounds(definition.footprint), instance.placement));
  }

  #unindexFootprint(instance) {
    if (!instance.placementDomainId) return;
    const index = this.#footprintIndexes.get(instance.placementDomainId);
    if (!index) return;
    index.delete(instance.id);
    if (index.size === 0) this.#footprintIndexes.delete(instance.placementDomainId);
  }

  #toLocalPlacementPoint(point, instance) {
    const { x, y, rotation, scale } = instance.placement;
    const dx = point.x - x;
    const dy = point.y - y;
    const c = Math.cos(-rotation);
    const s = Math.sin(-rotation);
    return {
      x: (dx * c - dy * s) / scale,
      y: (dx * s + dy * c) / scale
    };
  }

  #pointInDefinitionFootprint(point, definition) {
    const geometry = definition.footprint;
    if (geometry.type === "aabb") {
      return point.x >= geometry.minX && point.x <= geometry.maxX &&
        point.y >= geometry.minY && point.y <= geometry.maxY;
    }
    if (geometry.type === "circle") {
      const dx = point.x - geometry.center.x;
      const dy = point.y - geometry.center.y;
      return dx * dx + dy * dy <= geometry.radius * geometry.radius;
    }
    let inside = false;
    const points = geometry.points;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i];
      const b = points[j];
      if (((a.y > point.y) !== (b.y > point.y)) &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  }
}

const EMPTY_SET = Object.freeze(new Set());
