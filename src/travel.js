import { squaredDistance } from "./geometry.js";
import { isPortalTraversable } from "./registry.js";
import {
  cloneJson,
  deepFreeze
} from "./utils.js";

import {
  captureTravelOptions,
  effectiveTravelOptions,
  normalizeDomainPathOptions,
  normalizeEffectiveStepOptions,
  normalizeDeltaSeconds,
  normalizePortalEntryTolerance,
  normalizePlanningOptions,
  normalizeStopOptions,
  validatePersistedTravelOptions,
  validateStepOptionsInput,
  validateTravelTarget
} from "./travel/input.js";

export {
  validatePersistedTravelOptions,
  validateTravelTarget
};

import {
  MinHeap,
  findDomainPortalPath,
  findDomainPortalPathInternal,
  pairKey,
  transitionKey,
  transitionsFrom
} from "./travel/domain-graph.js";

export { findDomainPortalPath };

const POSITION_EPSILON_SQ = 1e-8;

function travelTargetIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function travelTargetUnavailable(message) {
  const error = new Error(message);
  error.code = "PLACE_TRAVEL_TARGET_UNAVAILABLE";
  return error;
}

function anchorAvailable(registry, placeId, anchor) {
  if (!anchor) return false;
  if (anchor.spaceId == null) return true;
  return registry.getSpace(placeId, anchor.spaceId)?.enabled === true;
}

function resolvedTargetAvailable(registry, target) {
  if (target?.placeId == null) return true;
  const instance = registry.getPlace(target.placeId);
  if (!instance) return false;

  if (target.layerId != null &&
      instance.layerDomains.get(target.layerId) !== target.domainId) {
    return false;
  }

  if (target.spaceId != null) {
    const space = registry.getSpace(target.placeId, target.spaceId);
    if (!space?.enabled) return false;
  }

  if (target.anchorId != null) {
    const anchor = registry.resolveAnchor(target.placeId, target.anchorId);
    if (!anchor || anchor.domainId !== target.domainId) return false;
    if (!anchorAvailable(registry, target.placeId, anchor)) return false;
  }

  return true;
}

function availableAnchors(registry, placeId, anchors) {
  return [...anchors].filter((anchor) => anchorAvailable(registry, placeId, anchor));
}

export function resolveTravelTarget(registry, target) {
  validateTravelTarget(target);

  if (target.domainId != null) {
    return deepFreeze({
      placeId: target.placeId ?? null,
      anchorId: target.anchorId ?? null,
      spaceId: target.spaceId ?? null,
      layerId: target.layerId ?? null,
      domainId: target.domainId,
      position: { x: target.position.x, y: target.position.y },
      nodeId: target.nodeId ?? null
    });
  }

  if (target.kind === "nearest" &&
      typeof registry.findAnchors === "function") {
    const candidates = registry.findAnchors({
      tag: target.tag,
      kind: target.anchorKind ?? null,
      placeId: target.placeId ?? null,
      spaceId: target.spaceId ?? null,
      enabledOnly: true
    });
    if (!candidates.length) {
      throw travelTargetUnavailable(
        `no enabled anchor matches tag ${target.tag}`
      );
    }
    candidates.sort((a, b) =>
      travelTargetIdKey(a.placeId)
        .localeCompare(travelTargetIdKey(b.placeId)) ||
      a.id.localeCompare(b.id)
    );
    const anchor = candidates[0];
    return deepFreeze({
      placeId: anchor.placeId,
      anchorId: anchor.id,
      spaceId: anchor.spaceId,
      layerId: anchor.layerId,
      domainId: anchor.domainId,
      position: anchor.position,
      nodeId: anchor.nodeId
    });
  }

  const instance = registry.getPlace(target.placeId);
  if (!instance) {
    throw travelTargetUnavailable(`unknown target place ${String(target.placeId)}`);
  }
  const definition = registry.getDefinition(instance.definitionId);
  let anchor = null;

  if (target.anchorId != null) {
    anchor = definition.getAnchor(target.anchorId);
    if (!anchor) {
      throw travelTargetUnavailable(
        `unknown anchor ${target.anchorId} on place ${String(target.placeId)}`
      );
    }
    if (!anchorAvailable(registry, target.placeId, anchor)) {
      throw travelTargetUnavailable(
        `anchor ${target.anchorId} on place ${String(target.placeId)} is in a disabled space`
      );
    }
    if (target.spaceId != null &&
        anchor.spaceId !== target.spaceId) {
      throw travelTargetUnavailable(
        `anchor ${target.anchorId} is not in space ${target.spaceId} on place ${String(target.placeId)}`
      );
    }
  } else if (target.spaceId != null) {
    const space = registry.getSpace(target.placeId, target.spaceId);
    if (!space) {
      throw travelTargetUnavailable(
        `unknown space ${target.spaceId} on place ${String(target.placeId)}`
      );
    }
    if (!space.enabled) {
      throw travelTargetUnavailable(
        `space ${target.spaceId} on place ${String(target.placeId)} is disabled`
      );
    }

    if (space.defaultAnchorId) {
      const candidate = definition.getAnchor(space.defaultAnchorId);
      if (anchorAvailable(registry, target.placeId, candidate)) anchor = candidate;
    }
    if (!anchor) {
      anchor = availableAnchors(
        registry,
        target.placeId,
        definition.getAnchorsForSpace(space.id)
      ).sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
    }
  } else {
    if (definition.defaultAnchorId) {
      const candidate = definition.getAnchor(definition.defaultAnchorId);
      if (anchorAvailable(registry, target.placeId, candidate)) anchor = candidate;
    }
    if (!anchor) {
      anchor = availableAnchors(
        registry,
        target.placeId,
        definition.getAnchorsByTag("entry")
      ).sort((a, b) => a.id.localeCompare(b.id))[0] ??
        availableAnchors(
          registry,
          target.placeId,
          definition.anchors
        ).sort((a, b) => a.id.localeCompare(b.id))[0] ??
        null;
    }
  }

  if (!anchor) {
    throw travelTargetUnavailable(
      `place ${String(target.placeId)} has no enabled routable anchor`
    );
  }
  return deepFreeze({
    placeId: target.placeId,
    anchorId: anchor.id,
    spaceId: anchor.spaceId,
    layerId: anchor.layerId,
    domainId: instance.layerDomains.get(anchor.layerId),
    position: anchor.position,
    nodeId: anchor.nodeId
  });
}

