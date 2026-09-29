import { squaredDistance } from "./geometry.js";
import { isPortalTraversable } from "./registry.js";
import { cloneJson, deepFreeze } from "./utils.js";

const EMPTY_SET = new Set();
const POSITION_EPSILON_SQ = 1e-8;

class MinHeap {
  #items = [];

  push(item) {
    let index = this.#items.length;
    this.#items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareQueue(this.#items[parent], item) <= 0) break;
      this.#items[index] = this.#items[parent];
      index = parent;
    }
    this.#items[index] = item;
  }

  pop() {
    if (!this.#items.length) return null;
    const root = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= this.#items.length) break;
        const right = left + 1;
        let child = left;
        if (right < this.#items.length && compareQueue(this.#items[right], this.#items[left]) < 0) child = right;
        if (compareQueue(this.#items[child], last) >= 0) break;
        this.#items[index] = this.#items[child];
        index = child;
      }
      this.#items[index] = last;
    }
    return root;
  }

  get size() { return this.#items.length; }
}

function compareQueue(a, b) {
  if (a.cost !== b.cost) return a.cost - b.cost;
  return a.key.localeCompare(b.key);
}

function pairKey(a, b) {
  return `${a}\u0000${b}`;
}

function transitionKey(edge) {
  return `${edge.portal.key}\u0000${edge.side}`;
}

function transitionsFrom(registry, domainId, options = {}) {
  const excludedPortalKeys = options.excludedPortalKeys ?? EMPTY_SET;
  const excludedPairs = options.excludedPairs ?? EMPTY_SET;
  const edges = [];

  for (const portal of registry.getPortalsForDomain(domainId)) {
    if (!portal || excludedPortalKeys.has(portal.key) || !isPortalTraversable(portal)) continue;
    if (portal.a.domainId === portal.b.domainId) continue;

    if (portal.a.domainId === domainId) {
      if (!excludedPairs.has(pairKey(domainId, portal.b.domainId))) {
        edges.push({ portal, portalKey: portal.key, side: "a", from: portal.a, to: portal.b });
      }
    }
    if (portal.bidirectional !== false && portal.b.domainId === domainId) {
      if (!excludedPairs.has(pairKey(domainId, portal.a.domainId))) {
        edges.push({ portal, portalKey: portal.key, side: "b", from: portal.b, to: portal.a });
      }
    }
  }

  edges.sort((a, b) => transitionKey(a).localeCompare(transitionKey(b)));
  return edges;
}

function transitionsInto(registry, domainId, options = {}) {
  const excludedPortalKeys = options.excludedPortalKeys ?? EMPTY_SET;
  const excludedPairs = options.excludedPairs ?? EMPTY_SET;
  const edges = [];

  for (const portal of registry.getPortalsForDomain(domainId)) {
    if (!portal || excludedPortalKeys.has(portal.key) || !isPortalTraversable(portal)) continue;
    if (portal.a.domainId === portal.b.domainId) continue;

    if (portal.b.domainId === domainId) {
      if (!excludedPairs.has(pairKey(portal.a.domainId, domainId))) {
        edges.push({ portal, portalKey: portal.key, side: "a", from: portal.a, to: portal.b });
      }
    }
    if (portal.bidirectional !== false && portal.a.domainId === domainId) {
      if (!excludedPairs.has(pairKey(portal.b.domainId, domainId))) {
        edges.push({ portal, portalKey: portal.key, side: "b", from: portal.b, to: portal.a });
      }
    }
  }

  edges.sort((a, b) => transitionKey(a).localeCompare(transitionKey(b)));
  return edges;
}

function neighborDomains(edges, direction) {
  const set = new Set();
  for (const edge of edges) set.add(direction === "out" ? edge.to.domainId : edge.from.domainId);
  return [...set].sort();
}

export function findDomainPortalPath(registry, startDomainId, targetDomainId, options = {}) {
  if (startDomainId === targetDomainId) return [];

  const forwardVisited = new Map([[startDomainId, null]]);
  const backwardVisited = new Map([[targetDomainId, null]]);
  let forwardFrontier = new Set([startDomainId]);
  let backwardFrontier = new Set([targetDomainId]);
  let meeting = null;
  let preferForward = true;

  while (forwardFrontier.size && backwardFrontier.size) {
    const expandForward = forwardFrontier.size < backwardFrontier.size ||
      (forwardFrontier.size === backwardFrontier.size && preferForward);
    preferForward = !preferForward;

    if (expandForward) {
      const next = new Set();
      for (const domainId of [...forwardFrontier].sort()) {
        const neighbors = neighborDomains(transitionsFrom(registry, domainId, options), "out");
        for (const neighbor of neighbors) {
          if (forwardVisited.has(neighbor)) continue;
          forwardVisited.set(neighbor, domainId);
          if (backwardVisited.has(neighbor)) {
            meeting = neighbor;
            break;
          }
          next.add(neighbor);
        }
        if (meeting) break;
      }
      if (meeting) break;
      forwardFrontier = next;
    } else {
      const next = new Set();
      for (const domainId of [...backwardFrontier].sort()) {
        const predecessors = neighborDomains(transitionsInto(registry, domainId, options), "in");
        for (const predecessor of predecessors) {
          if (backwardVisited.has(predecessor)) continue;
          backwardVisited.set(predecessor, domainId);
          if (forwardVisited.has(predecessor)) {
            meeting = predecessor;
            break;
          }
          next.add(predecessor);
        }
        if (meeting) break;
      }
      if (meeting) break;
      backwardFrontier = next;
    }
  }

  if (!meeting) return null;

  const prefix = [];
  let cursor = meeting;
  while (cursor !== startDomainId) {
    prefix.push(cursor);
    cursor = forwardVisited.get(cursor);
    if (cursor == null) throw new Error("corrupt forward domain search state");
  }
  prefix.push(startDomainId);
  prefix.reverse();

  const suffix = [];
  cursor = meeting;
  while (cursor !== targetDomainId) {
    cursor = backwardVisited.get(cursor);
    if (cursor == null) throw new Error("corrupt backward domain search state");
    suffix.push(cursor);
  }

  const domains = [...prefix, ...suffix];
  const edges = [];
  for (let i = 0; i < domains.length - 1; i += 1) {
    const candidates = transitionsFrom(registry, domains[i], options)
      .filter((edge) => edge.to.domainId === domains[i + 1]);
    if (!candidates.length) throw new Error("domain path references missing portal transition");
    edges.push(candidates[0]);
  }
  Object.defineProperty(edges, "domains", { value: Object.freeze(domains), enumerable: false });
  return edges;
}

export function resolveTravelTarget(registry, target) {
  if (!target || typeof target !== "object") throw new TypeError("travel target is required");

  if (typeof target.domainId === "string" && target.position) {
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

  if (target.kind === "nearest" && target.tag && typeof registry.findAnchors === "function") {
    const candidates = registry.findAnchors({ tag: target.tag });
    if (!candidates.length) throw new Error(`no anchor matches tag ${target.tag}`);
    candidates.sort((a, b) => {
      const place = String(a.placeId).localeCompare(String(b.placeId));
      return place || a.id.localeCompare(b.id);
    });
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
  if (!instance) throw new Error(`unknown target place ${String(target.placeId)}`);
  const definition = registry.getDefinition(instance.definitionId);
  let anchor = null;

  if (target.anchorId != null) {
    anchor = definition.getAnchor(target.anchorId);
    if (!anchor) throw new Error(`unknown anchor ${target.anchorId} on place ${String(target.placeId)}`);
  } else if (target.spaceId != null) {
    const space = definition.getSpace(target.spaceId);
    if (!space) throw new Error(`unknown space ${target.spaceId} on place ${String(target.placeId)}`);
    if (space.defaultAnchorId) anchor = definition.getAnchor(space.defaultAnchorId);
    if (!anchor) {
      anchor = [...definition.getAnchorsForSpace(space.id)]
        .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
    }
  } else if (definition.defaultAnchorId) {
    anchor = definition.getAnchor(definition.defaultAnchorId);
  } else {
    anchor = [...definition.getAnchorsByTag("entry")]
      .sort((a, b) => a.id.localeCompare(b.id))[0] ??
      [...definition.anchors].sort((a, b) => a.id.localeCompare(b.id))[0] ??
      null;
  }

  if (!anchor) throw new Error(`place ${String(target.placeId)} has no routable anchor`);
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

    const cap = options.maxConcreteStatesPerLayer ?? 128;
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


function computeReverseDomainDistances(registry, targetDomainId, options = {}) {
  const distances = new Map([[targetDomainId, 0]]);
  const queue = [targetDomainId];
  const maxDomains = options.maxDomainSearchDomains ?? 1_000_000;

  for (let index = 0; index < queue.length; index += 1) {
    if (distances.size > maxDomains) {
      throw new Error("place travel domain search exceeded maxDomainSearchDomains");
    }
    const domainId = queue[index];
    const distance = distances.get(domainId);

    for (const edge of transitionsInto(registry, domainId, options)) {
      const predecessor = edge.from.domainId;
      if (distances.has(predecessor)) continue;
      distances.set(predecessor, distance + 1);
      queue.push(predecessor);
    }
  }

  return distances;
}

function optimizeAllShortestDomainPaths(
  registry,
  bridge,
  entity,
  resolvedTarget,
  options,
  reverseDistances
) {
  const startDomainId = entity.domainId ?? "default";
  const minimumHops = reverseDistances.get(startDomainId);
  if (minimumHops == null) return null;

  const routeCache = new Map();
  let states = [{
    key: "start",
    cost: 0,
    domainId: startDomainId,
    position: entity.position,
    steps: [],
    domains: [startDomainId]
  }];

  for (let remaining = minimumHops; remaining > 0; remaining -= 1) {
    const nextByEndpoint = new Map();

    for (const state of states) {
      const stateDistance = reverseDistances.get(state.domainId);
      if (stateDistance !== remaining) continue;

      for (const edge of transitionsFrom(registry, state.domainId, options)) {
        if (reverseDistances.get(edge.to.domainId) !== remaining - 1) continue;

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
          domains: [...state.domains, edge.to.domainId],
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

    if (!states.length) return null;

    const cap = options.maxConcreteStatesPerLayer ?? 128;
    if (states.length > cap) states.length = cap;
  }

  let best = null;
  for (const state of states) {
    if (state.domainId !== resolvedTarget.domainId) continue;

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
      best = {
        key: state.key,
        cost,
        steps,
        domains: state.domains
      };
    }
  }

  return best;
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
  const maxExpansions = options.maxNearestTargetExpansions ?? 250_000;
  const maxCost = Number.isFinite(options.maxCost) ? options.maxCost : Infinity;

  const start = {
    key: "start",
    cost: 0,
    domainId: startDomainId,
    position: entity.position,
    steps: [],
    domains: [startDomainId]
  };
  bestCostByState.set(start.key, 0);
  queue.push(start);

  let bestGoal = null;
  let expansions = 0;

  while (queue.size) {
    const state = queue.pop();
    if (state.cost !== bestCostByState.get(state.key)) continue;
    if (state.cost >= maxCost) continue;
    if (bestGoal && state.cost >= bestGoal.cost) break;
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

    const edges = transitionsFrom(registry, state.domainId, searchOptions);
    const destinationNodeIds = new Set();

    for (const anchor of anchors) {
      if (anchor.nodeId != null) destinationNodeIds.add(anchor.nodeId);
    }
    for (const edge of edges) {
      if (edge.from.nodeId != null) destinationNodeIds.add(edge.from.nodeId);
    }

    const routeCosts = bridge.planLocalRouteCostsToMany({
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
      if (cost > maxCost || (bestGoal && cost >= bestGoal.cost)) continue;

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
    graphRevision: registry.graphRevision,
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
  const { bridge, entityOrId, target, options } = resolvePlanCall(registry, a, b, c, d);
  if (!bridge) throw new Error("planTravel requires a WorldCoreBridge");
  const entity = typeof entityOrId === "object" ? entityOrId : bridge.getEntity(entityOrId);
  if (!entity) throw new Error(`unknown entity ${String(entityOrId)}`);
  if (!entity.mobility) throw new Error(`entity ${String(entity.id)} has no mobility profile`);

  if (target?.kind === "nearest" && target.tag) {
    return planNearestTaggedAnchor(registry, bridge, entity, target, options);
  }

  const resolvedTarget = resolveTravelTarget(registry, target);
  const startDomainId = entity.domainId ?? "default";
  const excludedPortalKeys = new Set(options.excludedPortalKeys ?? []);
  const baseSearchOptions = { ...options, excludedPortalKeys };

  const reverseDistances = computeReverseDomainDistances(
    registry,
    resolvedTarget.domainId,
    baseSearchOptions
  );

  const shortest = optimizeAllShortestDomainPaths(
    registry,
    bridge,
    entity,
    resolvedTarget,
    baseSearchOptions,
    reverseDistances
  );

  if (shortest) {
    const steps = Object.freeze(shortest.steps);
    return deepFreeze({
      entityId: entity.id,
      target: cloneJson(target),
      resolvedTarget,
      graphRevision: registry.graphRevision,
      startDomainId,
      domainPath: Object.freeze([...shortest.domains]),
      steps,
      legs: steps,
      estimatedSeconds: shortest.cost,
      rejectedDomainPairs: Object.freeze([])
    });
  }

  const excludedPairs = new Set(options.excludedDomainPairs ?? []);
  const maxAttempts = options.maxDomainPathAttempts ?? 32;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const topological = findDomainPortalPath(
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
        graphRevision: registry.graphRevision,
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

function normalizeWorldChangePolicy(value) {
  const policy = value ?? "encounter";
  if (policy !== "encounter" && policy !== "eager") {
    throw new TypeError("worldChangePolicy must be \"encounter\" or \"eager\"");
  }
  return policy;
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
  const plan = planTravel(registry, bridge, state.entityId, state.target, options);
  state.replans += 1;
  state.stepIndex = 0;
  state.localStarted = false;
  state.portalEntered = false;
  state.portalTransitionRemaining = 0;

  if (!plan) return fail(registry, bridge, state, "no-route-after-world-change");

  state.plan = plan;
  state.graphRevision = registry.graphRevision;
  registry.emit("travel-replan", {
    entityId: state.entityId,
    target: state.target,
    graphRevision: state.graphRevision,
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
    if (state.stepIndex >= state.plan.steps.length) return complete(registry, state);
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

      const deltaSeconds = Math.max(0, options.deltaSeconds ?? 0);
      if (state.portalTransitionRemaining > 0) {
        state.portalTransitionRemaining = Math.max(0, state.portalTransitionRemaining - deltaSeconds);
        if (state.portalTransitionRemaining > 0) return state;
      }

      bridge.transferEntity(state.entityId, direction.to);
      const moved = bridge.getEntity(state.entityId);
      if (moved) registry.syncEntityOccupancy(moved);
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

  const plan = planTravel(registry, bridge, entityId, target, options);
  if (!plan) return null;

  const state = {
    entityId,
    target: cloneJson(target),
    plan,
    stepIndex: 0,
    localStarted: false,
    portalEntered: false,
    portalTransitionRemaining: 0,
    graphRevision: registry.graphRevision,
    worldChangePolicy: normalizeWorldChangePolicy(options.worldChangePolicy),
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
  return advance(registry, bridge, state, options);
}

function resolveStepCall(registry, a, b, c) {
  if (a && typeof a === "object" && typeof a.getEntity === "function" && typeof a.planLocalRoute === "function") {
    return { bridge: a, entityId: b, options: c ?? {} };
  }
  const options = b ?? {};
  return { bridge: options.bridge ?? registry.bridge, entityId: a, options };
}

export function stepTravel(registry, a, b, c) {
  const { bridge, entityId, options } = resolveStepCall(registry, a, b, c);
  if (!bridge) throw new Error("stepTravel requires a WorldCoreBridge");
  const state = registry.activeTravels.get(entityId);
  if (!state) return null;

  const worldChangePolicy = options.worldChangePolicy == null
    ? state.worldChangePolicy
    : normalizeWorldChangePolicy(options.worldChangePolicy);

  if (worldChangePolicy === "eager" && state.graphRevision !== registry.graphRevision) {
    const next = replan(registry, bridge, state, options);
    if (next.status !== "active") return next;
  }

  const step = state.plan.steps[state.stepIndex];
  if (step?.type === "local-journey" && state.localStarted) {
    const entity = bridge.getEntity(entityId);
    if (!entity) return fail(registry, bridge, state, "entity-missing");

    registry.syncEntityOccupancy(entity);
    if (entity.journey != null) return state;

    if (entity.lastJourneyFailure?.destinationNodeId === step.destinationNodeId) {
      const next = replan(registry, bridge, state, options);
      if (next.status !== "active") return next;
    } else {
      state.stepIndex += 1;
      state.localStarted = false;
    }
  }

  return advance(registry, bridge, state, options);
}

export function stepPlaceSimulation(registry, a = {}, b = 0, c = {}) {
  let bridge;
  let deltaSeconds;
  let options;

  if (a && typeof a === "object" && typeof a.getEntity === "function" && typeof a.planLocalRoute === "function") {
    bridge = a;
    deltaSeconds = Number.isFinite(b) ? b : 0;
    options = c ?? {};
  } else {
    options = a ?? {};
    bridge = options.bridge ?? registry.bridge;
    deltaSeconds = Number.isFinite(options.deltaSeconds) ? options.deltaSeconds : 0;
  }

  if (!bridge) throw new Error("stepPlaceSimulation requires a WorldCoreBridge");
  const ids = [...registry.activeTravels.keys()];
  for (const entityId of ids) {
    stepTravel(registry, bridge, entityId, { ...options, deltaSeconds });
  }
  return registry.activeTravels.size;
}

export function stopTravel(registry, a, b, c = {}) {
  let bridge;
  let entityId;
  let options;

  if (a && typeof a === "object" && typeof a.getEntity === "function") {
    bridge = a;
    entityId = b;
    options = c ?? {};
  } else {
    entityId = a;
    options = b ?? {};
    bridge = options.bridge ?? registry.bridge;
  }

  const state = registry.activeTravels.get(entityId);
  if (!state) return false;
  bridge?.stopLocalJourney?.(entityId);
  registry.activeTravels.delete(entityId);
  state.status = "cancelled";
  registry.emit("travel-cancelled", {
    entityId,
    reason: options.reason ?? "cancelled"
  });
  return true;
}
