import { isPortalTraversable } from "./registry.js";
import { squaredDistance } from "./geometry.js";
import { cloneJson, deepFreeze } from "./utils.js";

class MinHeap {
  #items = [];

  push(item) {
    let i = this.#items.length;
    this.#items.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compareQueue(this.#items[p], item) <= 0) break;
      this.#items[i] = this.#items[p];
      i = p;
    }
    this.#items[i] = item;
  }

  pop() {
    if (this.#items.length === 0) return null;
    const root = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length && last) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        const right = left + 1;
        if (left >= this.#items.length) break;
        let child = left;
        if (right < this.#items.length && compareQueue(this.#items[right], this.#items[left]) < 0) child = right;
        if (compareQueue(this.#items[child], last) >= 0) break;
        this.#items[i] = this.#items[child];
        i = child;
      }
      this.#items[i] = last;
    }
    return root;
  }

  get size() { return this.#items.length; }
}

function compareQueue(a, b) {
  if (a.cost !== b.cost) return a.cost - b.cost;
  return a.key.localeCompare(b.key);
}

function endpointKey(portal, side) {
  return `${String(portal.placeId ?? "")}:${portal.id}:${side}`;
}

function closeEnough(a, b, epsilon = 1e-6) {
  return squaredDistance(a, b) <= epsilon * epsilon;
}

function portalCandidates(registry, domainId) {
  const result = [];
  for (const portal of registry.resolvedPortals()) {
    if (!portal || !isPortalTraversable(portal) || !portal.a || !portal.b) continue;
    if (portal.a.domainId === domainId) result.push({ portal, from: portal.a, to: portal.b, side: "a" });
    if (portal.b.domainId === domainId && portal.bidirectional !== false) {
      result.push({ portal, from: portal.b, to: portal.a, side: "b" });
    }
  }
  result.sort((x, y) => endpointKey(x.portal, x.side).localeCompare(endpointKey(y.portal, y.side)));
  return result;
}

function localRoute(bridge, entity, from, destination) {
  if (from.domainId !== destination.domainId) return null;
  if (closeEnough(from.position, destination.position) && destination.nodeId == null) {
    return { estimatedSeconds: 0, destinationNodeId: null, route: null, prefixLeg: null, entryPoint: null };
  }
  if (destination.nodeId == null) return null;
  const result = bridge.planLocalRoute({
    domainId: from.domainId,
    position: from.position,
    destinationNodeId: destination.nodeId,
    mobility: entity.mobility,
    options: undefined
  });
  return result;
}

function journeyLeg(from, destination, routePlan) {
  if (!routePlan || routePlan.estimatedSeconds <= 0) return null;
  return deepFreeze({
    type: "journey",
    domainId: from.domainId,
    destinationNodeId: destination.nodeId,
    destinationPosition: { ...destination.position },
    estimatedSeconds: routePlan.estimatedSeconds
  });
}

function portalLeg(candidate) {
  return deepFreeze({
    type: "portal",
    placeId: candidate.portal.placeId ?? null,
    portalId: candidate.portal.id,
    side: candidate.side,
    from: cloneEndpoint(candidate.from),
    to: cloneEndpoint(candidate.to),
    estimatedSeconds: candidate.portal.transitionCost ?? 0
  });
}

function cloneEndpoint(endpoint) {
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

export function findDomainPortalPath(registry, startDomainId, targetDomainId) {
  if (startDomainId === targetDomainId) return [];
  const queue = [{ domainId: startDomainId, path: [] }];
  const visited = new Set([startDomainId]);
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    for (const candidate of portalCandidates(registry, current.domainId)) {
      const nextDomainId = candidate.to.domainId;
      const nextPath = [...current.path, portalLeg(candidate)];
      if (nextDomainId === targetDomainId) return nextPath;
      if (!visited.has(nextDomainId)) {
        visited.add(nextDomainId);
        queue.push({ domainId: nextDomainId, path: nextPath });
      }
    }
  }
  return null;
}

export function resolveTravelTarget(registry, entity, target) {
  if (!target || typeof target !== "object") throw new TypeError("travel target is required");

  if (typeof target.domainId === "string" && target.position) {
    return deepFreeze({
      domainId: target.domainId,
      position: { x: target.position.x, y: target.position.y },
      nodeId: target.nodeId ?? null,
      placeId: target.placeId ?? null,
      layerId: target.layerId ?? null,
      spaceId: target.spaceId ?? null,
      anchorId: target.anchorId ?? null
    });
  }

  if (target.placeId != null && target.anchorId != null) {
    const anchor = registry.resolveAnchor(target.placeId, target.anchorId);
    if (!anchor) throw new Error(`unknown target anchor ${target.anchorId}`);
    return deepFreeze({
      domainId: anchor.domainId,
      position: { ...anchor.position },
      nodeId: anchor.nodeId,
      placeId: target.placeId,
      layerId: anchor.layerId,
      spaceId: anchor.spaceId,
      anchorId: anchor.id
    });
  }

  if (target.placeId != null && target.spaceId != null) {
    const place = registry.getPlace(target.placeId);
    if (!place) throw new Error(`unknown target place ${String(target.placeId)}`);
    const definition = registry.getDefinition(place.definitionId);
    const space = definition?.getSpace(target.spaceId);
    if (!space) throw new Error(`unknown target space ${target.spaceId}`);
    const anchors = definition.getAnchorsForSpace(space.id);
    const anchor = space.defaultAnchorId
      ? definition.getAnchor(space.defaultAnchorId)
      : [...anchors].sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
    if (!anchor) throw new Error(`target space ${space.id} has no anchor`);
    return resolveTravelTarget(registry, entity, { placeId: target.placeId, anchorId: anchor.id });
  }

  if (target.placeId != null) {
    const place = registry.getPlace(target.placeId);
    if (!place) throw new Error(`unknown target place ${String(target.placeId)}`);
    const definition = registry.getDefinition(place.definitionId);
    const anchorId = definition.defaultAnchorId ?? [...definition.anchors].sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
    if (!anchorId) throw new Error(`target place ${String(target.placeId)} has no anchor`);
    return resolveTravelTarget(registry, entity, { placeId: target.placeId, anchorId });
  }

  if (target.kind === "nearest" && target.tag) {
    const sameDomain = registry.findNearestAnchor({
      domainId: entity.domainId,
      position: entity.position,
      tag: target.tag
    });
    if (sameDomain) {
      return resolveTravelTarget(registry, entity, {
        placeId: sameDomain.anchor.placeId,
        anchorId: sameDomain.anchor.id
      });
    }
    const candidates = registry.findAnchors({ tag: target.tag })
      .sort((a, b) => {
        const p = String(a.placeId).localeCompare(String(b.placeId));
        return p || a.id.localeCompare(b.id);
      });
    if (!candidates.length) throw new Error(`no anchor matches tag ${target.tag}`);
    return resolveTravelTarget(registry, entity, {
      placeId: candidates[0].placeId,
      anchorId: candidates[0].id
    });
  }

  throw new TypeError("unsupported travel target");
}

export function planTravel(registry, bridge, entityId, target, options = {}) {
  const entity = bridge.getEntity(entityId);
  if (!entity) throw new Error(`unknown entity ${String(entityId)}`);
  if (!entity.mobility) throw new Error(`entity ${String(entityId)} has no mobility profile`);

  const resolvedTarget = resolveTravelTarget(registry, entity, target);
  const start = {
    domainId: entity.domainId ?? "default",
    position: { x: entity.position.x, y: entity.position.y },
    nodeId: null
  };

  const heap = new MinHeap();
  const startState = {
    key: "start",
    cost: 0,
    domainId: start.domainId,
    position: start.position,
    nodeId: null,
    legs: []
  };
  heap.push(startState);
  const best = new Map([["start", 0]]);
  let bestGoal = null;
  let expansions = 0;
  const maxExpansions = options.maxExpansions ?? 100_000;

  while (heap.size) {
    const current = heap.pop();
    if (current.cost !== best.get(current.key)) continue;
    if (++expansions > maxExpansions) throw new Error("place travel planning exceeded maxExpansions");

    if (current.domainId === resolvedTarget.domainId) {
      const local = localRoute(bridge, entity, current, resolvedTarget);
      if (local) {
        const leg = journeyLeg(current, resolvedTarget, local);
        const cost = current.cost + local.estimatedSeconds;
        const legs = leg ? [...current.legs, leg] : [...current.legs];
        if (!bestGoal || cost < bestGoal.cost) {
          bestGoal = { cost, legs };
        }
      }
    }

    if (bestGoal && current.cost >= bestGoal.cost) continue;

    for (const candidate of portalCandidates(registry, current.domainId)) {
      const local = localRoute(bridge, entity, current, candidate.from);
      if (!local) continue;

      const localLeg = journeyLeg(current, candidate.from, local);
      const pLeg = portalLeg(candidate);
      const nextCost = current.cost + local.estimatedSeconds + (candidate.portal.transitionCost ?? 0);
      if (bestGoal && nextCost >= bestGoal.cost) continue;

      const key = endpointKey(candidate.portal, candidate.side === "a" ? "b" : "a");
      const previousBest = best.get(key);
      if (previousBest != null && previousBest <= nextCost) continue;
      best.set(key, nextCost);
      heap.push({
        key,
        cost: nextCost,
        domainId: candidate.to.domainId,
        position: candidate.to.position,
        nodeId: candidate.to.nodeId,
        legs: localLeg ? [...current.legs, localLeg, pLeg] : [...current.legs, pLeg]
      });
    }
  }

  if (!bestGoal) return null;

  return deepFreeze({
    entityId,
    target: cloneJson(target),
    resolvedTarget,
    graphRevision: registry.graphRevision,
    estimatedSeconds: bestGoal.cost,
    legs: Object.freeze(bestGoal.legs),
    expansionCount: expansions
  });
}

function travels(registry) {
  if (!registry.activeTravels) registry.activeTravels = new Map();
  return registry.activeTravels;
}

export function startTravel(registry, bridge, entityId, target, options = {}) {
  const plan = planTravel(registry, bridge, entityId, target, options);
  if (!plan) return null;
  stopTravel(registry, bridge, entityId, { emit: false });
  const state = {
    entityId,
    target: cloneJson(target),
    options: cloneJson(options),
    plan,
    legIndex: 0,
    legStarted: false,
    status: "active",
    replans: 0
  };
  travels(registry).set(entityId, state);
  registry.emitEvent("travel-start", {
    entityId,
    target: state.target,
    estimatedSeconds: plan.estimatedSeconds
  });
  advanceTravel(registry, bridge, state);
  return state;
}

export function stopTravel(registry, bridge, entityId, { emit = true } = {}) {
  const state = travels(registry).get(entityId);
  if (!state) return false;
  bridge.stopLocalJourney(entityId);
  travels(registry).delete(entityId);
  state.status = "cancelled";
  if (emit) registry.emitEvent("travel-cancelled", { entityId });
  return true;
}

function resolveCurrentPortal(registry, leg) {
  if (leg.placeId == null) {
    for (const portal of registry.resolvedPortals()) {
      if (portal.id === leg.portalId) return portal;
    }
    return null;
  }
  return registry.resolvePortal(leg.placeId, leg.portalId);
}

function replan(registry, bridge, state) {
  bridge.stopLocalJourney(state.entityId);
  const plan = planTravel(registry, bridge, state.entityId, state.target, state.options);
  state.replans += 1;
  state.legIndex = 0;
  state.legStarted = false;
  if (!plan) {
    state.status = "failed";
    travels(registry).delete(state.entityId);
    registry.emitEvent("travel-failed", {
      entityId: state.entityId,
      reason: "no-route-after-world-change",
      replans: state.replans
    });
    return false;
  }
  state.plan = plan;
  registry.emitEvent("travel-replan", {
    entityId: state.entityId,
    replans: state.replans,
    estimatedSeconds: plan.estimatedSeconds
  });
  return true;
}

function advanceTravel(registry, bridge, state) {
  const entity = bridge.getEntity(state.entityId);
  if (!entity) {
    state.status = "failed";
    travels(registry).delete(state.entityId);
    registry.emitEvent("travel-failed", { entityId: state.entityId, reason: "entity-missing" });
    return false;
  }

  while (state.legIndex < state.plan.legs.length) {
    const leg = state.plan.legs[state.legIndex];

    if (leg.type === "journey") {
      if (entity.domainId !== leg.domainId) {
        if (!replan(registry, bridge, state)) return false;
        continue;
      }
      if (!state.legStarted) {
        const started = bridge.startLocalJourney(state.entityId, leg.destinationNodeId);
        if (!started) {
          if (!replan(registry, bridge, state)) return false;
          continue;
        }
        state.legStarted = true;
        registry.emitEvent("travel-leg-start", {
          entityId: state.entityId,
          legIndex: state.legIndex,
          type: "journey",
          domainId: leg.domainId,
          destinationNodeId: leg.destinationNodeId
        });
        return true;
      }
      if (entity.journey) return true;
      state.legStarted = false;
      state.legIndex += 1;
      continue;
    }

    if (leg.type === "portal") {
      const portal = resolveCurrentPortal(registry, leg);
      if (!portal || !isPortalTraversable(portal)) {
        if (!replan(registry, bridge, state)) return false;
        continue;
      }
      if (entity.domainId !== leg.from.domainId) {
        if (!replan(registry, bridge, state)) return false;
        continue;
      }
      bridge.transferEntity(state.entityId, leg.to);
      registry.updateEntityOccupancy(entity);
      registry.emitEvent("portal-traverse", {
        entityId: state.entityId,
        placeId: leg.placeId,
        portalId: leg.portalId,
        fromDomainId: leg.from.domainId,
        toDomainId: leg.to.domainId
      });
      state.legIndex += 1;
      state.legStarted = false;
      continue;
    }

    throw new Error(`unknown travel leg type ${leg.type}`);
  }

  state.status = "complete";
  travels(registry).delete(state.entityId);
  registry.updateEntityOccupancy(entity);
  registry.emitEvent("travel-complete", {
    entityId: state.entityId,
    replans: state.replans
  });
  return true;
}

export function stepTravel(registry, bridge, entityId) {
  const state = travels(registry).get(entityId);
  if (!state) return false;
  if (state.plan.graphRevision !== registry.graphRevision) {
    if (!replan(registry, bridge, state)) return false;
  }
  return advanceTravel(registry, bridge, state);
}

export function stepPlaceSimulation(registry, bridge, deltaSeconds) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError("deltaSeconds must be >= 0");
  registry.time += deltaSeconds;
  const ids = [...travels(registry).keys()];
  for (const entityId of ids) stepTravel(registry, bridge, entityId);
  return travels(registry).size;
}