function resolvePlanCall(registry, a, b, c, d) {
  if (a && typeof a === "object" && typeof a.getEntity === "function" && typeof a.planLocalRoute === "function") {
    return { bridge: a, entityOrId: b, target: c, options: d ?? {} };
  }
  const options = c ?? {};
  return {
    bridge: options.bridge ?? registry.bridge,
    entityOrId: a,
    target: b,
    options
  };
}

function localRoute(bridge, mobility, from, destination, options, cache, cachePrefix) {
  if (from.domainId !== destination.domainId) return null;
  if (squaredDistance(from.position, destination.position) <= POSITION_EPSILON_SQ) {
    return { estimatedSeconds: 0, plan: null };
  }
  if (destination.nodeId == null) return null;

  const key = `${cachePrefix}\u0000${destination.domainId}\u0000${destination.nodeId}`;
  if (cache.has(key)) return cache.get(key);

  const plan = bridge.planLocalRoute({
    domainId: from.domainId,
    position: from.position,
    destinationNodeId: destination.nodeId,
    mobility,
    options: options.journeyOptions
  });
  const result = plan
    ? { estimatedSeconds: plan.estimatedSeconds ?? plan.route?.estimatedSeconds ?? 0, plan }
    : null;
  cache.set(key, result);
  return result;
}

function localRouteCostsToMany(
  bridge,
  {
    domainId,
    position,
    destinationNodeIds,
    mobility,
    options
  }
) {
  const ids = [...new Set(destinationNodeIds ?? [])]
    .filter((id) => id != null)
    .sort();

  if (!ids.length) return new Map();

  if (typeof bridge.planLocalRouteCostsToMany === "function") {
    return bridge.planLocalRouteCostsToMany({
      domainId,
      position,
      destinationNodeIds: ids,
      mobility,
      options
    });
  }

  const result = new Map();
  for (const destinationNodeId of ids) {
    const planned = bridge.planLocalRoute({
      domainId,
      position,
      destinationNodeId,
      mobility,
      options
    });
    if (planned) result.set(destinationNodeId, planned.estimatedSeconds);
  }
  return result;
}

function appendJourney(steps, from, destination, route) {
  if (!route || route.estimatedSeconds <= 0) return steps;
  return [...steps, deepFreeze({
    type: "local-journey",
    domainId: from.domainId,
    destinationNodeId: destination.nodeId,
    destinationPosition: destination.position,
    estimatedSeconds: route.estimatedSeconds
  })];
}

function transitionsBetween(registry, fromDomainId, toDomainId, options) {
  return transitionsFrom(registry, fromDomainId, options)
    .filter((edge) => edge.to.domainId === toDomainId);
}

