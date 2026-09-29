import { PlaceRegistry } from "./place-registry.js";
import { compilePlace } from "./definition.js";
import {
  assertId,
  assertStringId,
  canonicalStringify,
  cloneJson,
  normalizeBoolean,
  normalizeStringList,
  sha256
} from "./utils.js";
import { startTravel } from "./travel.js";

export const PLACE_CORE_SNAPSHOT_VERSION = 1;

function canonicalClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(canonicalStringify(value));
}

function mapToObject(map) {
  return canonicalClone(Object.fromEntries(map.entries()));
}

function serializePlan(plan) {
  if (!plan) return null;
  const copy = canonicalClone(plan);
  delete copy.travelRevision;
  delete copy.graphRevision;
  return copy;
}

function serializeTravelOptions(options = {}) {
  if (typeof options.anchorPredicate === "function") {
    throw new Error(
      "cannot serialize active travel with anchorPredicate; use declarative target filters or stop the travel before snapshotting"
    );
  }
  return canonicalClone(options);
}

function serializeTravelState(state) {
  return {
    entityId: state.entityId,
    target: canonicalClone(state.target),
    plan: serializePlan(state.plan),
    options: serializeTravelOptions(state.options ?? {
      worldChangePolicy: state.worldChangePolicy ?? "encounter",
      portalEntryTolerance: 0.25
    }),
    stepIndex: state.stepIndex,
    localStarted: state.localStarted === true,
    portalEntered: state.portalEntered === true,
    portalTransitionRemaining: state.portalTransitionRemaining ?? 0,
    worldChangePolicy: state.worldChangePolicy ?? "encounter",
    status: state.status,
    failureReason: state.failureReason ?? null,
    replans: state.replans ?? 0
  };
}

export function serializePlaceCore(registry) {
  if (!(registry instanceof PlaceRegistry)) throw new TypeError("serializePlaceCore requires PlaceRegistry");

  return {
    format: "place-core",
    version: PLACE_CORE_SNAPSHOT_VERSION,
    definitions: [...registry.definitions.values()]
      .map((definition) => ({
        id: definition.id,
        revision: definition.revision,
        contentHash: definition.contentHash,
        blueprint: canonicalClone(definition.getBlueprint())
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    instances: [...registry.instances.values()]
      .map((instance) => ({
        id: instance.id,
        definitionId: instance.definitionId,
        parentId: instance.parentId,
        layerDomains: mapToObject(instance.layerDomains),
        attachments: mapToObject(instance.attachments),
        placement: canonicalClone(instance.placement),
        metadata: canonicalClone(instance.metadata),
        portalOverrides: mapToObject(instance.portalOverrides),
        boundaryOverrides: mapToObject(instance.boundaryOverrides),
        spaceOverrides: mapToObject(instance.spaceOverrides),
        dynamicPortals: [...instance.dynamicPortals.values()]
          .map(canonicalClone)
          .sort((a, b) => a.id.localeCompare(b.id))
      }))
      .sort((a, b) => idKey(a.id).localeCompare(idKey(b.id))),
    activeTravels: [...registry.activeTravels.values()]
      .filter((state) => state.status === "active")
      .map(serializeTravelState)
      .sort((a, b) => idKey(a.entityId).localeCompare(idKey(b.entityId))),
    pendingTravels: registry.pendingTravels.map(canonicalClone)
  };
}

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
}

function assertFiniteVec2(value, label) {
  assertObject(value, label);
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new TypeError(`${label} must contain finite x/y`);
  }
}

function assertNullableString(value, label) {
  if (value == null) return;
  assertStringId(value, label);
}

function assertJsonSafe(value, label) {
  try {
    cloneJson(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-safe`, { cause: error });
  }
}

function assertBooleanPatch(patch, allowedKeys, label) {
  assertObject(patch, label);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown field ${key}`);
    }
    normalizeBoolean(patch[key], `${label}.${key}`);
  }
}

