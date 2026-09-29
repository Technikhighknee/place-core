import { squaredDistance } from "./geometry.js";
import { isPortalTraversable } from "./registry.js";
import { cloneJson, deepFreeze } from "./utils.js";

const EMPTY_SET = new Set();
const POSITION_EPSILON_SQ = 1e-8;

function sortedPortals(registry, domainId) {
  return registry.getPortalsForDomain(domainId).sort((a, b) => a.key.localeCompare(b.key));
}

function outgoingEdges(registry, domainId, excluded = EMPTY_SET) {
  const edges = [];
  for (const portal of sortedPortals(registry, domainId)) {
    if (excluded.has(portal.key) || !isPortalTraversable(portal) || portal.a.domainId === portal.b.domainId) continue;
    if (portal.a.domainId === domainId) edges.push({ portalKey: portal.key, portal, from: portal.a, to: portal.b });
    if (portal.bidirectional && portal.b.domainId === domainId) edges.push({ portalKey: portal.key, portal, from: portal.b, to: portal.a });
  }
  return edges;
}

function incomingEdges(registry, domainId, excluded = EMPTY_SET) {
  const edges = [];
  for (const portal of sortedPortals(registry, domainId)) {
    if (excluded.has(portal.key) || !isPortalTraversable(portal) || portal.a.domainId === portal.b.domainId) continue;
    if (portal.b.domainId === domainId) edges.push({ portalKey: portal.key, portal, from: portal.a, to: portal.b });
    if (portal.bidirectional && portal.a.domainId === domainId) edges.push({ portalKey: portal.key, portal, from: portal.b, to: portal.a });
  }
  return edges;
}