function optimizeConcretePath(registry, bridge, entity, domains, resolvedTarget, options) {
  const routeCache = new Map();
  let states = [{
    key: "start",
    cost: 0,
    domainId: entity.domainId ?? "default",
    position: entity.position,
    steps: []
  }];

  for (let layer = 0; layer < domains.length - 1; layer += 1) {
    const fromDomainId = domains[layer];
    const toDomainId = domains[layer + 1];
    const candidates = transitionsBetween(registry, fromDomainId, toDomainId, options);
    if (!candidates.length) {
      return { plan: null, failedPair: pairKey(fromDomainId, toDomainId) };
    }

    const nextByEndpoint = new Map();
    for (const state of states) {
      for (const edge of candidates) {
        const route = localRoute(
          bridge,
          entity.mobility,
          state,
          edge.from,
          options,
          routeCache,
          state.key
        );
        if (!route) continue;

        const cost = state.cost + route.estimatedSeconds + (edge.portal.transitionCost ?? 0);
        const key = transitionKey(edge);
        const existing = nextByEndpoint.get(key);
        if (existing && existing.cost <= cost) continue;

        const journeySteps = appendJourney(state.steps, state, edge.from, route);
        nextByEndpoint.set(key, {
          key,
          cost,
          domainId: edge.to.domainId,
          position: edge.to.position,
          steps: [...journeySteps, deepFreeze({
            type: "traverse-portal",
            portalKey: edge.portalKey,
            placeId: edge.portal.instanceId,
            portalId: edge.portal.id,
            fromDomainId: edge.from.domainId,
            toDomainId: edge.to.domainId,
            destinationPosition: edge.to.position,
            transitionCost: edge.portal.transitionCost ?? 0
          })]
        });
      }
    }

    states = [...nextByEndpoint.values()]
      .sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key));
    if (!states.length) {
      return { plan: null, failedPair: pairKey(fromDomainId, toDomainId) };
    }

    const cap = options.maxConcreteStatesPerLayer;
    if (states.length > cap) states.length = cap;
  }

  let best = null;
  for (const state of states) {
    const route = localRoute(
      bridge,
      entity.mobility,
      state,
      resolvedTarget,
      options,
      routeCache,
      state.key
    );
    if (!route) continue;
    const cost = state.cost + route.estimatedSeconds;
    const steps = appendJourney(state.steps, state, resolvedTarget, route);
    if (!best || cost < best.cost || (cost === best.cost && state.key < best.key)) {
      best = { key: state.key, cost, steps };
    }
  }

  if (!best) {
    const failedPair = domains.length > 1
      ? pairKey(domains[domains.length - 2], domains[domains.length - 1])
      : null;
    return { plan: null, failedPair };
  }

  return { plan: best, failedPair: null };
}


function domainPathKey(domains) {
  return domains.join("\u0000");
}

function exclusionSetKey(excludedPairs) {
  return [...excludedPairs].sort().join("\u0001");
}

function shortestDomainPathCandidates(
  registry,
  startDomainId,
  targetDomainId,
  options = {}
) {
  const excludedPortalKeys = new Set(options.excludedPortalKeys ?? []);
  const baseExcludedPairs = new Set(options.excludedDomainPairs ?? []);
  const first = findDomainPortalPathInternal(
    registry,
    startDomainId,
    targetDomainId,
    { excludedPairs: baseExcludedPairs, excludedPortalKeys }
  );
  if (!first) return [];

  const firstDomains = first.domains ?? [
    startDomainId,
    ...first.map((edge) => edge.to.domainId)
  ];
  const minimumHops = firstDomains.length - 1;
  const maxCandidates = options.maxShortestDomainPaths;

  const pending = [{
    domains: firstDomains,
    excludedPairs: baseExcludedPairs
  }];
  const seenPaths = new Set();
  const seenExclusions = new Set([exclusionSetKey(baseExcludedPairs)]);
  const result = [];

  while (pending.length > 0) {
    pending.sort((a, b) => domainPathKey(a.domains).localeCompare(domainPathKey(b.domains)));
    const current = pending.shift();
    const pathKey = domainPathKey(current.domains);
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    result.push(Object.freeze([...current.domains]));

    for (let i = 0; i < current.domains.length - 1; i += 1) {
      const excludedPairs = new Set(current.excludedPairs);
      excludedPairs.add(pairKey(current.domains[i], current.domains[i + 1]));
      const exclusionKey = exclusionSetKey(excludedPairs);
      if (seenExclusions.has(exclusionKey)) continue;
      seenExclusions.add(exclusionKey);

      const alternate = findDomainPortalPathInternal(
        registry,
        startDomainId,
        targetDomainId,
        { excludedPairs, excludedPortalKeys }
      );
      if (!alternate) continue;

      const domains = alternate.domains ?? [
        startDomainId,
        ...alternate.map((edge) => edge.to.domainId)
      ];
      if (domains.length - 1 !== minimumHops) continue;
      if (!seenPaths.has(domainPathKey(domains))) {
        pending.push({ domains, excludedPairs });
      }
    }

    if (result.length >= maxCandidates) {
      if (pending.length > 0 && options.allowPartialShortestPathSearch !== true) {
        throw new Error(
          `shortest semantic path count exceeds maxShortestDomainPaths (${maxCandidates})`
        );
      }
      break;
    }
  }

  return result;
}