function assertPositiveIntegerOption(value, label) {
  if (value == null) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function assertTravelTarget(target, label = "travel target") {
  assertObject(target, label);

  if (target.kind === "nearest") {
    assertStringId(target.tag, `${label}.tag`);
    assertNullableString(target.anchorKind, `${label}.anchorKind`);
    assertNullableString(target.spaceId, `${label}.spaceId`);
    if (target.placeId != null) assertId(target.placeId, `${label}.placeId`);
    return;
  }

  if (target.domainId != null) {
    assertStringId(target.domainId, `${label}.domainId`);
    assertFiniteVec2(target.position, `${label}.position`);
    assertNullableString(target.nodeId, `${label}.nodeId`);
    if (target.placeId != null) assertId(target.placeId, `${label}.placeId`);
    assertNullableString(target.anchorId, `${label}.anchorId`);
    assertNullableString(target.spaceId, `${label}.spaceId`);
    assertNullableString(target.layerId, `${label}.layerId`);
    return;
  }

  assertId(target.placeId, `${label}.placeId`);
  assertNullableString(target.anchorId, `${label}.anchorId`);
  assertNullableString(target.spaceId, `${label}.spaceId`);
}

function assertTravelOptions(options, label) {
  assertObject(options, label);

  const policy = options.worldChangePolicy;
  if (policy != null && policy !== "encounter" && policy !== "eager") {
    throw new Error(`invalid ${label}.worldChangePolicy`);
  }

  if (options.portalEntryTolerance != null &&
      (!Number.isFinite(options.portalEntryTolerance) ||
       options.portalEntryTolerance < 0)) {
    throw new Error(`invalid ${label}.portalEntryTolerance`);
  }

  for (const key of [
    "maxDomainPathAttempts",
    "maxShortestDomainPaths",
    "maxConcreteStatesPerLayer",
    "maxNearestTargetExpansions"
  ]) {
    assertPositiveIntegerOption(options[key], `${label}.${key}`);
  }

  if (options.allowPartialShortestPathSearch != null) {
    normalizeBoolean(
      options.allowPartialShortestPathSearch,
      `${label}.allowPartialShortestPathSearch`
    );
  }

  if (options.maxCost != null &&
      (!Number.isFinite(options.maxCost) || options.maxCost < 0)) {
    throw new Error(`invalid ${label}.maxCost`);
  }

  for (const key of ["excludedPortalKeys", "excludedDomainPairs"]) {
    if (options[key] == null) continue;
    assertArray(options[key], `${label}.${key}`);
    normalizeStringList(options[key], `${label}.${key}`);
  }

  if (options.journeyOptions !== undefined) {
    assertJsonSafe(options.journeyOptions, `${label}.journeyOptions`);
  }

  if (options.anchorPredicate !== undefined) {
    throw new Error(`${label}.anchorPredicate cannot be persisted`);
  }
}

function assertTravelPlan(plan, entityId) {
  assertObject(plan, "active travel plan");
  if (plan.entityId !== entityId) {
    throw new Error("active travel plan entityId mismatch");
  }
  assertTravelTarget(plan.target, "active travel plan.target");
  assertObject(plan.resolvedTarget, "active travel plan.resolvedTarget");
  assertStringId(
    plan.resolvedTarget.domainId,
    "active travel plan.resolvedTarget.domainId"
  );
  assertFiniteVec2(
    plan.resolvedTarget.position,
    "active travel plan.resolvedTarget.position"
  );
  assertNullableString(
    plan.resolvedTarget.nodeId,
    "active travel plan.resolvedTarget.nodeId"
  );

  assertStringId(plan.startDomainId, "active travel plan.startDomainId");
  assertArray(plan.domainPath, "active travel plan.domainPath");
  normalizeStringList(
    plan.domainPath,
    "active travel plan.domainPath"
  );
  assertArray(plan.steps, "active travel plan.steps");

  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i];
    assertObject(step, `active travel plan.steps[${i}]`);

    if (step.type === "local-journey") {
      assertStringId(
        step.domainId,
        `active travel plan.steps[${i}].domainId`
      );
      assertStringId(
        step.destinationNodeId,
        `active travel plan.steps[${i}].destinationNodeId`
      );
      assertFiniteVec2(
        step.destinationPosition,
        `active travel plan.steps[${i}].destinationPosition`
      );
      if (!Number.isFinite(step.estimatedSeconds) || step.estimatedSeconds < 0) {
        throw new Error(
          `invalid active travel plan.steps[${i}].estimatedSeconds`
        );
      }
      continue;
    }

    if (step.type === "traverse-portal") {
      assertStringId(
        step.portalKey,
        `active travel plan.steps[${i}].portalKey`
      );
      assertId(
        step.placeId,
        `active travel plan.steps[${i}].placeId`
      );
      assertStringId(
        step.portalId,
        `active travel plan.steps[${i}].portalId`
      );
      assertStringId(
        step.fromDomainId,
        `active travel plan.steps[${i}].fromDomainId`
      );
      assertStringId(
        step.toDomainId,
        `active travel plan.steps[${i}].toDomainId`
      );
      assertFiniteVec2(
        step.destinationPosition,
        `active travel plan.steps[${i}].destinationPosition`
      );
      if (!Number.isFinite(step.transitionCost) || step.transitionCost < 0) {
        throw new Error(
          `invalid active travel plan.steps[${i}].transitionCost`
        );
      }
      continue;
    }

    throw new Error(
      `unknown active travel plan step type: ${String(step.type)}`
    );
  }

  if (!Number.isFinite(plan.estimatedSeconds) || plan.estimatedSeconds < 0) {
    throw new Error("invalid active travel plan estimatedSeconds");
  }

  assertArray(
    plan.rejectedDomainPairs ?? [],
    "active travel plan.rejectedDomainPairs"
  );
  normalizeStringList(
    plan.rejectedDomainPairs ?? [],
    "active travel plan.rejectedDomainPairs"
  );
}

