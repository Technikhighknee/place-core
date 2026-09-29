import { isPortalTraversable } from "./registry.js";

export class WorldCoreBridge {
  #registry = null;
  #unsubscribeWorldEvents = null;
  #sameDomainPortalCrossings = new Map();

  constructor({
    world,
    navigation,
    startJourney,
    stopJourney,
    Navigation = null,
    existingDomainPolicy = "reject"
  } = {}) {
    if (!world) throw new TypeError("WorldCoreBridge requires world");
    if (!navigation) throw new TypeError("WorldCoreBridge requires navigation");
    if (typeof startJourney !== "function") throw new TypeError("WorldCoreBridge requires world-core startJourney");
    if (typeof stopJourney !== "function") throw new TypeError("WorldCoreBridge requires world-core stopJourney");
    this.world = world;
    this.navigation = navigation;
    this.startJourneyFn = startJourney;
    this.stopJourneyFn = stopJourney;
    if (existingDomainPolicy !== "reject" &&
        existingDomainPolicy !== "adopt") {
      throw new TypeError(
        'existingDomainPolicy must be "reject" or "adopt"'
      );
    }

    this.NavigationClass = Navigation;
    this.existingDomainPolicy = existingDomainPolicy;
  }

  attachRegistry(registry) {
    if (!registry || typeof registry !== "object") {
      throw new TypeError("WorldCoreBridge registry is required");
    }
    if (this.#registry === registry) return this;
    if (this.#registry && this.#registry !== registry) {
      throw new Error(
        "WorldCoreBridge is already attached to a different PlaceRegistry"
      );
    }

    this.#unsubscribeWorldEvents?.();
    this.#unsubscribeWorldEvents = null;
    this.#sameDomainPortalCrossings.clear();
    this.#registry = registry;

    if (typeof this.world.subscribeEvents === "function") {
      this.#unsubscribeWorldEvents = this.world.subscribeEvents(
        (event) => this.#handleWorldEvent(event)
      );
    }

    return this;
  }

  dispose() {
    const removed = this.#unsubscribeWorldEvents?.() ?? false;
    this.#unsubscribeWorldEvents = null;
    this.#sameDomainPortalCrossings.clear();
    this.#registry = null;
    return removed;
  }