function anchorTargetKey(anchor) {
  return `${typeof anchor.placeId}:${String(anchor.placeId)}\u0000${anchor.id}`;
}

function planNearestTaggedAnchor(registry, bridge, entity, target, options = {}) {
  const startDomainId = entity.domainId ?? "default";
  const excludedPortalKeys = new Set(options.excludedPortalKeys ?? []);
  const searchOptions = { ...options, excludedPortalKeys };
  const queue = new MinHeap();
  const bestCostByState = new Map();
  const maxExpansions = options.maxNearestTargetExpansions;
  const maxCost = options.maxCost;

  const start = {
    key: "start",
    cost: 0,
    domainId: startDomainId,
    position: entity.position,
    steps: [],
    domains: [startDomainId],
    arrivedViaPortalKey: null
  };
  bestCostByState.set(start.key, 0);
  queue.push(start);

  let bestGoal = null;
  let expansions = 0;

  while (queue.size) {
    const state = queue.pop();
    if (state.cost !== bestCostByState.get(state.key)) continue;
    if (state.cost > maxCost) continue;
    if (bestGoal && state.cost > bestGoal.cost) break;
    if (++expansions > maxExpansions) {
      throw new Error("nearest semantic target search exceeded maxNearestTargetExpansions");
    }

    const anchors = registry.getAnchorsForDomain(state.domainId, {
      tag: target.tag,
      kind: target.anchorKind,
      spaceId: target.spaceId
    }).filter((anchor) => {
      if (target.placeId != null && anchor.placeId !== target.placeId) return false;
      if (typeof options.anchorPredicate === "function" &&
          options.anchorPredicate(anchor) !== true) return false;
      return true;
    });

    const edges = transitionsFrom(registry, state.domainId, searchOptions)
      .filter((edge) => edge.portalKey !== state.arrivedViaPortalKey);
    const destinationNodeIds = new Set();

    for (const anchor of anchors) {
      if (anchor.nodeId != null &&
          squaredDistance(state.position, anchor.position) > POSITION_EPSILON_SQ) {
        destinationNodeIds.add(anchor.nodeId);
      }
    }
    for (const edge of edges) {
      if (edge.from.nodeId != null &&
          squaredDistance(state.position, edge.from.position) > POSITION_EPSILON_SQ) {
        destinationNodeIds.add(edge.from.nodeId);
      }
    }

    const routeCosts = localRouteCostsToMany(bridge, {
      domainId: state.domainId,
      position: state.position,
      destinationNodeIds,
      mobility: entity.mobility,
      options: searchOptions.journeyOptions
    });

    const costTo = destination => {
      if (squaredDistance(state.position, destination.position) <= POSITION_EPSILON_SQ) {
        return 0;
      }
      if (destination.nodeId == null) return null;
      return routeCosts.get(destination.nodeId) ?? null;
    };

    for (const anchor of anchors) {
      const localSeconds = costTo(anchor);
      if (localSeconds == null) continue;

      const resolvedTarget = deepFreeze({
        placeId: anchor.placeId,
        anchorId: anchor.id,
        spaceId: anchor.spaceId,
        layerId: anchor.layerId,
        domainId: anchor.domainId,
        position: anchor.position,
        nodeId: anchor.nodeId
      });

      const cost = state.cost + localSeconds;
      if (cost > maxCost) continue;
      const key = anchorTargetKey(anchor);
      const steps = appendJourney(
        state.steps,
        state,
        resolvedTarget,
        { estimatedSeconds: localSeconds }
      );

      if (!bestGoal ||
          cost < bestGoal.cost ||
          (cost === bestGoal.cost && key.localeCompare(bestGoal.key) < 0)) {
        bestGoal = {
          key,
          cost,
          steps,
          domains: state.domains,
          resolvedTarget
        };
      }
    }

    for (const edge of edges) {
      const localSeconds = costTo(edge.from);
      if (localSeconds == null) continue;

      const cost = state.cost + localSeconds + (edge.portal.transitionCost ?? 0);
      if (cost > maxCost || (bestGoal && cost > bestGoal.cost)) continue;

      const key = transitionKey(edge);
      const previous = bestCostByState.get(key);
      if (previous != null && previous <= cost) continue;

      const journeySteps = appendJourney(
        state.steps,
        state,
        edge.from,
        { estimatedSeconds: localSeconds }
      );
      bestCostByState.set(key, cost);
      queue.push({
        key,
        cost,
        domainId: edge.to.domainId,
        position: edge.to.position,
        domains: [...state.domains, edge.to.domainId],
        arrivedViaPortalKey: edge.portalKey,
        steps: [...journeySteps, deepFreeze({
          type: "traverse-portal",
          portalKey: edge.portalKey,
          placeId: edge.portal.instanceId,
          portalId: edge.portal.id,
          fromDomainId: edge.from.domainId,
          toDomainId: edge.to.domainId,
          destinationPosition: edge.to.position,
          transitionCost: edge.portal.transitionCost ?? 0
        })]
      });
    }
  }

  if (!bestGoal) return null;

  const steps = Object.freeze(bestGoal.steps);
  return deepFreeze({
    entityId: entity.id,
    target: cloneJson(target),
    resolvedTarget: bestGoal.resolvedTarget,
    travelRevision: registry.travelRevision,
    startDomainId,
    domainPath: Object.freeze([...bestGoal.domains]),
    steps,
    legs: steps,
    estimatedSeconds: bestGoal.cost,
    rejectedDomainPairs: Object.freeze([]),
    searchExpansions: expansions
  });
}