function assertAttachment(value, label) {
  assertObject(value, label);
  assertStringId(value.domainId, `${label}.domainId`);
  assertFiniteVec2(value.position, `${label}.position`);
  assertNullableString(value.nodeId, `${label}.nodeId`);
  if (value.placeId != null) assertId(value.placeId, `${label}.placeId`);
  assertNullableString(value.spaceId, `${label}.spaceId`);
  if (value.metadata !== undefined) {
    assertJsonSafe(value.metadata, `${label}.metadata`);
  }
}

function assertDynamicPortal(portal, definition, item, dynamicIds) {
  assertObject(portal, "dynamic portal");
  assertStringId(portal.id, "dynamic portal.id");

  if (dynamicIds.has(portal.id) || definition.getPortal(portal.id)) {
    throw new Error(
      `duplicate dynamic portal ${portal.id} on instance ${String(item.id)}`
    );
  }
  dynamicIds.add(portal.id);

  assertStringId(portal.kind ?? "portal", `dynamic portal ${portal.id}.kind`);
  normalizeStringList(
    portal.tags,
    `dynamic portal ${portal.id}.tags`,
    { defaultValue: [] }
  );

  const transitionCost = portal.transitionCost ?? 0;
  if (!Number.isFinite(transitionCost) || transitionCost < 0) {
    throw new RangeError(
      `dynamic portal ${portal.id} transitionCost must be a finite number >= 0`
    );
  }

  for (const key of [
    "bidirectional",
    "enabled",
    "open",
    "locked",
    "blocked",
    "destroyed",
    "blocksWhenClosed"
  ]) {
    if (portal[key] !== undefined) {
      normalizeBoolean(
        portal[key],
        `dynamic portal ${portal.id}.${key}`
      );
    }
  }

  for (const [side, endpoint] of [["a", portal.a], ["b", portal.b]]) {
    assertObject(endpoint, `dynamic portal ${portal.id}.${side}`);
    assertStringId(
      endpoint.domainId,
      `dynamic portal ${portal.id}.${side}.domainId`
    );
    assertFiniteVec2(
      endpoint.position,
      `dynamic portal ${portal.id}.${side}.position`
    );
    assertNullableString(
      endpoint.nodeId,
      `dynamic portal ${portal.id}.${side}.nodeId`
    );
    if (endpoint.placeId != null) {
      assertId(
        endpoint.placeId,
        `dynamic portal ${portal.id}.${side}.placeId`
      );
    }
    assertNullableString(
      endpoint.spaceId,
      `dynamic portal ${portal.id}.${side}.spaceId`
    );
    assertNullableString(
      endpoint.layerId,
      `dynamic portal ${portal.id}.${side}.layerId`
    );
    if (endpoint.metadata !== undefined) {
      assertJsonSafe(
        endpoint.metadata,
        `dynamic portal ${portal.id}.${side}.metadata`
      );
    }
  }

  assertArray(
    portal.roadBindings ?? [],
    `dynamic portal ${portal.id}.roadBindings`
  );
  const layerDomains = item.layerDomains;
  for (let i = 0; i < (portal.roadBindings ?? []).length; i += 1) {
    const binding = portal.roadBindings[i];
    assertObject(
      binding,
      `dynamic portal ${portal.id}.roadBindings[${i}]`
    );
    assertStringId(
      binding.layerId,
      `dynamic portal ${portal.id}.roadBindings[${i}].layerId`
    );
    assertStringId(
      binding.roadId,
      `dynamic portal ${portal.id}.roadBindings[${i}].roadId`
    );
    const layer = definition.getLayer(binding.layerId);
    if (!layer) {
      throw new Error(
        `dynamic portal ${portal.id} road binding references unknown layer ${binding.layerId}`
      );
    }
    if (layer.navigation &&
        !layer.navigation.roads.some((road) => road.id === binding.roadId)) {
      throw new Error(
        `dynamic portal ${portal.id} references unknown navigation road ${binding.roadId}`
      );
    }
  }

  if (portal.metadata !== undefined) {
    assertJsonSafe(portal.metadata, `dynamic portal ${portal.id}.metadata`);
  }

  const a = portal.a;
  const b = portal.b;
  const traversable =
    (portal.enabled ?? true) &&
    !(portal.locked ?? false) &&
    !(portal.blocked ?? false) &&
    !(portal.destroyed ?? false) &&
    (!(portal.blocksWhenClosed ?? false) || (portal.open ?? true));
  const needsPhysicalEnforcement =
    a.domainId === b.domainId &&
    (transitionCost > 0 || !traversable);

  if (needsPhysicalEnforcement) {
    const hasBinding = (portal.roadBindings ?? []).some(
      (binding) => layerDomains[binding.layerId] === a.domainId
    );
    if (!hasBinding) {
      throw new Error(
        `dynamic portal ${portal.id} requires a road binding in domain ${a.domainId} for same-domain physical enforcement`
      );
    }
  }
}