export function findDomainPortalPath(registry, startDomainId, targetDomainId, options = {}) {
  if (startDomainId === targetDomainId) return [];
  const excluded = options.excludedPortalKeys ?? EMPTY_SET;
  const forwardVisited = new Map([[startDomainId, null]]);
  const backwardVisited = new Map([[targetDomainId, null]]);
  let forwardFrontier = new Set([startDomainId]);
  let backwardFrontier = new Set([targetDomainId]);
  let preferForwardOnTie = true;
  let meeting = null;

  while (forwardFrontier.size && backwardFrontier.size) {
    const expandForward = forwardFrontier.size < backwardFrontier.size ||
      (forwardFrontier.size === backwardFrontier.size && preferForwardOnTie);
    preferForwardOnTie = !preferForwardOnTie;

    if (expandForward) {
      const next = new Set();
      for (const domainId of [...forwardFrontier].sort()) {
        for (const edge of outgoingEdges(registry, domainId, excluded)) {
          const neighbor = edge.to.domainId;
          if (forwardVisited.has(neighbor)) continue;
          forwardVisited.set(neighbor, { previousDomain: domainId, edge });
          if (backwardVisited.has(neighbor)) { meeting = neighbor; break; }
          next.add(neighbor);
        }
        if (meeting) break;
      }
      if (meeting) break;
      forwardFrontier = next;
    } else {
      const next = new Set();
      for (const domainId of [...backwardFrontier].sort()) {
        for (const edge of incomingEdges(registry, domainId, excluded)) {
          const predecessor = edge.from.domainId;
          if (backwardVisited.has(predecessor)) continue;
          backwardVisited.set(predecessor, { nextDomain: domainId, edge });
          if (forwardVisited.has(predecessor)) { meeting = predecessor; break; }
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
    const entry = forwardVisited.get(cursor);
    if (!entry) throw new Error("corrupt forward portal search state");
    prefix.push(entry.edge);
    cursor = entry.previousDomain;
  }
  prefix.reverse();

  const suffix = [];
  cursor = meeting;
  while (cursor !== targetDomainId) {
    const entry = backwardVisited.get(cursor);
    if (!entry) throw new Error("corrupt backward portal search state");
    suffix.push(entry.edge);
    cursor = entry.nextDomain;
  }
  return [...prefix, ...suffix];
}

export function resolveTravelTarget(registry, target) {
  if (!target || typeof target !== "object") throw new TypeError("travel target is required");
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
    if (!anchor) anchor = definition.getAnchorsForSpace(space.id)[0] ?? null;
  } else if (definition.defaultAnchorId) {
    anchor = definition.getAnchor(definition.defaultAnchorId);
  } else {
    anchor = definition.getAnchorsByTag("entry")[0] ?? definition.anchors[0] ?? null;
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

function localStep(steps, bridge, state, destination, options) {
  if (state.domainId !== destination.domainId) throw new Error("local step cannot cross domains");
  if (squaredDistance(state.position, destination.position) <= POSITION_EPSILON_SQ) {
    state.position = destination.position;
    return 0;
  }
  if (destination.nodeId == null) {
    const error = new Error(`destination in ${destination.domainId} has no nodeId`);
    error.code = "LOCAL_ROUTE_UNAVAILABLE";
    throw error;
  }
  const routePlan = bridge.planLocalRoute({
    domainId: state.domainId,
    position: state.position,
    destinationNodeId: destination.nodeId,
    mobility: state.mobility,
    options: options.journeyOptions
  });
  if (!routePlan) {
    const error = new Error(`no local route in ${state.domainId} to ${destination.nodeId}`);
    error.code = "LOCAL_ROUTE_UNAVAILABLE";
    throw error;
  }
  const estimatedSeconds = routePlan.estimatedSeconds ?? routePlan.route?.estimatedSeconds ?? 0;
  steps.push(deepFreeze({
    type: "local-journey",
    domainId: state.domainId,
    destinationNodeId: destination.nodeId,
    destinationPosition: destination.position,
    estimatedSeconds
  }));
  state.position = destination.position;
  return estimatedSeconds;
}

export function planTravel(registry, entityOrId, target, options = {}) {
  const bridge = options.bridge ?? registry.bridge;
  if (!bridge) throw new Error("planTravel requires a WorldCoreBridge");
  const entity = typeof entityOrId === "object" ? entityOrId : bridge.getEntity(entityOrId);
  if (!entity) throw new Error(`unknown entity ${String(entityOrId)}`);

  const startDomainId = entity.domainId ?? "default";
  const resolvedTarget = resolveTravelTarget(registry, target);
  const excluded = new Set(options.excludedPortalKeys ?? []);
  const maxAttempts = options.maxPortalPathAttempts ?? 32;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const portalPath = findDomainPortalPath(registry, startDomainId, resolvedTarget.domainId, { excludedPortalKeys: excluded });
    if (portalPath == null) return null;
    const steps = [];
    const state = { domainId: startDomainId, position: entity.position, mobility: entity.mobility };
    let estimatedSeconds = 0;
    let failedPortalKey = null;

    try {
      for (const edge of portalPath) {
        try {
          estimatedSeconds += localStep(steps, bridge, state, edge.from, options);
        } catch (error) {
          if (error.code !== "LOCAL_ROUTE_UNAVAILABLE") throw error;
          failedPortalKey = edge.portalKey;
          throw error;
        }

        steps.push(deepFreeze({
          type: "traverse-portal",
          portalKey: edge.portalKey,
          placeId: edge.portal.instanceId,
          portalId: edge.portal.id,
          fromDomainId: edge.from.domainId,
          toDomainId: edge.to.domainId,
          destinationPosition: edge.to.position,
          transitionCost: edge.portal.transitionCost
        }));
        estimatedSeconds += edge.portal.transitionCost;
        state.domainId = edge.to.domainId;
        state.position = edge.to.position;
      }

      try {
        estimatedSeconds += localStep(steps, bridge, state, resolvedTarget, options);
      } catch (error) {
        if (error.code !== "LOCAL_ROUTE_UNAVAILABLE") throw error;
        failedPortalKey = portalPath.at(-1)?.portalKey ?? null;
        throw error;
      }

      return deepFreeze({
        entityId: entity.id,
        target: cloneJson(target),
        resolvedTarget,
        graphRevision: registry.graphRevision,
        startDomainId,
        steps,
        estimatedSeconds,
        rejectedPortalKeys: Object.freeze([...excluded])
      });
    } catch (error) {
      if (error.code !== "LOCAL_ROUTE_UNAVAILABLE") throw error;
      if (!failedPortalKey || excluded.has(failedPortalKey)) return null;
      excluded.add(failedPortalKey);
    }
  }
  return null;
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
  registry.emit("travel-complete", { entityId: state.entityId, target: state.target });
  return state;
}

function replan(registry, bridge, state, options) {
  bridge.stopLocalJourney(state.entityId);
  const plan = planTravel(registry, state.entityId, state.target, { ...options, bridge });
  if (!plan) return fail(registry, bridge, state, "no-path-after-replan");
  state.plan = plan;
  state.stepIndex = 0;
  state.localStarted = false;
  state.graphRevision = registry.graphRevision;
  registry.emit("travel-replanned", { entityId: state.entityId, target: state.target, graphRevision: state.graphRevision });
  return state;
}

function advance(registry, bridge, state, options) {
  while (state.status === "active") {
    if (state.stepIndex >= state.plan.steps.length) return complete(registry, state);
    const step = state.plan.steps[state.stepIndex];

    if (step.type === "local-journey") {
      if (!state.localStarted) {
        const ok = bridge.startLocalJourney(state.entityId, step.destinationNodeId, options.journeyOptions);
        if (!ok) {
          if (options.replanOnFailure !== false) {
            const next = replan(registry, bridge, state, options);
            if (next.status !== "active") return next;
            continue;
          }
          return fail(registry, bridge, state, "local-route-start-failed");
        }
        state.localStarted = true;
      }
      return state;
    }

    if (step.type === "traverse-portal") {
      const portal = registry.getPortalRecord(step.portalKey);
      if (!portal || !isPortalTraversable(portal)) {
        if (options.replanOnFailure !== false) {
          const next = replan(registry, bridge, state, options);
          if (next.status !== "active") return next;
          continue;
        }
        return fail(registry, bridge, state, "portal-unavailable");
      }

      const entity = bridge.getEntity(state.entityId);
      if (!entity || (entity.domainId ?? "default") !== step.fromDomainId) {
        return fail(registry, bridge, state, "portal-domain-mismatch");
      }
      const destination = portal.a.domainId === step.toDomainId ? portal.a : portal.b;
      registry.emit("portal-enter", { entityId: state.entityId, placeId: portal.instanceId, portalId: portal.id });
      bridge.transferEntity(state.entityId, destination);
      const moved = bridge.getEntity(state.entityId);
      if (moved) registry.syncEntityOccupancy(moved);
      registry.emit("portal-traverse", { entityId: state.entityId, placeId: portal.instanceId, portalId: portal.id, toDomainId: destination.domainId });
      registry.emit("portal-exit", { entityId: state.entityId, placeId: portal.instanceId, portalId: portal.id });
      state.stepIndex += 1;
      state.localStarted = false;
      continue;
    }

    return fail(registry, bridge, state, `unknown-step:${step.type}`);
  }
  return state;
}

export function startTravel(registry, entityId, target, options = {}) {
  const bridge = options.bridge ?? registry.bridge;
  if (!bridge) throw new Error("startTravel requires a WorldCoreBridge");
  if (registry.activeTravels.has(entityId)) stopTravel(registry, entityId, { bridge, reason: "replaced" });
  const plan = planTravel(registry, entityId, target, { ...options, bridge });
  if (!plan) return null;
  const state = {
    entityId,
    target: cloneJson(target),
    plan,
    stepIndex: 0,
    localStarted: false,
    graphRevision: registry.graphRevision,
    status: "active",
    failureReason: null
  };
  registry.activeTravels.set(entityId, state);
  registry.emit("travel-start", { entityId, target: state.target, estimatedSeconds: plan.estimatedSeconds });
  return advance(registry, bridge, state, options);
}

export function stepTravel(registry, entityId, options = {}) {
  const bridge = options.bridge ?? registry.bridge;
  if (!bridge) throw new Error("stepTravel requires a WorldCoreBridge");
  const state = registry.activeTravels.get(entityId);
  if (!state) return null;

  if (state.graphRevision !== registry.graphRevision) {
    const next = replan(registry, bridge, state, options);
    if (next.status !== "active") return next;
  }

  const step = state.plan.steps[state.stepIndex];
  if (step?.type === "local-journey" && state.localStarted) {
    const entity = bridge.getEntity(entityId);
    if (!entity) return fail(registry, bridge, state, "entity-missing");
    if (entity.journey != null) {
      registry.syncEntityOccupancy(entity);
      return state;
    }
    if (entity.lastJourneyFailure?.destinationNodeId === step.destinationNodeId) {
      if (options.replanOnFailure !== false) {
        const next = replan(registry, bridge, state, options);
        if (next.status !== "active") return next;
      } else {
        return fail(registry, bridge, state, "local-journey-failed");
      }
    } else {
      state.stepIndex += 1;
      state.localStarted = false;
      registry.syncEntityOccupancy(entity);
    }
  }
  return advance(registry, bridge, state, options);
}

export function stepPlaceSimulation(registry, options = {}) {
  const ids = [...registry.activeTravels.keys()];
  for (const entityId of ids) stepTravel(registry, entityId, options);
  return registry.activeTravels.size;
}

export function stopTravel(registry, entityId, options = {}) {
  const bridge = options.bridge ?? registry.bridge;
  const state = registry.activeTravels.get(entityId);
  if (!state) return false;
  bridge?.stopLocalJourney?.(entityId);
  registry.activeTravels.delete(entityId);
  state.status = "cancelled";
  registry.emit("travel-cancelled", { entityId, reason: options.reason ?? "cancelled" });
  return true;
}