export function planTravel(registry, a, b, c, d) {
  const {
    bridge,
    entityOrId,
    target,
    options: rawOptions
  } = resolvePlanCall(registry, a, b, c, d);
  if (!bridge) throw new Error("planTravel requires a WorldCoreBridge");
  const options = normalizePlanningOptions(rawOptions);
  validateTravelTarget(target);
  const entity = typeof entityOrId === "object"
    ? entityOrId
    : bridge.getEntity(entityOrId);
  if (!entity) throw new Error(`unknown entity ${String(entityOrId)}`);
  if (!entity.mobility) throw new Error(`entity ${String(entity.id)} has no mobility profile`);

  if (target?.kind === "nearest" && target.tag) {
    return planNearestTaggedAnchor(registry, bridge, entity, target, options);
  }

  const resolvedTarget = resolveTravelTarget(registry, target);
  const startDomainId = entity.domainId ?? "default";
  const excludedPortalKeys = new Set(options.excludedPortalKeys ?? []);
  const baseSearchOptions = { ...options, excludedPortalKeys };

  const candidatePaths = shortestDomainPathCandidates(
    registry,
    startDomainId,
    resolvedTarget.domainId,
    baseSearchOptions
  );

  let bestShortest = null;
  const failedPairs = new Set();

  for (const domains of candidatePaths) {
    const optimized = optimizeConcretePath(
      registry,
      bridge,
      entity,
      domains,
      resolvedTarget,
      baseSearchOptions
    );

    if (!optimized.plan) {
      if (optimized.failedPair) failedPairs.add(optimized.failedPair);
      continue;
    }

    const candidateKey = domainPathKey(domains);
    if (!bestShortest ||
        optimized.plan.cost < bestShortest.plan.cost ||
        (optimized.plan.cost === bestShortest.plan.cost &&
         candidateKey.localeCompare(bestShortest.key) < 0)) {
      bestShortest = {
        key: candidateKey,
        domains,
        plan: optimized.plan
      };
    }
  }

  if (bestShortest) {
    const steps = Object.freeze(bestShortest.plan.steps);
    return deepFreeze({
      entityId: entity.id,
      target: cloneJson(target),
      resolvedTarget,
      travelRevision: registry.travelRevision,
      startDomainId,
      domainPath: Object.freeze([...bestShortest.domains]),
      steps,
      legs: steps,
      estimatedSeconds: bestShortest.plan.cost,
      rejectedDomainPairs: Object.freeze([])
    });
  }

  const excludedPairs = new Set(options.excludedDomainPairs ?? []);
  for (const failedPair of failedPairs) excludedPairs.add(failedPair);
  const maxAttempts = options.maxDomainPathAttempts;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const topological = findDomainPortalPathInternal(
      registry,
      startDomainId,
      resolvedTarget.domainId,
      { excludedPairs, excludedPortalKeys }
    );
    if (topological == null) return null;

    const domains = topological.domains ?? [
      startDomainId,
      ...topological.map((edge) => edge.to.domainId)
    ];

    const optimized = optimizeConcretePath(
      registry,
      bridge,
      entity,
      domains,
      resolvedTarget,
      { ...options, excludedPairs, excludedPortalKeys }
    );

    if (optimized.plan) {
      const steps = Object.freeze(optimized.plan.steps);
      return deepFreeze({
        entityId: entity.id,
        target: cloneJson(target),
        resolvedTarget,
        travelRevision: registry.travelRevision,
        startDomainId,
        domainPath: Object.freeze([...domains]),
        steps,
        legs: steps,
        estimatedSeconds: optimized.plan.cost,
        rejectedDomainPairs: Object.freeze([...excludedPairs])
      });
    }

    if (!optimized.failedPair || excludedPairs.has(optimized.failedPair)) return null;
    excludedPairs.add(optimized.failedPair);
  }

  return null;
}