export function validatePlaceCoreSnapshot(snapshot, options = {}) {
  assertObject(snapshot, "place-core snapshot");
  if (snapshot.format !== "place-core") throw new Error(`invalid place-core snapshot format: ${snapshot.format}`);
  if (snapshot.version !== (options.expectedVersion ?? PLACE_CORE_SNAPSHOT_VERSION)) {
    throw new Error(`unsupported place-core snapshot version: ${snapshot.version}`);
  }

  assertArray(snapshot.definitions, "snapshot.definitions");
  assertArray(snapshot.instances, "snapshot.instances");
  assertArray(snapshot.activeTravels ?? [], "snapshot.activeTravels");
  assertArray(snapshot.pendingTravels ?? [], "snapshot.pendingTravels");

  const definitions = new Map();
  for (let i = 0; i < snapshot.definitions.length; i += 1) {
    const ref = snapshot.definitions[i];
    assertObject(ref, `snapshot.definitions[${i}]`);
    if (typeof ref.id !== "string" || !ref.id) throw new TypeError("definition id must be a non-empty string");
    if (definitions.has(ref.id)) throw new Error(`duplicate definition reference: ${ref.id}`);
    if (typeof ref.contentHash !== "string" || !ref.contentHash) throw new TypeError(`definition ${ref.id} missing contentHash`);
    assertObject(ref.blueprint, `definition ${ref.id}.blueprint`);

    const compiled = compilePlace(ref.blueprint);
    if (compiled.id !== ref.id) throw new Error(`definition id mismatch for ${ref.id}`);
    if (compiled.contentHash !== ref.contentHash) throw new Error(`definition hash mismatch for ${ref.id}`);
    definitions.set(ref.id, compiled);
  }

  const instances = new Map();
  const domains = new Set();
  for (let i = 0; i < snapshot.instances.length; i += 1) {
    const item = snapshot.instances[i];
    assertObject(item, `snapshot.instances[${i}]`);
    const key = idKey(item.id);
    if (instances.has(key)) throw new Error(`duplicate place instance: ${String(item.id)}`);
    const definition = definitions.get(item.definitionId);
    if (!definition) throw new Error(`instance ${String(item.id)} references unknown definition ${item.definitionId}`);

    assertObject(item.layerDomains, `instance ${String(item.id)}.layerDomains`);
    assertObject(item.attachments, `instance ${String(item.id)}.attachments`);
    assertObject(item.portalOverrides ?? {}, `instance ${String(item.id)}.portalOverrides`);
    assertObject(item.boundaryOverrides ?? {}, `instance ${String(item.id)}.boundaryOverrides`);
    assertObject(item.spaceOverrides ?? {}, `instance ${String(item.id)}.spaceOverrides`);
    assertArray(item.dynamicPortals ?? [], `instance ${String(item.id)}.dynamicPortals`);

    for (const layer of definition.layers) {
      const domainId = item.layerDomains[layer.id];
      if (typeof domainId !== "string" || !domainId) {
        throw new Error(`instance ${String(item.id)} missing domain for layer ${layer.id}`);
      }
      if (domains.has(domainId)) throw new Error(`duplicate bound domain: ${domainId}`);
      domains.add(domainId);
    }

    for (const portalId of Object.keys(item.portalOverrides ?? {})) {
      if (!definition.getPortal(portalId)) throw new Error(`instance ${String(item.id)} has orphan portal override ${portalId}`);
    }
    for (const boundaryId of Object.keys(item.boundaryOverrides ?? {})) {
      if (!definition.getBoundary(boundaryId)) throw new Error(`instance ${String(item.id)} has orphan boundary override ${boundaryId}`);
    }
    for (const spaceId of Object.keys(item.spaceOverrides ?? {})) {
      if (!definition.getSpace(spaceId)) throw new Error(`instance ${String(item.id)} has orphan space override ${spaceId}`);
    }

    const dynamicIds = new Set();
    for (const portal of item.dynamicPortals ?? []) {
      assertObject(portal, "dynamic portal");
      if (typeof portal.id !== "string" || !portal.id) throw new TypeError("dynamic portal id must be non-empty");
      if (dynamicIds.has(portal.id) || definition.getPortal(portal.id)) {
        throw new Error(`duplicate dynamic portal ${portal.id} on instance ${String(item.id)}`);
      }
      dynamicIds.add(portal.id);
      for (const endpoint of [portal.a, portal.b]) {
        if (!endpoint || typeof endpoint.domainId !== "string" || !endpoint.position ||
            !Number.isFinite(endpoint.position.x) || !Number.isFinite(endpoint.position.y)) {
          throw new TypeError(`dynamic portal ${portal.id} has invalid endpoint`);
        }
      }
    }

    instances.set(key, item);
  }

  for (const item of snapshot.instances) {
    if (item.parentId != null && !instances.has(idKey(item.parentId))) {
      throw new Error(`instance ${String(item.id)} references missing parent ${String(item.parentId)}`);
    }

    if (item.placement != null) {
      assertObject(item.placement, `instance ${String(item.id)}.placement`);
      const hasDomain = item.placement.domainId != null;
      const hasParent = item.placement.parentPlaceId != null;
      if (hasDomain === hasParent) {
        throw new Error(`instance ${String(item.id)} placement must reference exactly one frame`);
      }
      if (hasDomain && (typeof item.placement.domainId !== "string" || !item.placement.domainId)) {
        throw new Error(`instance ${String(item.id)} placement has invalid domainId`);
      }
      if (hasParent && !instances.has(idKey(item.placement.parentPlaceId))) {
        throw new Error(`instance ${String(item.id)} references missing placement parent ${String(item.placement.parentPlaceId)}`);
      }
    }
  }

  for (const item of snapshot.instances) {
    const semanticVisited = new Set();
    let cursor = item;
    while (cursor?.parentId != null) {
      const key = idKey(cursor.id);
      if (semanticVisited.has(key)) throw new Error(`place parent cycle involving ${String(cursor.id)}`);
      semanticVisited.add(key);
      cursor = instances.get(idKey(cursor.parentId));
    }

    const placementVisited = new Set();
    cursor = item;
    while (cursor?.placement?.parentPlaceId != null) {
      const key = idKey(cursor.id);
      if (placementVisited.has(key)) throw new Error(`place placement cycle involving ${String(cursor.id)}`);
      placementVisited.add(key);
      cursor = instances.get(idKey(cursor.placement.parentPlaceId));
    }
  }

  const travelEntities = new Set();
  for (const travel of snapshot.activeTravels ?? []) {
    assertObject(travel, "active travel");
    const key = idKey(travel.entityId);
    if (travelEntities.has(key)) throw new Error(`duplicate active travel for ${String(travel.entityId)}`);
    travelEntities.add(key);
    if (travel.status !== "active") throw new Error("only active travel states may be persisted in activeTravels");
    if (!Number.isInteger(travel.stepIndex) || travel.stepIndex < 0) throw new Error("invalid active travel stepIndex");
    if (!Number.isInteger(travel.replans) || travel.replans < 0) throw new Error("invalid active travel replans");
    if (travel.worldChangePolicy !== "encounter" && travel.worldChangePolicy !== "eager") {
      throw new Error("invalid active travel worldChangePolicy");
    }
    if (travel.options != null) {
      assertObject(travel.options, "active travel options");
      const policy = travel.options.worldChangePolicy ?? travel.worldChangePolicy;
      if (policy !== "encounter" && policy !== "eager") {
        throw new Error("invalid active travel options.worldChangePolicy");
      }
      if (travel.options.portalEntryTolerance != null &&
          (!Number.isFinite(travel.options.portalEntryTolerance) ||
           travel.options.portalEntryTolerance < 0)) {
        throw new Error("invalid active travel options.portalEntryTolerance");
      }
      if (travel.options.excludedPortalKeys != null) {
        assertArray(travel.options.excludedPortalKeys, "active travel options.excludedPortalKeys");
      }
      if (travel.options.excludedDomainPairs != null) {
        assertArray(travel.options.excludedDomainPairs, "active travel options.excludedDomainPairs");
      }
    }
    if (travel.plan != null) {
      assertObject(travel.plan, "active travel plan");
      assertArray(travel.plan.steps, "active travel plan.steps");
      if (travel.stepIndex > travel.plan.steps.length) throw new Error("active travel stepIndex exceeds plan");
    }
  }

  return true;
}

