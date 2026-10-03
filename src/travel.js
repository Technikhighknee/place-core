import {
  pointInGeometry,
  squaredDistance
} from "./geometry.js";
import { isPortalTraversable } from "./registry.js";
import {
  assertId,
  assertStringId,
  cloneJson,
  compareStrings,
  deepFreeze,
  tupleKey
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

function assertRegistryExecutionBridge(
  registry,
  bridge,
  operation
) {
  if (
    registry.bridge != null &&
    registry.bridge !== bridge
  ) {
    throw new Error(
      `${operation} cannot use a WorldCoreBridge different from the one attached to the PlaceRegistry`
    );
  }
}

function assertActiveTravelBridge(
  state,
  bridge,
  operation
) {
  const existing =
    getTravelRuntimeBridge(state);

  if (existing && existing !== bridge) {
    throw new Error(
      `${operation} must use the WorldCoreBridge that owns the active travel`
    );
  }

  if (!existing) {
    bindTravelRuntimeBridge(state, bridge);
  }
}

function assertRegistryActiveTravelBridge(
  registry,
  bridge,
  operation
) {
  for (const entityId of registry._activeTravelIds(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN
  )) {
    const state = registry._getActiveTravel(
      PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
      entityId
    );
    if (state) {
      assertActiveTravelBridge(
        state,
        bridge,
        operation
      );
    }
  }
}

function validateTravelEntity(
  entity,
  expectedId = undefined
) {
  assertId(entity?.id, "entity.id");

  if (
    expectedId !== undefined &&
    entity.id !== expectedId
  ) {
    throw new Error(
      `bridge returned entity ${String(entity.id)} for requested entity ${String(expectedId)}`
    );
  }

  const domainId =
    entity.domainId ?? "default";
  assertStringId(
    domainId,
    "entity.domainId"
  );

  if (
    !entity.position ||
    typeof entity.position !== "object" ||
    !Number.isFinite(entity.position.x) ||
    !Number.isFinite(entity.position.y)
  ) {
    throw new TypeError(
      "entity.position must contain finite x/y"
    );
  }

  if (!entity.mobility) {
    throw new Error(
      `entity ${String(entity.id)} has no mobility profile`
    );
  }

  return entity;
}

import {
  PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
  abortEnteredTravelPortal,
  bindTravelRuntimeBridge,
  getTravelRuntimeBridge,
  snapshotTravelState
} from "./registry/support.js";
import {
  MinHeap,
  domainPairKey,
  findDomainPortalPath,
  findDomainPortalPathInternal,
  pairKey,
  transitionKey,
  transitionsFrom
} from "./travel/domain-graph.js";

export {
  domainPairKey,
  findDomainPortalPath
};

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

function resolvedTargetAvailable(
  registry,
  target,
  requestedTarget = null
) {
  if (requestedTarget?.domainId != null) {
    return true;
  }

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

function anchorBelongsToSpace(
  definition,
  anchor,
  spaceId
) {
  const requestedSpace =
    definition.getSpace(spaceId);
  if (
    !anchor ||
    !requestedSpace ||
    anchor.layerId !==
      requestedSpace.layerId
  ) {
    return false;
  }

  let currentSpaceId =
    anchor.spaceId ?? null;

  if (currentSpaceId == null) {
    return pointInGeometry(
      anchor.position,
      requestedSpace.geometry
    );
  }

  while (currentSpaceId != null) {
    if (currentSpaceId === spaceId) {
      return true;
    }

    currentSpaceId =
      definition.getSpace(
        currentSpaceId
      )?.parentSpaceId ?? null;
  }

  return false;
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
      compareStrings(
        travelTargetIdKey(a.placeId),
        travelTargetIdKey(b.placeId)
      ) ||
      compareStrings(a.id, b.id)
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
    if (
      target.spaceId != null &&
      !anchorBelongsToSpace(
        definition,
        anchor,
        target.spaceId
      )
    ) {
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
      ).sort((a, b) => compareStrings(a.id, b.id))[0] ?? null;
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
      ).sort((a, b) => compareStrings(a.id, b.id))[0] ??
        availableAnchors(
          registry,
          target.placeId,
          definition.anchors
        ).sort((a, b) => compareStrings(a.id, b.id))[0] ??
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
    spaceId:
      target.spaceId ??
      anchor.spaceId,
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

function assertRouteCost(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${label} must be a finite number >= 0`
    );
  }
  return value;
}

function routeEstimatedSeconds(plan, label) {
  const value =
    plan?.estimatedSeconds ??
    plan?.route?.estimatedSeconds;
  if (value == null) {
    throw new TypeError(
      `${label} estimatedSeconds must be a finite number >= 0`
    );
  }
  return assertRouteCost(
    value,
    `${label} estimatedSeconds`
  );
}

function travelCostSum(...values) {
  let total = 0;
  for (const value of values) {
    assertRouteCost(
      value,
      "travel cost component"
    );
    total += value;
    if (!Number.isFinite(total)) {
      throw new RangeError(
        "aggregate travel cost must be finite (cost overflow)"
      );
    }
  }
  return total;
}

function pointDistance(a, b) {
  return Math.hypot(
    a.x - b.x,
    a.y - b.y
  );
}

function cloneJourneyOptions(options) {
  return options === undefined
    ? undefined
    : cloneJson(options);
}

function localRoute(bridge, mobility, from, destination, options, cache, cachePrefix) {
  if (from.domainId !== destination.domainId) return null;
  if (squaredDistance(from.position, destination.position) <= POSITION_EPSILON_SQ) {
    return { estimatedSeconds: 0, plan: null };
  }
  if (destination.nodeId == null) return null;

  const key = tupleKey(
    cachePrefix,
    destination.domainId,
    destination.nodeId
  );
  if (cache.has(key)) return cache.get(key);

  const plan = bridge.planLocalRoute({
    domainId: from.domainId,
    position: from.position,
    destinationNodeId: destination.nodeId,
    mobility,
    options: cloneJourneyOptions(
      options.journeyOptions
    )
  });
  const result = plan
    ? {
        estimatedSeconds:
          routeEstimatedSeconds(
            plan,
            "local route"
          ),
        plan
      }
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
    const raw =
      bridge.planLocalRouteCostsToMany({
        domainId,
        position,
        destinationNodeIds: [...ids],
        mobility,
        options: cloneJourneyOptions(options)
      });
    if (!(raw instanceof Map)) {
      throw new TypeError(
        "planLocalRouteCostsToMany must return a Map"
      );
    }

    const result = new Map();
    for (const destinationNodeId of ids) {
      if (!raw.has(destinationNodeId)) continue;
      result.set(
        destinationNodeId,
        assertRouteCost(
          raw.get(destinationNodeId),
          `route cost for ${destinationNodeId}`
        )
      );
    }
    return result;
  }

  const result = new Map();
  for (const destinationNodeId of ids) {
    const planned = bridge.planLocalRoute({
      domainId,
      position,
      destinationNodeId,
      mobility,
      options: cloneJourneyOptions(options)
    });
    if (planned) {
      result.set(
        destinationNodeId,
        routeEstimatedSeconds(
          planned,
          `route cost for ${destinationNodeId}`
        )
      );
    }
  }
  return result;
}

function appendJourney(steps, from, destination, route) {
  if (!route) return steps;
  if (
    squaredDistance(
      from.position,
      destination.position
    ) <= POSITION_EPSILON_SQ
  ) {
    return steps;
  }

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
  let truncated = false;
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
      return {
        plan: null,
        failedPair: pairKey(fromDomainId, toDomainId),
        truncated
      };
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

        const cost = travelCostSum(
          state.cost,
          route.estimatedSeconds,
          edge.portal.transitionCost ?? 0
        );
        if (cost > options.maxCost) {
          continue;
        }
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
      .sort((a, b) => a.cost - b.cost || compareStrings(a.key, b.key));
    if (!states.length) {
      return {
        plan: null,
        failedPair: pairKey(fromDomainId, toDomainId),
        truncated
      };
    }

    const cap = options.maxConcreteStatesPerLayer;
    if (states.length > cap) {
      states.length = cap;
      truncated = true;
    }
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
    const cost = travelCostSum(
      state.cost,
      route.estimatedSeconds
    );
    if (cost > options.maxCost) {
      continue;
    }
    const steps = appendJourney(state.steps, state, resolvedTarget, route);
    if (!best || cost < best.cost || (cost === best.cost && state.key < best.key)) {
      best = { key: state.key, cost, steps };
    }
  }

  if (!best) {
    const failedPair = domains.length > 1
      ? pairKey(domains[domains.length - 2], domains[domains.length - 1])
      : null;
    return {
      plan: null,
      failedPair,
      truncated
    };
  }

  return {
    plan: best,
    failedPair: null,
    truncated
  };
}


function domainPathKey(domains) {
  return tupleKey(...domains);
}

function exclusionSetKey(excludedPairs) {
  return tupleKey(
    ...[...excludedPairs].sort()
  );
}

function shortestDomainPathCandidates(
  registry,
  startDomainId,
  targetDomainId,
  options = {}
) {
  const excludedPortalKeys =
    new Set(
      options.excludedPortalKeys ?? []
    );
  const excludedPairs =
    new Set(
      options.excludedDomainPairs ?? []
    );
  const searchOptions = {
    excludedPortalKeys,
    excludedPairs
  };
  const maxCandidates =
    options.maxShortestDomainPaths;

  if (startDomainId === targetDomainId) {
    return [
      Object.freeze([startDomainId])
    ];
  }

  const distance =
    new Map([
      [startDomainId, 0]
    ]);
  const predecessors =
    new Map();
  const queue = [startDomainId];
  let cursor = 0;
  let targetDistance = null;

  while (cursor < queue.length) {
    const domainId =
      queue[cursor++];
    const depth =
      distance.get(domainId);

    if (
      targetDistance != null &&
      depth >= targetDistance
    ) {
      continue;
    }

    const neighbors = [
      ...new Set(
        transitionsFrom(
          registry,
          domainId,
          searchOptions
        ).map(
          (edge) =>
            edge.to.domainId
        )
      )
    ].sort(compareStrings);

    for (const neighbor of neighbors) {
      const nextDepth = depth + 1;
      const knownDepth =
        distance.get(neighbor);

      if (knownDepth == null) {
        distance.set(
          neighbor,
          nextDepth
        );
        predecessors.set(
          neighbor,
          [domainId]
        );
        queue.push(neighbor);

        if (
          neighbor === targetDomainId
        ) {
          targetDistance =
            nextDepth;
        }
      } else if (
        knownDepth === nextDepth
      ) {
        const parents =
          predecessors.get(neighbor);
        if (
          parents &&
          !parents.includes(domainId)
        ) {
          parents.push(domainId);
          parents.sort(compareStrings);
        }
      }
    }
  }

  if (
    !distance.has(targetDomainId)
  ) {
    return [];
  }

  const successors =
    new Map();
  for (const [child, parents] of
    predecessors) {
    for (const parent of parents) {
      let children =
        successors.get(parent);
      if (!children) {
        children = [];
        successors.set(
          parent,
          children
        );
      }
      if (!children.includes(child)) {
        children.push(child);
      }
    }
  }
  for (const children of
    successors.values()) {
    children.sort(compareStrings);
  }

  const result = [];
  const path = [startDomainId];
  const stack = [{
    domainId: startDomainId,
    index: 0
  }];

  while (stack.length > 0) {
    const frame =
      stack[stack.length - 1];

    if (
      frame.domainId ===
      targetDomainId
    ) {
      result.push(
        Object.freeze([...path])
      );

      if (
        result.length >
        maxCandidates
      ) {
        if (
          options
            .allowPartialShortestPathSearch ===
          true
        ) {
          return result.slice(
            0,
            maxCandidates
          );
        }
        throw new Error(
          `shortest semantic path count exceeds maxShortestDomainPaths (${maxCandidates})`
        );
      }

      stack.pop();
      path.pop();
      continue;
    }

    const children =
      successors.get(
        frame.domainId
      ) ?? [];

    if (
      frame.index >=
      children.length
    ) {
      stack.pop();
      path.pop();
      continue;
    }

    const child =
      children[frame.index++];

    path.push(child);
    stack.push({
      domainId: child,
      index: 0
    });
  }

  return result;
}

function anchorTargetKey(anchor) {
  return tupleKey(
    travelTargetIdKey(anchor.placeId),
    anchor.id
  );
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

      const cost = travelCostSum(
        state.cost,
        localSeconds
      );
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
          (cost === bestGoal.cost && compareStrings(key, bestGoal.key) < 0)) {
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

      const cost = travelCostSum(
        state.cost,
        localSeconds,
        edge.portal.transitionCost ?? 0
      );
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
    rejectedDomainPairs: Object.freeze([])
  });
}

function planConcreteDetour(
  registry,
  bridge,
  entity,
  target,
  resolvedTarget,
  options
) {
  const startDomainId = entity.domainId ?? "default";
  const excludedPortalKeys =
    new Set(options.excludedPortalKeys ?? []);
  const excludedPairs =
    new Set(options.excludedDomainPairs ?? []);
  const searchOptions = {
    excludedPortalKeys,
    excludedPairs
  };
  const queue = new MinHeap();
  const bestCostByState = new Map();
  const maxExpansions =
    options.maxNearestTargetExpansions;
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
    if (state.cost !== bestCostByState.get(state.key)) {
      continue;
    }
    if (state.cost > maxCost) continue;
    if (bestGoal && state.cost > bestGoal.cost) break;
    if (++expansions > maxExpansions) {
      throw new Error(
        "explicit semantic detour search exceeded maxNearestTargetExpansions"
      );
    }

    const edges = transitionsFrom(
      registry,
      state.domainId,
      searchOptions
    ).filter(
      (edge) =>
        edge.portalKey !== state.arrivedViaPortalKey
    );

    const destinationNodeIds = new Set();
    const canReachTargetDomain =
      state.domainId === resolvedTarget.domainId;

    if (
      canReachTargetDomain &&
      resolvedTarget.nodeId != null &&
      squaredDistance(
        state.position,
        resolvedTarget.position
      ) > POSITION_EPSILON_SQ
    ) {
      destinationNodeIds.add(
        resolvedTarget.nodeId
      );
    }

    for (const edge of edges) {
      if (
        edge.from.nodeId != null &&
        squaredDistance(
          state.position,
          edge.from.position
        ) > POSITION_EPSILON_SQ
      ) {
        destinationNodeIds.add(edge.from.nodeId);
      }
    }

    const routeCosts = localRouteCostsToMany(
      bridge,
      {
        domainId: state.domainId,
        position: state.position,
        destinationNodeIds,
        mobility: entity.mobility,
        options: options.journeyOptions
      }
    );

    const costTo = (destination) => {
      if (
        squaredDistance(
          state.position,
          destination.position
        ) <= POSITION_EPSILON_SQ
      ) {
        return 0;
      }
      if (destination.nodeId == null) return null;
      return routeCosts.get(destination.nodeId) ?? null;
    };

    if (canReachTargetDomain) {
      const localSeconds = costTo(resolvedTarget);
      if (localSeconds != null) {
        const cost = travelCostSum(
        state.cost,
        localSeconds
      );
        if (cost <= maxCost) {
          const steps = appendJourney(
            state.steps,
            state,
            resolvedTarget,
            { estimatedSeconds: localSeconds }
          );
          if (
            !bestGoal ||
            cost < bestGoal.cost ||
            (
              cost === bestGoal.cost &&
              compareStrings(
                state.key,
                bestGoal.key
              ) < 0
            )
          ) {
            bestGoal = {
              key: state.key,
              cost,
              steps,
              domains: state.domains
            };
          }
        }
      }
    }

    for (const edge of edges) {
      const localSeconds = costTo(edge.from);
      if (localSeconds == null) continue;

      const cost = travelCostSum(
        state.cost,
        localSeconds,
        edge.portal.transitionCost ?? 0
      );
      if (
        cost > maxCost ||
        (bestGoal && cost > bestGoal.cost)
      ) {
        continue;
      }

      const key = transitionKey(edge);
      const previous = bestCostByState.get(key);
      if (previous != null && previous <= cost) {
        continue;
      }

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
        domains: [
          ...state.domains,
          edge.to.domainId
        ],
        arrivedViaPortalKey: edge.portalKey,
        steps: [
          ...journeySteps,
          deepFreeze({
            type: "traverse-portal",
            portalKey: edge.portalKey,
            placeId: edge.portal.instanceId,
            portalId: edge.portal.id,
            fromDomainId: edge.from.domainId,
            toDomainId: edge.to.domainId,
            destinationPosition: edge.to.position,
            transitionCost:
              edge.portal.transitionCost ?? 0
          })
        ]
      });
    }
  }

  if (!bestGoal) return null;

  const steps = Object.freeze(bestGoal.steps);
  return deepFreeze({
    entityId: entity.id,
    target: cloneJson(target),
    resolvedTarget,
    travelRevision: registry.travelRevision,
    startDomainId,
    domainPath: Object.freeze([
      ...bestGoal.domains
    ]),
    steps,
    legs: steps,
    estimatedSeconds: bestGoal.cost,
    rejectedDomainPairs:
      Object.freeze([
        ...excludedPairs
      ])
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
  const directEntity =
    entityOrId != null &&
    typeof entityOrId === "object";
  const entity = directEntity
    ? entityOrId
    : bridge.getEntity(entityOrId);
  if (!entity) {
    throw new Error(
      `unknown entity ${String(entityOrId)}`
    );
  }
  validateTravelEntity(
    entity,
    directEntity
      ? undefined
      : entityOrId
  );

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
  let shortestSearchTruncated = false;
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

    if (optimized.truncated) {
      shortestSearchTruncated = true;
    }

    if (!optimized.plan) {
      if (optimized.failedPair) {
        failedPairs.add(optimized.failedPair);
      }
      continue;
    }

    const candidateKey = domainPathKey(domains);
    if (!bestShortest ||
        optimized.plan.cost < bestShortest.plan.cost ||
        (optimized.plan.cost === bestShortest.plan.cost &&
         compareStrings(candidateKey, bestShortest.key) < 0)) {
      bestShortest = {
        key: candidateKey,
        domains,
        plan: optimized.plan
      };
    }
  }

  if (shortestSearchTruncated) {
    return planConcreteDetour(
      registry,
      bridge,
      entity,
      target,
      resolvedTarget,
      options
    );
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
    if (topological == null) break;

    const domains = topological.domains;

    const optimized = optimizeConcretePath(
      registry,
      bridge,
      entity,
      domains,
      resolvedTarget,
      { ...options, excludedPairs, excludedPortalKeys }
    );

    if (optimized.truncated) {
      return planConcreteDetour(
        registry,
        bridge,
        entity,
        target,
        resolvedTarget,
        options
      );
    }

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

    if (
      !optimized.failedPair ||
      excludedPairs.has(optimized.failedPair)
    ) {
      break;
    }
    excludedPairs.add(optimized.failedPair);
  }

  return planConcreteDetour(
    registry,
    bridge,
    entity,
    target,
    resolvedTarget,
    options
  );
}

function resolveStartCall(registry, a, b, c, d) {
  if (a && typeof a === "object" && typeof a.getEntity === "function" && typeof a.planLocalRoute === "function") {
    return { bridge: a, entityId: b, target: c, options: d ?? {} };
  }
  const options = c ?? {};
  return { bridge: options.bridge ?? registry.bridge, entityId: a, target: b, options };
}

function publicTravelState(state) {
  return snapshotTravelState(state);
}

function finalizeFailedTravel(
  registry,
  state,
  reason
) {
  abortEnteredTravelPortal(
    registry,
    state,
    reason
  );
  state.status = "failed";
  state.failureReason = reason;
  registry._deleteActiveTravel(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
    state.entityId
  );
  registry.emit("travel-failed", {
    entityId: state.entityId,
    reason,
    target: state.target
  });
  return state;
}

function liveTravelEntity(
  registry,
  bridge,
  state,
  resolvedEntity = undefined
) {
  const entity =
    resolvedEntity === undefined
      ? bridge.getEntity(state.entityId)
      : resolvedEntity;

  if (!entity) {
    registry.removeEntityOccupancy(
      state.entityId
    );
    return {
      entity: null,
      failure: fail(
        registry,
        bridge,
        state,
        "entity-missing"
      )
    };
  }

  try {
    validateTravelEntity(
      entity,
      state.entityId
    );
  } catch {
    registry.removeEntityOccupancy(
      state.entityId
    );
    return {
      entity: null,
      failure: fail(
        registry,
        bridge,
        state,
        "invalid-entity-state"
      )
    };
  }

  registry.updateEntityOccupancy(
    entity
  );

  return {
    entity,
    failure: null
  };
}

function fail(registry, bridge, state, reason) {
  let cleanupError = null;
  try {
    bridge.stopLocalJourney(state.entityId);
  } catch (error) {
    cleanupError = error;
  }

  finalizeFailedTravel(
    registry,
    state,
    reason
  );

  if (cleanupError) {
    throw cleanupError;
  }
  return state;
}

function complete(registry, state) {
  state.status = "complete";
  registry._deleteActiveTravel(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
    state.entityId
  );
  registry.emit("travel-complete", {
    entityId: state.entityId,
    target: state.target,
    replans: state.replans
  });
  return state;
}

function replan(registry, bridge, state, options) {
  abortEnteredTravelPortal(
    registry,
    state,
    "replan"
  );

  try {
    bridge.stopLocalJourney(state.entityId);
  } catch (error) {
    finalizeFailedTravel(
      registry,
      state,
      "replan-cleanup-failed"
    );
    throw error;
  }

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
      return finalizeFailedTravel(
        registry,
        state,
        "target-unavailable-after-world-change"
      );
    }
    finalizeFailedTravel(
      registry,
      state,
      "replan-error"
    );
    throw error;
  }
  state.replans += 1;
  state.stepIndex = 0;
  state.localStarted = false;
  state.portalEntered = false;
  state.portalTransitionRemaining = 0;

  if (!plan) {
    return finalizeFailedTravel(
      registry,
      state,
      "no-route-after-world-change"
    );
  }

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

function advance(
  registry,
  bridge,
  state,
  options = {},
  initialEntity = undefined
) {
  let pendingInitialEntity =
    initialEntity;
  const readLiveEntity = () => {
    const resolved =
      pendingInitialEntity;
    pendingInitialEntity =
      undefined;
    return liveTravelEntity(
      registry,
      bridge,
      state,
      resolved
    );
  };

  while (state.status === "active") {
    if (state.stepIndex >= state.plan.steps.length) {
      const live = readLiveEntity();
      if (live.failure) {
        return live.failure;
      }

      if (!resolvedTargetAvailable(
        registry,
        state.plan.resolvedTarget,
        state.target
      )) {
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
      const live = readLiveEntity();
      if (live.failure) {
        return live.failure;
      }
      const entity = live.entity;

      if ((entity.domainId ?? "default") !== step.domainId) {
        return replan(registry, bridge, state, options);
      }

      if (!state.localStarted) {
        const journeyOptions =
          cloneJourneyOptions(
            options.journeyOptions
          );
        const ok = bridge.startLocalJourney(
          state.entityId,
          step.destinationNodeId,
          journeyOptions
        );
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

      const live = readLiveEntity();
      if (live.failure) {
        return live.failure;
      }
      const entity = live.entity;

      if ((entity.domainId ?? "default") !== step.fromDomainId) {
        return replan(registry, bridge, state, options);
      }

      const portalEntryTolerance = normalizePortalEntryTolerance(
        options.portalEntryTolerance
      );
      if (
        pointDistance(
          entity.position,
          direction.from.position
        ) > portalEntryTolerance
      ) {
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

      let moved;
      try {
        bridge.transferEntity(
          state.entityId,
          direction.to
        );
        moved = bridge.getEntity(
          state.entityId
        );
      } catch (error) {
        registry.removeEntityOccupancy(
          state.entityId
        );
        throw error;
      }

      if (!moved) {
        registry.removeEntityOccupancy(
          state.entityId
        );
        return fail(
          registry,
          bridge,
          state,
          "entity-missing-after-portal-transfer"
        );
      }

      const movedDomainId = moved.domainId ?? "default";
      const transferDomainValid =
        typeof movedDomainId === "string" &&
        movedDomainId.length > 0;
      const transferPositionValid =
        moved.position &&
        Number.isFinite(moved.position.x) &&
        Number.isFinite(moved.position.y);

      const emitTransferFailed = (
        actualPosition
      ) => {
        registry.emit("portal-transfer-failed", {
          entityId: state.entityId,
          placeId: portal.instanceId,
          portalId: portal.id,
          expectedDomainId: step.toDomainId,
          actualDomainId:
            transferDomainValid
              ? movedDomainId
              : null,
          expectedPosition: {
            x: direction.to.position.x,
            y: direction.to.position.y
          },
          actualPosition
        });
      };

      if (moved.id !== state.entityId) {
        registry.removeEntityOccupancy(
          state.entityId
        );
        emitTransferFailed(
          transferPositionValid
            ? {
                x: moved.position.x,
                y: moved.position.y
              }
            : null
        );
        return fail(
          registry,
          bridge,
          state,
          "entity-id-mismatch-after-portal-transfer"
        );
      }

      if (!transferDomainValid) {
        registry.removeEntityOccupancy(
          state.entityId
        );
        emitTransferFailed(
          transferPositionValid
            ? {
                x: moved.position.x,
                y: moved.position.y
              }
            : null
        );
        return fail(
          registry,
          bridge,
          state,
          "invalid-domain-after-portal-transfer"
        );
      }

      if (!transferPositionValid) {
        registry.removeEntityOccupancy(
          state.entityId
        );
        emitTransferFailed(null);
        return fail(
          registry,
          bridge,
          state,
          "invalid-position-after-portal-transfer"
        );
      }

      registry.updateEntityOccupancy(moved);

      const transferPositionDistance =
        pointDistance(
          moved.position,
          direction.to.position
        );

      if (
        movedDomainId !== step.toDomainId ||
        transferPositionDistance >
          portalEntryTolerance
      ) {
        emitTransferFailed({
          x: moved.position.x,
          y: moved.position.y
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

function startTravelCore(
  registry,
  bridge,
  entityId,
  target,
  options,
  resolvedEntity = undefined
) {
  assertRegistryExecutionBridge(
    registry,
    bridge,
    "startTravel"
  );

  const existingState =
    registry._getActiveTravel(
      PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
      entityId
    );
  if (existingState) {
    assertActiveTravelBridge(
      existingState,
      bridge,
      "startTravel"
    );
  }
  assertRegistryActiveTravelBridge(
    registry,
    bridge,
    "startTravel"
  );

  if (resolvedEntity !== undefined) {
    validateTravelEntity(
      resolvedEntity,
      entityId
    );
  }

  const capturedOptions = captureTravelOptions(options);
  const plan = planTravel(
    registry,
    bridge,
    resolvedEntity === undefined
      ? entityId
      : resolvedEntity,
    target,
    capturedOptions
  );
  if (!plan) return null;

  if (registry._hasActiveTravel(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
    entityId
  )) {
    stopTravel(
      registry,
      bridge,
      entityId,
      { reason: "replaced" }
    );
  }

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
  bindTravelRuntimeBridge(
    state,
    bridge
  );
  registry._setActiveTravel(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
    entityId,
    state
  );
  registry.emit("travel-start", {
    entityId,
    target: state.target,
    estimatedSeconds: plan.estimatedSeconds
  });

  try {
    return publicTravelState(
      advance(
        registry,
        bridge,
        state,
        capturedOptions,
        resolvedEntity
      )
    );
  } catch (error) {
    let cleanupError = null;
    if (
      state.status === "active" &&
      registry._hasActiveTravel(
        PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
        entityId
      )
    ) {
      try {
        bridge.stopLocalJourney?.(entityId);
      } catch (failure) {
        cleanupError = failure;
      }

      finalizeFailedTravel(
        registry,
        state,
        "start-error"
      );
    }

    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "travel start failed and local journey cleanup also failed"
      );
    }
    throw error;
  }
}

export function _startTravelWithEntity(
  registry,
  bridge,
  entityId,
  entity,
  target,
  options = {}
) {
  if (!bridge) {
    throw new Error(
      "startTravel requires a WorldCoreBridge"
    );
  }
  return startTravelCore(
    registry,
    bridge,
    entityId,
    target,
    options,
    entity
  );
}

export function startTravel(registry, a, b, c, d) {
  const {
    bridge,
    entityId,
    target,
    options
  } = resolveStartCall(
    registry,
    a,
    b,
    c,
    d
  );
  if (!bridge) {
    throw new Error(
      "startTravel requires a WorldCoreBridge"
    );
  }
  return startTravelCore(
    registry,
    bridge,
    entityId,
    target,
    options
  );
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

  const state = registry._getActiveTravel(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
    entityId
  );
  if (!state) return null;

  assertRegistryExecutionBridge(
    registry,
    bridge,
    "stepTravel"
  );
  assertActiveTravelBridge(
    state,
    bridge,
    "stepTravel"
  );

  try {
    const effectiveOptions = normalizeEffectiveStepOptions(
      effectiveTravelOptions(state, options)
    );
  const worldChangePolicy = effectiveOptions.worldChangePolicy;

  if (worldChangePolicy === "eager" &&
      state.travelRevision !== registry.travelRevision) {
    const live = liveTravelEntity(
      registry,
      bridge,
      state
    );
    if (live.failure) {
      return publicTravelState(
        live.failure
      );
    }

    const next = replan(
      registry,
      bridge,
      state,
      effectiveOptions
    );
    if (next.status !== "active") {
      return publicTravelState(next);
    }
  }

  const step = state.plan.steps[state.stepIndex];
  if (step?.type === "local-journey" && state.localStarted) {
    const live = liveTravelEntity(
      registry,
      bridge,
      state
    );
    if (live.failure) {
      return publicTravelState(
        live.failure
      );
    }
    const entity = live.entity;
    const liveDomainId =
      entity.domainId ?? "default";

    if (liveDomainId !== step.domainId) {
      const next = replan(
        registry,
        bridge,
        state,
        effectiveOptions
      );
      if (next.status !== "active") {
        return publicTravelState(next);
      }
      return publicTravelState(
        advance(
          registry,
          bridge,
          next,
          effectiveOptions
        )
      );
    } else if (entity.journey != null) {
      const liveDestinationNodeId =
        entity.journey?.destinationNodeId ??
        null;

      if (
        liveDestinationNodeId == null ||
        liveDestinationNodeId ===
          step.destinationNodeId
      ) {
        return publicTravelState(state);
      }

      const next = replan(
        registry,
        bridge,
        state,
        effectiveOptions
      );
      if (next.status !== "active") {
        return publicTravelState(next);
      }
      return publicTravelState(
        advance(
          registry,
          bridge,
          next,
          effectiveOptions
        )
      );
    }

    const arrived =
      (entity.domainId ?? "default") === step.domainId &&
      squaredDistance(
        entity.position,
        step.destinationPosition
      ) <= POSITION_EPSILON_SQ;

    if (!arrived) {
      const next = replan(
        registry,
        bridge,
        state,
        effectiveOptions
      );
      if (next.status !== "active") {
        return publicTravelState(next);
      }
    } else {
      state.stepIndex += 1;
      state.localStarted = false;
    }
  }

    return publicTravelState(
      advance(
        registry,
        bridge,
        state,
        effectiveOptions
      )
    );
  } catch (error) {
    if (
      state.status === "active" &&
      registry._hasActiveTravel(
        PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
        entityId
      )
    ) {
      let cleanupError = null;
      try {
        bridge.stopLocalJourney?.(
          entityId
        );
      } catch (failure) {
        cleanupError = failure;
      }

      finalizeFailedTravel(
        registry,
        state,
        "step-error"
      );

      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "travel step failed and local journey cleanup also failed"
        );
      }
    }
    throw error;
  }
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

  assertRegistryExecutionBridge(
    registry,
    bridge,
    "stepPlaceSimulation"
  );

  const ids = registry._activeTravelIds(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN
  );
  for (const entityId of ids) {
    const state = registry._getActiveTravel(
      PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
      entityId
    );
    if (state) {
      assertActiveTravelBridge(
        state,
        bridge,
        "stepPlaceSimulation"
      );
    }
  }

  const errors = [];

  for (const entityId of ids) {
    try {
      stepTravel(
        registry,
        bridge,
        entityId,
        options
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
      "multiple travels failed during place simulation step"
    );
  }

  return registry._activeTravelCount(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN
  );
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

  const state = registry._getActiveTravel(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
    entityId
  );
  if (!state) return false;

  bridge ??=
    getTravelRuntimeBridge(state) ??
    registry.bridge;

  if (!bridge) {
    throw new Error(
      "stopTravel requires the WorldCoreBridge that owns the active travel"
    );
  }

  assertRegistryExecutionBridge(
    registry,
    bridge,
    "stopTravel"
  );
  assertActiveTravelBridge(
    state,
    bridge,
    "stopTravel"
  );

  abortEnteredTravelPortal(
    registry,
    state,
    options.reason
  );

  let cleanupError = null;
  try {
    bridge?.stopLocalJourney?.(entityId);
  } catch (error) {
    cleanupError = error;
  }

  registry._deleteActiveTravel(
    PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
    entityId
  );
  state.status = "cancelled";
  registry.emit("travel-cancelled", {
    entityId,
    reason: options.reason
  });

  if (cleanupError) {
    throw cleanupError;
  }
  return true;
}