function resolveStartCall(registry, a, b, c, d) {
  if (a && typeof a === "object" && typeof a.getEntity === "function" && typeof a.planLocalRoute === "function") {
    return { bridge: a, entityId: b, target: c, options: d ?? {} };
  }
  const options = c ?? {};
  return { bridge: options.bridge ?? registry.bridge, entityId: a, target: b, options };
}

function fail(registry, bridge, state, reason) {
  bridge.stopLocalJourney(state.entityId);
  state.status = "failed";
  state.failureReason = reason;
  registry.activeTravels.delete(state.entityId);
  registry.emit("travel-failed", { entityId: state.entityId, reason, target: state.target });
  return state;
}

function complete(registry, state) {
  state.status = "complete";
  registry.activeTravels.delete(state.entityId);
  registry.emit("travel-complete", {
    entityId: state.entityId,
    target: state.target,
    replans: state.replans
  });
  return state;
}

function replan(registry, bridge, state, options) {
  bridge.stopLocalJourney(state.entityId);
  let plan;
  try {
    const {
      deltaSeconds: _deltaSeconds,
      ...planningOptions
    } = options;
    plan = planTravel(
      registry,
      bridge,
      state.entityId,
      state.target,
      planningOptions
    );
  } catch (error) {
    if (error?.code === "PLACE_TRAVEL_TARGET_UNAVAILABLE") {
      state.replans += 1;
      return fail(registry, bridge, state, "target-unavailable-after-world-change");
    }
    throw error;
  }
  state.replans += 1;
  state.stepIndex = 0;
  state.localStarted = false;
  state.portalEntered = false;
  state.portalTransitionRemaining = 0;

  if (!plan) return fail(registry, bridge, state, "no-route-after-world-change");

  state.plan = plan;
  state.travelRevision = registry.travelRevision;
  registry.emit("travel-replan", {
    entityId: state.entityId,
    target: state.target,
    travelRevision: state.travelRevision,
    replans: state.replans,
    estimatedSeconds: plan.estimatedSeconds
  });
  return state;
}

function currentPortalDestination(portal, step) {
  if (portal.a.domainId === step.fromDomainId && portal.b.domainId === step.toDomainId) {
    return { from: portal.a, to: portal.b };
  }
  if (portal.bidirectional !== false &&
      portal.b.domainId === step.fromDomainId &&
      portal.a.domainId === step.toDomainId) {
    return { from: portal.b, to: portal.a };
  }
  return null;
}