export function deserializePlaceCore(snapshot, options = {}) {
  validatePlaceCoreSnapshot(snapshot);

  const registry = new PlaceRegistry({
    bridge: options.bridge,
    captureEvents: options.captureEvents === true,
    eventQueueLimit: options.eventQueueLimit,
    eventOverflowPolicy: options.eventOverflowPolicy
  });

  for (const ref of snapshot.definitions) {
    const definition = compilePlace(ref.blueprint);
    if (definition.contentHash !== ref.contentHash) {
      throw new Error(`definition hash mismatch for ${ref.id}`);
    }
    registry.registerDefinition(definition);
  }

  const remaining = new Map(
    snapshot.instances.map((item) => [idKey(item.id), item])
  );

  while (remaining.size) {
    let progressed = false;
    for (const [key, item] of [...remaining.entries()]) {
      if (item.parentId != null && !registry.getPlace(item.parentId)) continue;
      if (item.placement?.parentPlaceId != null && !registry.getPlace(item.placement.parentPlaceId)) continue;

      registry.createPlace({
        id: item.id,
        definitionId: item.definitionId,
        parentId: item.parentId,
        layerDomains: item.layerDomains,
        attachments: item.attachments,
        placement: item.placement,
        metadata: item.metadata
      });

      for (const portal of item.dynamicPortals ?? []) {
        registry.addInstancePortal(item.id, portal);
      }
      for (const [portalId, patch] of Object.entries(item.portalOverrides ?? {})) {
        registry.setPortalState(item.id, portalId, patch);
      }
      for (const [boundaryId, patch] of Object.entries(item.boundaryOverrides ?? {})) {
        registry.setBoundaryState(item.id, boundaryId, patch);
      }
      for (const [spaceId, patch] of Object.entries(item.spaceOverrides ?? {})) {
        registry.setSpaceState(item.id, spaceId, patch);
      }

      remaining.delete(key);
      progressed = true;
    }
    if (!progressed) throw new Error("could not restore place hierarchy");
  }

  const active = snapshot.activeTravels ?? [];
  if (options.bridge && options.resumeWorldCoreState === true) {
    for (const saved of active) {
      const state = cloneJson(saved);
      state.worldChangePolicy ??= "encounter";
      state.options = Object.freeze({
        ...(state.options ?? {}),
        worldChangePolicy:
          state.options?.worldChangePolicy ??
          state.worldChangePolicy,
        portalEntryTolerance:
          state.options?.portalEntryTolerance ??
          0.25
      });
      state.worldChangePolicy = state.options.worldChangePolicy;
      if (state.plan) {
        state.plan.travelRevision = registry.travelRevision;
        state.plan.graphRevision = registry.travelRevision;
        Object.freeze(state.plan.steps);
        Object.freeze(state.plan);
      }
      state.travelRevision = registry.travelRevision;
      state.graphRevision = registry.travelRevision;
      registry.activeTravels.set(state.entityId, state);
    }
  } else if (options.bridge && options.restartTravels !== false) {
    for (const saved of active) {
      startTravel(
        registry,
        options.bridge,
        saved.entityId,
        saved.target,
        saved.options ?? {
          worldChangePolicy: saved.worldChangePolicy ?? "encounter",
          portalEntryTolerance: 0.25
        }
      );
    }
  } else {
    for (const saved of active) {
      registry.pendingTravels.push({
        entityId: saved.entityId,
        target: cloneJson(saved.target),
        savedState: cloneJson(saved)
      });
    }
  }

  for (const pending of snapshot.pendingTravels ?? []) {
    registry.pendingTravels.push(cloneJson(pending));
  }

  registry.drainEvents();
  registry.assertInternalConsistency();
  return registry;
}

function canonicalStateForHash(registry) {
  const snapshot = serializePlaceCore(registry);
  return {
    format: snapshot.format,
    version: snapshot.version,
    definitions: snapshot.definitions,
    instances: snapshot.instances,
    activeTravels: snapshot.activeTravels,
    pendingTravels: snapshot.pendingTravels
  };
}

export function computePlaceCoreStateHash(registry) {
  return sha256(canonicalStringify(canonicalStateForHash(registry)));
}