  #journeyLegForRoad(entity, roadId) {
    const journey = entity?.journey;
    if (!journey) return null;
    const leg = journey.prefixLeg ??
      journey.route?.legs?.[journey.legIndex] ??
      null;
    return leg?.roadId === roadId ? leg : null;
  }

  #resolveSameDomainPortalCrossing(entity, roadId) {
    if (!this.#registry || !entity || roadId == null) return null;
    const domainId = entity.domainId ?? "default";
    const navigation = this.navigationForDomain(domainId);
    const road = navigation?.roads?.get?.(roadId);
    const leg = this.#journeyLegForRoad(entity, roadId);
    if (!road || !leg) return null;

    const startNodeId = leg.reversed ? road.to : road.from;
    const endNodeId = leg.reversed ? road.from : road.to;

    for (const portal of this.#registry.getPortalsForRoad(domainId, roadId)) {
      if (!portal?.connected || !isPortalTraversable(portal)) continue;
      if (portal.a?.domainId !== domainId || portal.b?.domainId !== domainId) {
        continue;
      }

      if (
        portal.a.nodeId === startNodeId &&
        portal.b.nodeId === endNodeId
      ) {
        return {
          portal,
          from: portal.a,
          to: portal.b,
          domainId,
          roadId
        };
      }

      if (
        portal.bidirectional !== false &&
        portal.b.nodeId === startNodeId &&
        portal.a.nodeId === endNodeId
      ) {
        return {
          portal,
          from: portal.b,
          to: portal.a,
          domainId,
          roadId
        };
      }
    }

    return null;
  }

  #emitSameDomainPortalEvent(type, entityId, crossing, extra = {}) {
    this.#registry?.emit(type, {
      entityId,
      portalKey: crossing.portal.key,
      placeId: crossing.portal.instanceId,
      portalId: crossing.portal.id,
      roadId: crossing.roadId,
      fromDomainId: crossing.domainId,
      toDomainId: crossing.domainId,
      fromSpaceId: crossing.from.spaceId ?? null,
      toSpaceId: crossing.to.spaceId ?? null,
      sameDomain: true,
      ...extra
    });
  }

  #handleWorldEvent(event) {
    if (!this.#registry || event?.entityId == null || event?.roadId == null) {
      return;
    }

    if (event.type === "roadEntered") {
      const entity = this.world.getEntity(event.entityId);
      const crossing = this.#resolveSameDomainPortalCrossing(
        entity,
        event.roadId
      );
      if (!crossing) return;

      const previous = this.#sameDomainPortalCrossings.get(event.entityId);
      if (previous) {
        this.#emitSameDomainPortalEvent(
          "portal-abort",
          event.entityId,
          previous,
          { reason: "superseded-road-entry" }
        );
      }

      this.#sameDomainPortalCrossings.set(event.entityId, crossing);
      this.#emitSameDomainPortalEvent(
        "portal-enter",
        event.entityId,
        crossing
      );
      return;
    }

    if (event.type !== "roadLeft") return;

    const crossing = this.#sameDomainPortalCrossings.get(event.entityId);
    if (!crossing || crossing.roadId !== event.roadId) return;
    this.#sameDomainPortalCrossings.delete(event.entityId);

    if (event.reason != null) {
      this.#emitSameDomainPortalEvent(
        "portal-abort",
        event.entityId,
        crossing,
        { reason: event.reason }
      );
      return;
    }

    this.#emitSameDomainPortalEvent(
      "portal-traverse",
      event.entityId,
      crossing
    );
    this.#emitSameDomainPortalEvent(
      "portal-exit",
      event.entityId,
      crossing
    );
  }

  materializePlace(instance, definition) {
    const addedDomains = [];
    const newlyBoundDomains = [];

    // Preflight ownership and existing bindings before mutating either core.
    for (const layer of definition.layers) {
      const domainId = instance.layerDomains.get(layer.id);
      const existingDomain = this.world.getDomain?.(domainId);

      if (existingDomain && this.existingDomainPolicy !== "adopt") {
        throw new Error(
          `world-core domain already exists and cannot be adopted: ${domainId}`
        );
      }

      if (layer.topologyId != null) {
        if (typeof this.navigation.bindDomain !== "function") {
          throw new Error(
            "world-core NavigationRegistry is required for topology-bound place layers"
          );
        }

        const existingBinding =
          this.navigation.domainBindings?.get?.(domainId) ??
          null;
        if (existingBinding != null &&
            existingBinding !== layer.topologyId) {
          throw new Error(
            `world-core domain ${domainId} is already bound to incompatible topology ${existingBinding}; expected ${layer.topologyId}`
          );
        }
      }
    }

    try {
      for (const layer of definition.layers) {
        this.ensureLayerTopology(definition, layer);
        const domainId = instance.layerDomains.get(layer.id);

        if (!this.world.getDomain?.(domainId)) {
          this.world.addDomain({ id: domainId });
          addedDomains.push(domainId);
        }

        if (layer.topologyId != null) {
          const existingBinding =
            this.navigation.domainBindings?.get?.(domainId) ??
            null;
          if (existingBinding == null) {
            this.navigation.bindDomain(domainId, layer.topologyId);
            newlyBoundDomains.push(domainId);
          }
        }
      }
    } catch (error) {
      for (const domainId of newlyBoundDomains.reverse()) {
        this.navigation.unbindDomain?.(domainId);
      }
      for (const domainId of addedDomains.reverse()) {
        this.world.removeDomain?.(domainId);
      }
      throw error;
    }
  }

  ensureLayerTopology(definition, layer) {
    if (layer.topologyId == null || layer.navigation == null) return null;
    const existing = this.navigation.topologies?.get?.(layer.topologyId);
    if (existing) return existing;
    if (!this.NavigationClass) {
      throw new Error(`layer ${definition.id}:${layer.id} contains navigation data but WorldCoreBridge was not given the world-core Navigation class`);
    }
    const nav = new this.NavigationClass(layer.navigation.options ?? {});
    for (const region of layer.navigation.regions) nav.addRegion(region);
    for (const node of layer.navigation.nodes) nav.addNode({
      id: node.id, x: node.x, y: node.y,
      junctionRadius: node.junctionRadius, regionId: node.regionId
    });
    for (const road of layer.navigation.roads) {
      const input = { id: road.id, from: road.from, to: road.to };
      for (const key of ["shape", "width", "surface", "bidirectional", "enabled", "allowedProfiles", "blockedProfiles", "tags"]) {
        if (road[key] !== undefined) input[key] = road[key];
      }
      nav.addRoad(input);
    }
    this.navigation.registerTopology(layer.topologyId, nav);
    return nav;
  }

  unmaterializePlace(instance, definition) {
    const domains = [...instance.layerDomains.values()];
    for (const domainId of domains) {
      const domain = this.world.getDomain?.(domainId);
      if (domain?.entityCount > 0) {
        throw new Error(`cannot remove occupied world-core domain ${domainId}`);
      }
    }

    try {
      for (const portal of definition.portals) {
        this.clearPortalEffects(instance, portal);
      }
      for (const dynamicPortal of instance.dynamicPortals?.values?.() ?? []) {
        this.clearPortalEffects(instance, dynamicPortal);
      }
      for (const boundary of definition.boundaries) {
        this.clearBoundaryEffects(instance, boundary);
      }

      for (const domainId of [...domains].reverse()) {
        this.navigation.clearDomainOverrides?.(domainId);
        this.navigation.unbindDomain?.(domainId);
        this.world.removeDomain?.(domainId);
      }
    } catch (error) {
      let rollbackError = null;
      try {
        this.#restorePlaceMaterialization(instance, definition);
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to remove place ${String(instance.id)} and restore bridge state`
        );
      }
      throw error;
    }
  }

  #restorePlaceMaterialization(instance, definition) {
    for (const layer of definition.layers) {
      this.ensureLayerTopology(definition, layer);
      const domainId = instance.layerDomains.get(layer.id);
      if (!this.world.getDomain?.(domainId)) {
        this.world.addDomain({ id: domainId });
      }
      if (layer.topologyId != null) {
        this.navigation.bindDomain?.(domainId, layer.topologyId);
      }
    }

    for (const boundary of definition.boundaries) {
      const resolved =
        this.#registry?.getBoundary?.(instance.id, boundary.id) ??
        boundary;
      this.syncBoundaryState(instance, resolved);
    }

    for (const portal of definition.portals) {
      const resolved =
        this.#registry?.resolvePortal?.(instance.id, portal.id) ??
        portal;
      this.syncPortalState(instance, portal, resolved);
    }

    for (const dynamicPortal of instance.dynamicPortals?.values?.() ?? []) {
      const resolved =
        this.#registry?.resolvePortal?.(instance.id, dynamicPortal.id) ??
        dynamicPortal;
      this.syncDynamicPortal(instance, dynamicPortal, resolved);
    }
  }

  syncBoundaryState(instance, boundary) {
    if (!boundary?.roadBindings?.length) return;
    const domainId = instance.layerDomains.get(boundary.layerId);
    if (!domainId) return;
    const effectId = `place-core-boundary:${String(instance.id)}:${boundary.id}`;
    for (const binding of boundary.roadBindings) {
      if (boundary.enabled) this.navigation.setDomainRoadEffect?.(domainId, effectId, binding.roadId, { blocked: true });
      else this.navigation.removeDomainRoadEffect?.(domainId, effectId, binding.roadId);
    }
  }

  clearBoundaryEffects(instance, boundary) {
    if (!boundary?.roadBindings?.length) return;
    const domainId = instance.layerDomains.get(boundary.layerId);
    if (!domainId) return;
    const effectId = `place-core-boundary:${String(instance.id)}:${boundary.id}`;
    for (const binding of boundary.roadBindings) this.navigation.removeDomainRoadEffect?.(domainId, effectId, binding.roadId);
  }

  syncPortalState(instance, portalDefinition, resolvedPortal) {
    if (!portalDefinition?.roadBindings?.length) return;

    const blocked = !isPortalTraversable(resolvedPortal);
    const sameDomain = Boolean(
      resolvedPortal?.connected &&
      resolvedPortal.a?.domainId != null &&
      resolvedPortal.a.domainId === resolvedPortal.b?.domainId
    );
    const traversalDelaySeconds = sameDomain
      ? Math.max(0, Number(resolvedPortal.transitionCost ?? 0))
      : 0;

    if (!Number.isFinite(traversalDelaySeconds)) {
      throw new RangeError(
        `portal ${portalDefinition.id} transitionCost must be finite`
      );
    }

    const effectId =
      `place-core:${String(instance.id)}:${portalDefinition.id}`;

    for (const binding of portalDefinition.roadBindings) {
      const domainId = instance.layerDomains.get(binding.layerId);
      if (!domainId) continue;

      if (blocked || traversalDelaySeconds > 0) {
        this.navigation.setDomainRoadEffect?.(
          domainId,
          effectId,
          binding.roadId,
          {
            blocked,
            traversalDelaySeconds
          }
        );
      } else {
        this.navigation.removeDomainRoadEffect?.(
          domainId,
          effectId,
          binding.roadId
        );
      }
    }
  }

  clearPortalEffects(instance, portalDefinition) {
    if (!portalDefinition?.roadBindings?.length) return;
    const effectId = `place-core:${String(instance.id)}:${portalDefinition.id}`;
    for (const binding of portalDefinition.roadBindings) {
      const domainId = instance.layerDomains.get(binding.layerId);
      if (domainId) this.navigation.removeDomainRoadEffect?.(domainId, effectId, binding.roadId);
    }
  }

  syncDynamicPortal(instance, portal, resolvedPortal) {
    this.syncPortalState(instance, portal, resolvedPortal);
  }
  removeDynamicPortal(instance, resolvedPortal) {
    this.clearPortalEffects(instance, resolvedPortal);
  }

  getEntity(entityId) { return this.world.getEntity(entityId); }
  navigationForDomain(domainId) {
    if (typeof this.navigation.navigationForDomain === "function") return this.navigation.navigationForDomain(domainId);
    return this.navigation;
  }

  planLocalRoute({ domainId, position, destinationNodeId, mobility, options }) {
    if (destinationNodeId == null) return null;
    const navigation = this.navigationForDomain(domainId);
    if (!navigation) return null;
    return navigation.findRouteFromPosition(position, destinationNodeId, mobility, options);
  }

  planLocalRouteCostsToMany({
    domainId,
    position,
    destinationNodeIds,
    mobility,
    options
  }) {
    const navigation = this.navigationForDomain(domainId);
    if (!navigation) return new Map();

    const ids = [...new Set(destinationNodeIds ?? [])]
      .filter((id) => id != null)
      .sort();
    if (!ids.length) return new Map();

    if (typeof navigation.findRouteCostsFromPositionToMany === "function") {
      return navigation.findRouteCostsFromPositionToMany(
        position,
        ids,
        mobility,
        options
      );
    }

    const result = new Map();
    for (const destinationNodeId of ids) {
      const planned = navigation.findRouteFromPosition(
        position,
        destinationNodeId,
        mobility,
        options
      );
      if (planned) result.set(destinationNodeId, planned.estimatedSeconds);
    }
    return result;
  }

  startLocalJourney(entityId, destinationNodeId, options) {
    return this.startJourneyFn(this.world, this.navigation, entityId, destinationNodeId, options);
  }

  stopLocalJourney(entityId) {
    const entity = this.world.getEntity(entityId);
    if (entity) this.stopJourneyFn(entity, this.world);
  }

  transferEntity(entityId, endpoint) {
    return this.world.transferEntity(entityId, {
      domainId: endpoint.domainId,
      position: endpoint.position
    });
  }
}