function advance(registry, bridge, state, options = {}) {
  while (state.status === "active") {
    if (state.stepIndex >= state.plan.steps.length) {
      if (!resolvedTargetAvailable(registry, state.plan.resolvedTarget)) {
        registry.emit("travel-target-unavailable", {
          entityId: state.entityId,
          target: state.target,
          resolvedTarget: state.plan.resolvedTarget
        });
        return replan(registry, bridge, state, options);
      }
      return complete(registry, state);
    }
    const step = state.plan.steps[state.stepIndex];

    if (step.type === "local-journey") {
      const entity = bridge.getEntity(state.entityId);
      if (!entity) return fail(registry, bridge, state, "entity-missing");
      if ((entity.domainId ?? "default") !== step.domainId) {
        return replan(registry, bridge, state, options);
      }

      if (!state.localStarted) {
        const ok = bridge.startLocalJourney(state.entityId, step.destinationNodeId, options.journeyOptions);
        if (!ok) return replan(registry, bridge, state, options);
        state.localStarted = true;
        registry.emit("travel-leg-start", {
          entityId: state.entityId,
          stepIndex: state.stepIndex,
          type: step.type,
          domainId: step.domainId,
          destinationNodeId: step.destinationNodeId
        });
      }
      return state;
    }

    if (step.type === "traverse-portal") {
      const portal = registry.getPortalRecord(step.portalKey);
      if (!portal || !isPortalTraversable(portal)) {
        registry.emit("travel-obstacle-encountered", {
          entityId: state.entityId,
          stepIndex: state.stepIndex,
          obstacle: "portal",
          portalKey: step.portalKey,
          placeId: step.placeId,
          portalId: step.portalId,
          missing: portal == null,
          state: portal ? {
            enabled: portal.enabled,
            open: portal.open,
            locked: portal.locked,
            blocked: portal.blocked,
            destroyed: portal.destroyed
          } : null
        });
        return replan(registry, bridge, state, options);
      }
      const direction = currentPortalDestination(portal, step);
      if (!direction) return replan(registry, bridge, state, options);

      const entity = bridge.getEntity(state.entityId);
      if (!entity) return fail(registry, bridge, state, "entity-missing");
      if ((entity.domainId ?? "default") !== step.fromDomainId) {
        return replan(registry, bridge, state, options);
      }

      const portalEntryTolerance = normalizePortalEntryTolerance(
        options.portalEntryTolerance
      );
      if (squaredDistance(entity.position, direction.from.position) >
          portalEntryTolerance * portalEntryTolerance) {
        registry.emit("travel-obstacle-encountered", {
          entityId: state.entityId,
          stepIndex: state.stepIndex,
          obstacle: "portal-endpoint-moved",
          portalKey: step.portalKey,
          placeId: portal.instanceId,
          portalId: portal.id,
          currentPosition: {
            x: entity.position.x,
            y: entity.position.y
          },
          expectedPosition: {
            x: direction.from.position.x,
            y: direction.from.position.y
          }
        });
        return replan(registry, bridge, state, options);
      }

      if (!state.portalEntered) {
        state.portalEntered = true;
        state.portalTransitionRemaining = Math.max(0, step.transitionCost ?? 0);
        registry.emit("portal-enter", {
          entityId: state.entityId,
          placeId: portal.instanceId,
          portalId: portal.id,
          fromDomainId: step.fromDomainId,
          toDomainId: step.toDomainId
        });
        if (state.portalTransitionRemaining > 0) return state;
      }

      const deltaSeconds = normalizeDeltaSeconds(options.deltaSeconds);
      if (state.portalTransitionRemaining > 0) {
        state.portalTransitionRemaining = Math.max(0, state.portalTransitionRemaining - deltaSeconds);
        if (state.portalTransitionRemaining > 0) return state;
      }

      bridge.transferEntity(state.entityId, direction.to);
      const moved = bridge.getEntity(state.entityId);

      if (!moved) {
        return fail(
          registry,
          bridge,
          state,
          "entity-missing-after-portal-transfer"
        );
      }

      registry.updateEntityOccupancy(moved);

      const movedDomainId = moved.domainId ?? "default";
      const transferPositionValid =
        moved.position &&
        Number.isFinite(moved.position.x) &&
        Number.isFinite(moved.position.y);
      const transferPositionDistanceSq = transferPositionValid
        ? squaredDistance(moved.position, direction.to.position)
        : Infinity;

      if (
        movedDomainId !== step.toDomainId ||
        transferPositionDistanceSq >
          portalEntryTolerance * portalEntryTolerance
      ) {
        registry.emit("portal-transfer-failed", {
          entityId: state.entityId,
          placeId: portal.instanceId,
          portalId: portal.id,
          expectedDomainId: step.toDomainId,
          actualDomainId: movedDomainId,
          expectedPosition: {
            x: direction.to.position.x,
            y: direction.to.position.y
          },
          actualPosition: transferPositionValid
            ? {
                x: moved.position.x,
                y: moved.position.y
              }
            : null
        });
        return replan(registry, bridge, state, options);
      }

      registry.emit("portal-traverse", {
        entityId: state.entityId,
        placeId: portal.instanceId,
        portalId: portal.id,
        fromDomainId: step.fromDomainId,
        toDomainId: step.toDomainId
      });
      registry.emit("portal-exit", {
        entityId: state.entityId,
        placeId: portal.instanceId,
        portalId: portal.id
      });
      state.stepIndex += 1;
      state.localStarted = false;
      state.portalEntered = false;
      state.portalTransitionRemaining = 0;
      continue;
    }

    return fail(registry, bridge, state, `unknown-step:${step.type}`);
  }

  return state;
}

