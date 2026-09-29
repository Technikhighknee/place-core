import { isPortalTraversable } from "./registry.js";

export class WorldCoreBridge {
  #registry = null;

  constructor({ world, navigation, startJourney, stopJourney, Navigation = null } = {}) {
    if (!world) throw new TypeError("WorldCoreBridge requires world");
    if (!navigation) throw new TypeError("WorldCoreBridge requires navigation");
    if (typeof startJourney !== "function") throw new TypeError("WorldCoreBridge requires world-core startJourney");
    if (typeof stopJourney !== "function") throw new TypeError("WorldCoreBridge requires world-core stopJourney");
    this.world = world;
    this.navigation = navigation;
    this.startJourneyFn = startJourney;
    this.stopJourneyFn = stopJourney;
    this.NavigationClass = Navigation;
  }

  attachRegistry(registry) {
    this.#registry = registry;
  }

  materializePlace(instance, definition) {
    const addedDomains = [];
    const boundDomains = [];
    try {
      for (const layer of definition.layers) {
        this.ensureLayerTopology(definition, layer);
        const domainId = instance.layerDomains.get(layer.id);
        if (!this.world.getDomain?.(domainId)) {
          this.world.addDomain({ id: domainId });
          addedDomains.push(domainId);
        }
        if (layer.topologyId != null) {
          if (typeof this.navigation.bindDomain !== "function") {
            throw new Error("world-core NavigationRegistry is required for topology-bound place layers");
          }
          this.navigation.bindDomain(domainId, layer.topologyId);
          boundDomains.push(domainId);
        }
      }
    } catch (error) {
      for (const domainId of boundDomains.reverse()) this.navigation.unbindDomain?.(domainId);
      for (const domainId of addedDomains.reverse()) this.world.removeDomain?.(domainId);
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
      if (domain?.entityCount > 0) throw new Error(`cannot remove occupied world-core domain ${domainId}`);
    }
    for (const portal of definition.portals) this.clearPortalEffects(instance, portal);
    for (const boundary of definition.boundaries) this.clearBoundaryEffects(instance, boundary);
    for (const domainId of domains.reverse()) {
      this.navigation.clearDomainOverrides?.(domainId);
      this.navigation.unbindDomain?.(domainId);
      this.world.removeDomain?.(domainId);
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
    const effectId = `place-core:${String(instance.id)}:${portalDefinition.id}`;
    for (const binding of portalDefinition.roadBindings) {
      const domainId = instance.layerDomains.get(binding.layerId);
      if (!domainId) continue;
      if (blocked) {
        this.navigation.setDomainRoadEffect?.(domainId, effectId, binding.roadId, { blocked: true });
      } else {
        this.navigation.removeDomainRoadEffect?.(domainId, effectId, binding.roadId);
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
