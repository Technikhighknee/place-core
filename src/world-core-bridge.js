import { isPortalTraversable } from "./registry.js";
import {
  PLACE_REGISTRY_BRIDGE_ATTACH_TOKEN,
  PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN
} from "./registry/support.js";
import { compareStrings } from "./utils.js";

function sortedStrings(values) {
  if (values == null) return null;
  return [...values].sort();
}

function stringListsEqual(a, b) {
  const left = sortedStrings(a);
  const right = sortedStrings(b);
  if (left == null || right == null) return left === right;
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function nearlyEqual(a, b) {
  return Math.abs(a - b) <= 1e-9;
}

function pointsEqual(a, b) {
  return a?.length === b?.length &&
    a.every((point, index) =>
      nearlyEqual(point.x, b[index].x) &&
      nearlyEqual(point.y, b[index].y)
    );
}

export class WorldCoreBridge {
  #registry = null;
  #unsubscribeWorldEvents = null;
  #sameDomainPortalCrossings = new Map();
  #onRegistryDispose = null;
  #ownedTopologyIds = new Set();

  constructor({
    world,
    navigation,
    startJourney,
    stopJourney,
    Navigation = null,
    existingDomainPolicy = "reject"
  } = {}) {
    if (!world) throw new TypeError("WorldCoreBridge requires world");
    if (typeof world.subscribeEvents !== "function") {
      throw new TypeError(
        "WorldCoreBridge requires world-core World.subscribeEvents"
      );
    }
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

  #navigationMethod(name) {
    const method = this.navigation?.[name];
    if (typeof method !== "function") {
      throw new TypeError(
        `WorldCoreBridge navigation requires ${name} for road-bound place state`
      );
    }
    return method.bind(this.navigation);
  }

  attachRegistry(
    registry,
    onDispose = null,
    token = null
  ) {
    if (token !== PLACE_REGISTRY_BRIDGE_ATTACH_TOKEN) {
      throw new Error(
        "WorldCoreBridge.attachRegistry must be called through PlaceRegistry.attachWorldCoreBridge"
      );
    }
    if (!registry || typeof registry !== "object") {
      throw new TypeError("WorldCoreBridge registry is required");
    }
    if (onDispose != null && typeof onDispose !== "function") {
      throw new TypeError("WorldCoreBridge onDispose callback must be a function");
    }
    if (this.#registry === registry) {
      if (onDispose != null) this.#onRegistryDispose = onDispose;
      return this;
    }
    if (this.#registry && this.#registry !== registry) {
      throw new Error(
        "WorldCoreBridge is already attached to a different PlaceRegistry"
      );
    }

    const unsubscribe = this.world.subscribeEvents(
      (event) => this.#handleWorldEvent(event),
      {
        onError: (error, event) => {
          registry.emit?.(
            "world-event-bridge-error",
            {
              worldEventType: event?.type ?? null,
              message:
                error instanceof Error
                  ? error.message
                  : String(error)
            }
          );
        }
      }
    );

    this.#unsubscribeWorldEvents?.();
    this.#sameDomainPortalCrossings.clear();
    this.#registry = registry;
    this.#onRegistryDispose = onDispose;
    this.#unsubscribeWorldEvents = unsubscribe;
    return this;
  }

  dispose() {
    if (this.#registry?.bridge === this) {
      if ((this.#registry.instances?.size ?? 0) > 0) {
        throw new Error(
          "cannot dispose WorldCoreBridge while its PlaceRegistry has materialized places"
        );
      }
      if ((this.#registry.activeTravels?.size ?? 0) > 0) {
        throw new Error(
          "cannot dispose WorldCoreBridge while its PlaceRegistry has active travel"
        );
      }
    }

    let removed = false;
    let unsubscribeError = null;
    try {
      removed = this.#unsubscribeWorldEvents?.() ?? false;
    } catch (error) {
      unsubscribeError = error;
    }

    const onDispose = this.#onRegistryDispose;
    this.#unsubscribeWorldEvents = null;
    this.#sameDomainPortalCrossings.clear();
    this.#registry = null;
    this.#onRegistryDispose = null;

    let detachError = null;
    try {
      onDispose?.();
    } catch (error) {
      detachError = error;
    }

    if (unsubscribeError && detachError) {
      throw new AggregateError(
        [unsubscribeError, detachError],
        "failed to dispose WorldCoreBridge cleanly"
      );
    }
    if (unsubscribeError) throw unsubscribeError;
    if (detachError) throw detachError;
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
    if (!this.#registry || event?.entityId == null) {
      return;
    }

    if (event.type === "entityDomainTransferred") {
      const crossing =
        this.#sameDomainPortalCrossings.get(event.entityId) ??
        null;
      if (crossing) {
        this.#sameDomainPortalCrossings.delete(event.entityId);
        this.#emitSameDomainPortalEvent(
          "portal-abort",
          event.entityId,
          crossing,
          { reason: "domain-transfer" }
        );
      }

      const entity = this.world.getEntity(event.entityId);
      if (entity) {
        this.#registry.updateEntityOccupancy(entity);
      }
      return;
    }

    if (event.type === "entityRemoved") {
      const crossing =
        this.#sameDomainPortalCrossings.get(event.entityId) ??
        null;
      if (crossing) {
        this.#sameDomainPortalCrossings.delete(event.entityId);
        this.#emitSameDomainPortalEvent(
          "portal-abort",
          event.entityId,
          crossing,
          { reason: "entity-removed" }
        );
      }

      this.#registry._handleWorldEntityRemoved(
        PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
        event.entityId
      );
      return;
    }

    if (event.roadId == null) return;

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

  #captureDomainMaterializationState(domainId) {
    const domainInstance =
      this.navigation.domainInstances?.get?.(domainId) ??
      null;
    const roadEffects = [];

    if (domainInstance?.roadEffects) {
      for (const [roadId, effects] of domainInstance.roadEffects) {
        for (const [effectId, effect] of effects) {
          roadEffects.push({
            roadId,
            effectId,
            effect: {
              blocked: effect.blocked === true,
              costMultiplier: effect.costMultiplier ?? 1,
              traversalDelaySeconds:
                effect.traversalDelaySeconds ?? 0
            }
          });
        }
      }
    }

    roadEffects.sort((a, b) =>
      compareStrings(String(a.roadId), String(b.roadId)) ||
      compareStrings(String(a.effectId), String(b.effectId))
    );

    return {
      domainId,
      existed: Boolean(this.world.getDomain?.(domainId)),
      previousBinding:
        this.navigation.domainBindings?.get?.(domainId) ??
        null,
      roadEffects
    };
  }

  materializePlace(instance, definition) {
    const newTopologyIds = [
      ...new Set(
        definition.layers
          .filter((layer) =>
            layer.navigation != null
          )
          .map((layer) => layer.topologyId)
          .filter((topologyId) =>
            topologyId != null &&
            !this.navigation.topologies?.has?.(
              topologyId
            )
          )
      )
    ];

    if (
      newTopologyIds.length > 0 &&
      typeof this.navigation.removeTopology !==
        "function"
    ) {
      throw new Error(
        "world-core NavigationRegistry.removeTopology is required for transactional topology materialization"
      );
    }

    const receipt = {
      domains: definition.layers.map((layer) =>
        this.#captureDomainMaterializationState(
          instance.layerDomains.get(layer.id)
        )
      ),
      newTopologyIds
    };

    const domainStateById = new Map(
      receipt.domains.map((state) => [
        state.domainId,
        state
      ])
    );

    if (
      receipt.domains.some(
        (state) => !state.existed
      ) &&
      typeof this.world.removeDomain !==
        "function"
    ) {
      throw new Error(
        "world-core World.removeDomain is required for transactional domain materialization rollback"
      );
    }

    const hasRoadBindings =
      definition.boundaries.some(
        (boundary) =>
          boundary.roadBindings?.length
      ) ||
      definition.portals.some(
        (portal) =>
          portal.roadBindings?.length
      ) ||
      [...(
        instance.dynamicPortals?.values?.() ??
        []
      )].some(
        (portal) =>
          portal.roadBindings?.length
      );

    if (
      hasRoadBindings &&
      typeof this.navigation
        .clearDomainOverrides !==
        "function"
    ) {
      throw new Error(
        "world-core NavigationRegistry.clearDomainOverrides is required for transactional road-effect rollback"
      );
    }

    if (
      receipt.domains.some(
        (state) =>
          state.roadEffects.length > 0
      ) &&
      typeof this.navigation
        .setDomainRoadEffect !==
        "function"
    ) {
      throw new Error(
        "world-core NavigationRegistry.setDomainRoadEffect is required to restore adopted domain road effects"
      );
    }

    // Preflight ownership and existing bindings before mutating either core.
    for (const layer of definition.layers) {
      const domainId = instance.layerDomains.get(layer.id);
      const domainState =
        domainStateById.get(domainId);

      if (domainState.existed &&
          this.existingDomainPolicy !== "adopt") {
        throw new Error(
          `world-core domain already exists and cannot be adopted: ${domainId}`
        );
      }

      if (
        domainState.existed &&
        this.existingDomainPolicy === "adopt" &&
        domainId === "default"
      ) {
        throw new Error(
          "world-core default domain cannot be adopted because it cannot be removed"
        );
      }

      if (layer.topologyId != null) {
        if (typeof this.navigation.bindDomain !== "function") {
          throw new Error(
            "world-core NavigationRegistry is required for topology-bound place layers"
          );
        }

        if (
          domainState.previousBinding == null &&
          typeof this.navigation.unbindDomain !==
            "function"
        ) {
          throw new Error(
            "world-core NavigationRegistry.unbindDomain is required for transactional topology binding rollback"
          );
        }

        if (domainState.previousBinding != null &&
            domainState.previousBinding !== layer.topologyId) {
          throw new Error(
            `world-core domain ${domainId} is already bound to incompatible topology ${domainState.previousBinding}; expected ${layer.topologyId}`
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
        }

        if (layer.topologyId != null) {
          const existingBinding =
            this.navigation.domainBindings?.get?.(domainId) ??
            null;
          if (existingBinding == null) {
            this.navigation.bindDomain(domainId, layer.topologyId);
          }
        }
      }
    } catch (error) {
      let rollbackError = null;
      try {
        this.rollbackMaterializePlace(instance, definition, receipt);
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `failed to materialize place ${String(instance.id)} and restore prior world-core state`
        );
      }
      throw error;
    }

    for (const topologyId of newTopologyIds) {
      this.#ownedTopologyIds.add(
        topologyId
      );
    }
    return receipt;
  }

  rollbackMaterializePlace(instance, definition, receipt) {
    if (!receipt?.domains) {
      throw new TypeError("materialization receipt is required");
    }

    const errors = [];

    const hasRoadBindings =
      definition.boundaries.some(
        (boundary) =>
          boundary.roadBindings?.length
      ) ||
      definition.portals.some(
        (portal) =>
          portal.roadBindings?.length
      ) ||
      [...(
        instance.dynamicPortals?.values?.() ??
        []
      )].some(
        (portal) =>
          portal.roadBindings?.length
      );

    for (const state of [...receipt.domains].reverse()) {
      try {
        if (
          state.existed &&
          !this.world.getDomain?.(state.domainId)
        ) {
          if (
            typeof this.world.addDomain !==
              "function"
          ) {
            throw new Error(
              "world-core World.addDomain is required to restore materialized domains"
            );
          }
          this.world.addDomain({
            id: state.domainId
          });
        }

        if (
          hasRoadBindings ||
          state.roadEffects.length > 0
        ) {
          if (
            typeof this.navigation
              .clearDomainOverrides !==
              "function"
          ) {
            throw new Error(
              "world-core NavigationRegistry.clearDomainOverrides is required to restore domain road effects"
            );
          }
          this.navigation.clearDomainOverrides(
            state.domainId
          );
        }

        const currentBinding =
          this.navigation.domainBindings?.get?.(state.domainId) ??
          null;

        if (state.previousBinding == null) {
          if (currentBinding != null) {
            if (
              typeof this.navigation.unbindDomain !==
                "function"
            ) {
              throw new Error(
                "world-core NavigationRegistry.unbindDomain is required to restore domain bindings"
              );
            }
            this.navigation.unbindDomain(
              state.domainId
            );
          }
        } else if (currentBinding !== state.previousBinding) {
          if (
            typeof this.navigation.bindDomain !==
              "function"
          ) {
            throw new Error(
              "world-core NavigationRegistry.bindDomain is required to restore domain bindings"
            );
          }
          this.navigation.bindDomain(
            state.domainId,
            state.previousBinding
          );
        }

        if (state.previousBinding != null) {
          for (const saved of state.roadEffects) {
            this.#navigationMethod(
              "setDomainRoadEffect"
            )(
              state.domainId,
              saved.effectId,
              saved.roadId,
              saved.effect
            );
          }
        }

        if (
          !state.existed &&
          this.world.getDomain?.(state.domainId)
        ) {
          if (
            typeof this.world.removeDomain !==
              "function"
          ) {
            throw new Error(
              "world-core World.removeDomain is required to rollback newly materialized domains"
            );
          }
          this.world.removeDomain(
            state.domainId
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }

    for (
      const topologyId of
      [...(receipt.newTopologyIds ?? [])].reverse()
    ) {
      try {
        if (
          this.navigation.topologies?.has?.(
            topologyId
          )
        ) {
          this.navigation.removeTopology(
            topologyId
          );
          this.#ownedTopologyIds.delete(
            topologyId
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `failed to roll back materialization for place ${String(instance.id)}`
      );
    }
    return true;
  }

  releaseDefinitionTopologies(
    definition
  ) {
    if (!definition || !Array.isArray(definition.layers)) {
      throw new TypeError(
        "definition with layers is required"
      );
    }

    const candidates = [
      ...new Set(
        definition.layers
          .map((layer) => layer.topologyId)
          .filter((topologyId) =>
            topologyId != null &&
            this.#ownedTopologyIds.has(
              topologyId
            )
          )
      )
    ];

    if (!candidates.length) {
      return 0;
    }

    const referencedByOther =
      new Set();
    for (
      const other of
      this.#registry?.definitions?.values?.() ??
      []
    ) {
      if (other.id === definition.id) {
        continue;
      }
      for (const layer of other.layers) {
        if (layer.topologyId != null) {
          referencedByOther.add(
            layer.topologyId
          );
        }
      }
    }

    const boundTopologyIds = new Set(
      this.navigation.domainBindings
        ?.values?.() ??
      []
    );

    const targets = [];
    for (const topologyId of candidates) {
      if (
        referencedByOther.has(topologyId) ||
        boundTopologyIds.has(topologyId) ||
        this.navigation.defaultTopologyId ===
          topologyId
      ) {
        continue;
      }

      if (
        !this.navigation.topologies
          ?.has?.(topologyId)
      ) {
        this.#ownedTopologyIds.delete(
          topologyId
        );
        continue;
      }

      targets.push(topologyId);
    }

    if (!targets.length) {
      return 0;
    }

    if (
      typeof this.navigation.removeTopology !==
      "function"
    ) {
      throw new Error(
        "world-core NavigationRegistry.removeTopology is required to release place definition topologies"
      );
    }
    if (
      typeof this.navigation.registerTopology !==
      "function"
    ) {
      throw new Error(
        "world-core NavigationRegistry.registerTopology is required for transactional topology release rollback"
      );
    }

    const removed = [];
    try {
      for (const topologyId of targets) {
        const topology =
          this.navigation.topologies.get(
            topologyId
          );
        const didRemove =
          this.navigation.removeTopology(
            topologyId
          );
        if (!didRemove) {
          throw new Error(
            `failed to remove navigation topology ${topologyId}`
          );
        }
        removed.push({
          topologyId,
          topology
        });
      }
    } catch (error) {
      const rollbackErrors = [];
      for (
        const {
          topologyId,
          topology
        } of removed.reverse()
      ) {
        try {
          if (
            !this.navigation.topologies
              ?.has?.(topologyId)
          ) {
            this.navigation.registerTopology(
              topologyId,
              topology
            );
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            rollbackError
          );
        }
      }

      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "failed to release place definition topologies and restore prior navigation state"
        );
      }
      throw error;
    }

    for (const topologyId of targets) {
      this.#ownedTopologyIds.delete(
        topologyId
      );
    }
    return targets.length;
  }

  ensureLayerTopology(definition, layer) {
    if (layer.topologyId == null) return null;

    const existing = this.navigation.topologies?.get?.(layer.topologyId);
    if (existing) {
      if (layer.navigation != null) {
        this.#assertLayerTopologyCompatible(
          existing,
          definition,
          layer
        );
      }
      return existing;
    }

    if (layer.navigation == null) {
      throw new Error(
        `navigation topology ${layer.topologyId} referenced by place layer ${definition.id}:${layer.id} is not registered`
      );
    }

    if (!this.NavigationClass) {
      throw new Error(
        `layer ${definition.id}:${layer.id} contains navigation data but WorldCoreBridge was not given the world-core Navigation class`
      );
    }

    const nav = new this.NavigationClass(layer.navigation.options ?? {});
    for (const region of layer.navigation.regions) nav.addRegion(region);
    for (const node of layer.navigation.nodes) {
      nav.addNode({
        id: node.id,
        x: node.x,
        y: node.y,
        junctionRadius: node.junctionRadius,
        regionId: node.regionId
      });
    }
    for (const road of layer.navigation.roads) {
      nav.addRoad({
        id: road.id,
        from: road.from,
        to: road.to,
        shape: road.shape,
        width: road.width,
        surface: road.surface,
        bidirectional: road.bidirectional,
        enabled: road.enabled,
        allowedProfiles: road.allowedProfiles,
        blockedProfiles: road.blockedProfiles,
        tags: road.tags
      });
    }

    this.navigation.registerTopology(layer.topologyId, nav);
    return nav;
  }

  #assertLayerTopologyCompatible(existing, definition, layer) {
    const expected = layer.navigation;
    const label = `${definition.id}:${layer.id}`;
    const mismatch = (detail) => {
      throw new Error(
        `navigation topology ${layer.topologyId} is incompatible with place layer ${label}: ${detail}`
      );
    };

    const expectedOptions = expected.options ?? {};
    const actualOptions = {
      spatialCellSize: existing.nodeIndex?.cellSize,
      routeCacheSize: existing.routeCacheSize,
      routeCacheMaxLegs: existing.routeCacheMaxLegs,
      routeCacheMaxTotalLegs: existing.routeCacheMaxTotalLegs,
      hierarchicalRouteCacheSize: existing.hierarchicalRouteCacheSize,
      regionalRouteCacheSize: existing.regionalRouteCacheSize
    };
    for (const [key, value] of Object.entries(expectedOptions)) {
      if (actualOptions[key] !== value) {
        mismatch(`navigation option ${key} differs`);
      }
    }

    const existingRegionIds = [...(existing.regions?.keys?.() ?? [])].sort();
    const expectedRegionIds = expected.regions.map((region) => region.id).sort();
    if (!stringListsEqual(existingRegionIds, expectedRegionIds)) {
      mismatch("region set differs");
    }

    if (existing.nodes?.size !== expected.nodes.length) {
      mismatch("node count differs");
    }
    for (const node of expected.nodes) {
      const actual = existing.nodes?.get?.(node.id);
      if (!actual) mismatch(`missing node ${node.id}`);
      if (!nearlyEqual(actual.position?.x, node.x) ||
          !nearlyEqual(actual.position?.y, node.y)) {
        mismatch(`node ${node.id} position differs`);
      }
      if (!nearlyEqual(actual.junctionRadius ?? 0, node.junctionRadius ?? 0)) {
        mismatch(`node ${node.id} junctionRadius differs`);
      }
      if ((actual.regionId ?? null) !== (node.regionId ?? null)) {
        mismatch(`node ${node.id} region differs`);
      }
    }

    if (existing.roads?.size !== expected.roads.length) {
      mismatch("road count differs");
    }
    for (const road of expected.roads) {
      const actual = existing.roads?.get?.(road.id);
      if (!actual) mismatch(`missing road ${road.id}`);

      if (actual.from !== road.from || actual.to !== road.to) {
        mismatch(`road ${road.id} endpoints differ`);
      }
      if (!nearlyEqual(actual.width, road.width)) {
        mismatch(`road ${road.id} width differs`);
      }
      if (actual.surface !== road.surface) {
        mismatch(`road ${road.id} surface differs`);
      }
      if (actual.bidirectional !== road.bidirectional) {
        mismatch(`road ${road.id} directionality differs`);
      }
      if (actual.enabled !== road.enabled) {
        mismatch(`road ${road.id} enabled state differs`);
      }
      if (!stringListsEqual(actual.allowedProfiles, road.allowedProfiles)) {
        mismatch(`road ${road.id} allowedProfiles differ`);
      }
      if (!stringListsEqual(actual.blockedProfiles, road.blockedProfiles)) {
        mismatch(`road ${road.id} blockedProfiles differ`);
      }
      if (!stringListsEqual(actual.tags, road.tags)) {
        mismatch(`road ${road.id} tags differ`);
      }

      const actualShape = (actual.points ?? []).slice(1, -1);
      if (!pointsEqual(actualShape, road.shape ?? [])) {
        mismatch(`road ${road.id} shape differs`);
      }
    }
  }

  unmaterializePlace(instance, definition) {
    const domains =
      [...instance.layerDomains.values()];
    for (const domainId of domains) {
      const domain =
        this.world.getDomain?.(domainId);
      if (domain?.entityCount > 0) {
        throw new Error(
          `cannot remove occupied world-core domain ${domainId}`
        );
      }

      const obstacleField =
        domain != null
          ? this.world.domainObstacleFields
              ?.get?.(domain.handle) ??
            null
          : null;
      if (
        obstacleField?.obstacles?.size >
        0
      ) {
        throw new Error(
          `cannot remove world-core domain ${domainId} with obstacles`
        );
      }
    }

    const receipt = {
      domains: domains.map((domainId) =>
        this.#captureDomainMaterializationState(
          domainId
        )
      )
    };

    const existingDomains = receipt.domains.filter(
      (state) => state.existed
    );

    if (
      existingDomains.length > 0 &&
      typeof this.world.removeDomain !==
        "function"
    ) {
      throw new Error(
        "world-core World.removeDomain is required to unmaterialize place domains"
      );
    }

    if (
      existingDomains.length > 0 &&
      typeof this.world.addDomain !==
        "function"
    ) {
      throw new Error(
        "world-core World.addDomain is required for transactional unmaterialization rollback"
      );
    }

    if (
      receipt.domains.some(
        (state) =>
          state.previousBinding != null
      )
    ) {
      if (
        typeof this.navigation.unbindDomain !==
          "function"
      ) {
        throw new Error(
          "world-core NavigationRegistry.unbindDomain is required to unmaterialize bound place domains"
        );
      }
      if (
        typeof this.navigation.bindDomain !==
          "function"
      ) {
        throw new Error(
          "world-core NavigationRegistry.bindDomain is required for transactional unmaterialization rollback"
        );
      }
    }

    if (
      receipt.domains.some(
        (state) =>
          state.roadEffects.length > 0
      )
    ) {
      if (
        typeof this.navigation
          .clearDomainOverrides !==
          "function"
      ) {
        throw new Error(
          "world-core NavigationRegistry.clearDomainOverrides is required to unmaterialize domain road effects"
        );
      }
      if (
        typeof this.navigation
          .setDomainRoadEffect !==
          "function"
      ) {
        throw new Error(
          "world-core NavigationRegistry.setDomainRoadEffect is required for transactional road-effect rollback"
        );
      }
    }

    try {
      for (const portal of definition.portals) {
        this.clearPortalEffects(
          instance,
          portal
        );
      }
      for (
        const dynamicPortal of
        instance.dynamicPortals?.values?.() ??
        []
      ) {
        this.clearPortalEffects(
          instance,
          dynamicPortal
        );
      }
      for (
        const boundary of
        definition.boundaries
      ) {
        this.clearBoundaryEffects(
          instance,
          boundary
        );
      }

      for (
        const state of
        [...receipt.domains].reverse()
      ) {
        if (state.roadEffects.length > 0) {
          this.navigation.clearDomainOverrides(
            state.domainId
          );
        }
        if (state.previousBinding != null) {
          this.navigation.unbindDomain(
            state.domainId
          );
        }
        if (state.existed) {
          this.world.removeDomain(
            state.domainId
          );
        }
      }
    } catch (error) {
      let rollbackError = null;
      try {
        this.rollbackMaterializePlace(
          instance,
          definition,
          receipt
        );
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

  syncBoundaryState(instance, boundary) {
    if (!boundary?.roadBindings?.length) return;
    const domainId = instance.layerDomains.get(boundary.layerId);
    if (!domainId) return;

    const effectId =
      `place-core-boundary:${String(instance.id)}:${boundary.id}`;
    const errors = [];

    for (const binding of boundary.roadBindings) {
      try {
        if (boundary.enabled) {
          this.#navigationMethod(
            "setDomainRoadEffect"
          )(
            domainId,
            effectId,
            binding.roadId,
            { blocked: true }
          );
        } else {
          this.#navigationMethod(
            "removeDomainRoadEffect"
          )(
            domainId,
            effectId,
            binding.roadId
          );
        }
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
        `failed to sync boundary effects for ${boundary.id}`
      );
    }
  }

  clearBoundaryEffects(instance, boundary) {
    if (!boundary?.roadBindings?.length) return;
    const domainId = instance.layerDomains.get(boundary.layerId);
    if (!domainId) return;

    const effectId =
      `place-core-boundary:${String(instance.id)}:${boundary.id}`;
    const errors = [];

    for (const binding of boundary.roadBindings) {
      try {
        this.#navigationMethod(
          "removeDomainRoadEffect"
        )(
          domainId,
          effectId,
          binding.roadId
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
        `failed to clear boundary effects for ${boundary.id}`
      );
    }
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

    const errors = [];

    for (const binding of portalDefinition.roadBindings) {
      const domainId = instance.layerDomains.get(binding.layerId);
      if (!domainId) continue;

      try {
        if (blocked || traversalDelaySeconds > 0) {
          this.#navigationMethod(
            "setDomainRoadEffect"
          )(
            domainId,
            effectId,
            binding.roadId,
            {
              blocked,
              traversalDelaySeconds
            }
          );
        } else {
          this.#navigationMethod(
            "removeDomainRoadEffect"
          )(
            domainId,
            effectId,
            binding.roadId
          );
        }
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
        `failed to sync portal effects for ${portalDefinition.id}`
      );
    }
  }

  clearPortalEffects(instance, portalDefinition) {
    if (!portalDefinition?.roadBindings?.length) return;
    const effectId =
      `place-core:${String(instance.id)}:${portalDefinition.id}`;
    const errors = [];

    for (const binding of portalDefinition.roadBindings) {
      const domainId =
        instance.layerDomains.get(binding.layerId);
      if (!domainId) continue;

      try {
        this.#navigationMethod(
          "removeDomainRoadEffect"
        )(
          domainId,
          effectId,
          binding.roadId
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
        `failed to clear portal effects for ${portalDefinition.id}`
      );
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