export function startTravel(registry, a, b, c, d) {
  const { bridge, entityId, target, options } = resolveStartCall(registry, a, b, c, d);
  if (!bridge) throw new Error("startTravel requires a WorldCoreBridge");

  if (registry.activeTravels.has(entityId)) {
    stopTravel(registry, bridge, entityId, { reason: "replaced" });
  }

  const capturedOptions = captureTravelOptions(options);
  const plan = planTravel(registry, bridge, entityId, target, capturedOptions);
  if (!plan) return null;

  const state = {
    entityId,
    target: cloneJson(target),
    plan,
    options: capturedOptions,
    stepIndex: 0,
    localStarted: false,
    portalEntered: false,
    portalTransitionRemaining: 0,
    travelRevision: registry.travelRevision,
    worldChangePolicy: capturedOptions.worldChangePolicy,
    status: "active",
    failureReason: null,
    replans: 0
  };
  registry.activeTravels.set(entityId, state);
  registry.emit("travel-start", {
    entityId,
    target: state.target,
    estimatedSeconds: plan.estimatedSeconds
  });
  return advance(registry, bridge, state, capturedOptions);
}

function resolveStepCall(registry, a, b, c) {
  if (a && typeof a === "object" && typeof a.getEntity === "function" && typeof a.planLocalRoute === "function") {
    return { bridge: a, entityId: b, options: c ?? {} };
  }
  const options = b ?? {};
  return { bridge: options.bridge ?? registry.bridge, entityId: a, options };
}

export function stepTravel(registry, a, b, c) {
  const { bridge, entityId, options } =
    resolveStepCall(registry, a, b, c);

  validateStepOptionsInput(options);

  if (!bridge) {
    throw new Error("stepTravel requires a WorldCoreBridge");
  }

  const state = registry.activeTravels.get(entityId);
  if (!state) return null;

  const effectiveOptions = normalizeEffectiveStepOptions(
    effectiveTravelOptions(state, options)
  );
  const worldChangePolicy = effectiveOptions.worldChangePolicy;

  if (worldChangePolicy === "eager" &&
      state.travelRevision !== registry.travelRevision) {
    const next = replan(registry, bridge, state, effectiveOptions);
    if (next.status !== "active") return next;
  }

  const step = state.plan.steps[state.stepIndex];
  if (step?.type === "local-journey" && state.localStarted) {
    const entity = bridge.getEntity(entityId);
    if (!entity) return fail(registry, bridge, state, "entity-missing");

    registry.updateEntityOccupancy(entity);
    if (entity.journey != null) return state;

    if (entity.lastJourneyFailure?.destinationNodeId === step.destinationNodeId) {
      const next = replan(registry, bridge, state, effectiveOptions);
      if (next.status !== "active") return next;
    } else {
      state.stepIndex += 1;
      state.localStarted = false;
    }
  }

  return advance(registry, bridge, state, effectiveOptions);
}

export function stepPlaceSimulation(
  registry,
  a = {},
  b = 0,
  c = {}
) {
  let bridge;
  let options;

  if (a &&
      typeof a === "object" &&
      typeof a.getEntity === "function" &&
      typeof a.planLocalRoute === "function") {
    bridge = a;
    options = {
      ...(c ?? {}),
      deltaSeconds: b
    };
  } else {
    options = a ?? {};
    bridge = options.bridge ?? registry.bridge;
  }

  validateStepOptionsInput(options);

  if (!bridge) {
    throw new Error(
      "stepPlaceSimulation requires a WorldCoreBridge"
    );
  }

  const ids = [...registry.activeTravels.keys()];
  for (const entityId of ids) {
    stepTravel(
      registry,
      bridge,
      entityId,
      options
    );
  }
  return registry.activeTravels.size;
}

export function stopTravel(registry, a, b, c = {}) {
  let bridge;
  let entityId;
  let options;

  if (a &&
      typeof a === "object" &&
      typeof a.getEntity === "function") {
    bridge = a;
    entityId = b;
    options = normalizeStopOptions(c ?? {});
  } else {
    entityId = a;
    options = normalizeStopOptions(b ?? {});
    bridge = options.bridge ?? registry.bridge;
  }

  const state = registry.activeTravels.get(entityId);
  if (!state) return false;

  bridge?.stopLocalJourney?.(entityId);
  registry.activeTravels.delete(entityId);
  state.status = "cancelled";
  registry.emit("travel-cancelled", {
    entityId,
    reason: options.reason
  });
  return true;
}
