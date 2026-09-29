import { PlaceRegistry } from "./registry.js";
import { compilePlace } from "./definition.js";
import { canonicalStringify, cloneJson, sha256 } from "./utils.js";

export const PLACE_CORE_SNAPSHOT_VERSION = 1;

function mapEntries(map) {
  return [...map.entries()].map(([key, value]) => [key, cloneJson(value)]);
}

function serializeInstance(instance) {
  return {
    id: instance.id,
    definitionId: instance.definitionId,
    definitionHash: instance.definitionHash,
    parentPlaceId: instance.parentPlaceId,
    placement: cloneJson(instance.placement),
    placementDomainId: instance.placementDomainId,
    layerDomains: [...instance.layerDomains.entries()],
    portalOverrides: mapEntries(instance.portalOverrides),
    boundaryOverrides: mapEntries(instance.boundaryOverrides),
    dynamicPortals: mapEntries(instance.dynamicPortals),
    externalBindings: mapEntries(instance.externalBindings),
    metadata: cloneJson(instance.metadata),
    revision: instance.revision
  };
}

function serializeTravel(state) {
  return {
    entityId: state.entityId,
    target: cloneJson(state.target),
    options: cloneJson(state.options),
    plan: cloneJson(state.plan),
    legIndex: state.legIndex,
    legStarted: state.legStarted,
    status: state.status,
    replans: state.replans
  };
}

export function serializePlaceCore(registry) {
  if (!(registry instanceof PlaceRegistry)) throw new TypeError("serializePlaceCore requires PlaceRegistry");
  return {
    format: "place-core",
    version: PLACE_CORE_SNAPSHOT_VERSION,
    time: registry.time,
    graphRevision: registry.graphRevision,
    definitions: [...registry.definitions.values()]
      .map((definition) => ({
        id: definition.id,
        contentHash: definition.contentHash,
        blueprint: definition.getBlueprint()
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    instances: [...registry.instances.values()]
      .map(serializeInstance)
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    activeTravels: [...(registry.activeTravels?.values?.() ?? [])]
      .map(serializeTravel)
      .sort((a, b) => String(a.entityId).localeCompare(String(b.entityId)))
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
}

function validateEntryPairs(value, label) {
  assertArray(value, label);
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const pair = value[i];
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError(`${label}[${i}] must be [key,value]`);
    const key = String(pair[0]);
    if (seen.has(key)) throw new Error(`duplicate key in ${label}: ${key}`);
    seen.add(key);
  }
}

export function validatePlaceCoreSnapshot(snapshot, {
  expectedVersion = PLACE_CORE_SNAPSHOT_VERSION
} = {}) {
  assertObject(snapshot, "snapshot");
  if (snapshot.format !== "place-core") throw new Error("invalid place-core snapshot format");
  if (snapshot.version !== expectedVersion) {
    throw new Error(`unsupported place-core snapshot version: ${snapshot.version}`);
  }
  if (!Number.isFinite(snapshot.time) || snapshot.time < 0) throw new Error("snapshot.time must be a non-negative finite number");
  if (!Number.isInteger(snapshot.graphRevision) || snapshot.graphRevision < 0) {
    throw new Error("snapshot.graphRevision must be a non-negative integer");
  }

  assertArray(snapshot.definitions, "snapshot.definitions");
  assertArray(snapshot.instances, "snapshot.instances");
  assertArray(snapshot.activeTravels, "snapshot.activeTravels");

  const definitionIds = new Set();
  const definitionHashes = new Map();
  for (let i = 0; i < snapshot.definitions.length; i += 1) {
    const item = snapshot.definitions[i];
    assertObject(item, `snapshot.definitions[${i}]`);
    if (typeof item.id !== "string" || !item.id) throw new Error("definition id must be a non-empty string");
    if (definitionIds.has(item.id)) throw new Error(`duplicate definition id: ${item.id}`);
    if (typeof item.contentHash !== "string" || !item.contentHash) throw new Error(`definition ${item.id} missing contentHash`);
    assertObject(item.blueprint, `definition ${item.id}.blueprint`);
    const compiled = compilePlace(item.blueprint);
    if (compiled.id !== item.id) throw new Error(`definition id mismatch for ${item.id}`);
    if (compiled.contentHash !== item.contentHash) throw new Error(`definition hash mismatch for ${item.id}`);
    definitionIds.add(item.id);
    definitionHashes.set(item.id, item.contentHash);
  }

  const instanceIds = new Set();
  const domainIds = new Set();
  for (let i = 0; i < snapshot.instances.length; i += 1) {
    const item = snapshot.instances[i];
    assertObject(item, `snapshot.instances[${i}]`);
    const idKey = String(item.id);
    if (instanceIds.has(idKey)) throw new Error(`duplicate place instance id: ${idKey}`);
    instanceIds.add(idKey);
    if (!definitionIds.has(item.definitionId)) throw new Error(`place ${idKey} references unknown definition ${item.definitionId}`);
    if (definitionHashes.get(item.definitionId) !== item.definitionHash) throw new Error(`place ${idKey} definition hash mismatch`);
    if (!Number.isInteger(item.revision) || item.revision < 0) throw new Error(`place ${idKey} has invalid revision`);
    validateEntryPairs(item.layerDomains, `place ${idKey}.layerDomains`);
    validateEntryPairs(item.portalOverrides, `place ${idKey}.portalOverrides`);
    validateEntryPairs(item.boundaryOverrides, `place ${idKey}.boundaryOverrides`);
    validateEntryPairs(item.dynamicPortals, `place ${idKey}.dynamicPortals`);
    validateEntryPairs(item.externalBindings, `place ${idKey}.externalBindings`);
    for (const [, domainId] of item.layerDomains) {
      if (typeof domainId !== "string" || !domainId) throw new Error(`place ${idKey} has invalid layer domain`);
      if (domainIds.has(domainId)) throw new Error(`duplicate bound domain: ${domainId}`);
      domainIds.add(domainId);
    }
  }

  for (const item of snapshot.instances) {
    if (item.parentPlaceId != null && !instanceIds.has(String(item.parentPlaceId))) {
      throw new Error(`place ${String(item.id)} references missing parent ${String(item.parentPlaceId)}`);
    }
  }

  const travelEntities = new Set();
  for (let i = 0; i < snapshot.activeTravels.length; i += 1) {
    const travel = snapshot.activeTravels[i];
    assertObject(travel, `snapshot.activeTravels[${i}]`);
    const entityKey = String(travel.entityId);
    if (travelEntities.has(entityKey)) throw new Error(`duplicate active travel for entity ${entityKey}`);
    travelEntities.add(entityKey);
    if (travel.status !== "active") throw new Error(`persisted travel for ${entityKey} is not active`);
    if (!Number.isInteger(travel.legIndex) || travel.legIndex < 0) throw new Error(`invalid travel legIndex for ${entityKey}`);
    if (!Number.isInteger(travel.replans) || travel.replans < 0) throw new Error(`invalid travel replans for ${entityKey}`);
    assertObject(travel.plan, `travel ${entityKey}.plan`);
    assertArray(travel.plan.legs, `travel ${entityKey}.plan.legs`);
    if (travel.legIndex > travel.plan.legs.length) throw new Error(`travel ${entityKey} legIndex exceeds plan`);
  }

  return true;
}

export function deserializePlaceCore(snapshot, {
  bridge = null,
  registryOptions = null
} = {}) {
  validatePlaceCoreSnapshot(snapshot);

  const registry = new PlaceRegistry(registryOptions ?? {});
  if (bridge) registry.attachWorldCoreBridge(bridge);

  for (const serialized of snapshot.definitions) {
    registry.registerDefinition(compilePlace(serialized.blueprint));
  }

  const pending = new Map(snapshot.instances.map((item) => [String(item.id), item]));
  const restored = new Set();

  while (pending.size) {
    let progress = false;
    for (const [key, item] of [...pending.entries()]) {
      if (item.parentPlaceId != null && !restored.has(String(item.parentPlaceId))) continue;

      const layerDomains = Object.fromEntries(item.layerDomains);
      const externalBindings = Object.fromEntries(item.externalBindings);
      const instance = registry.createPlace({
        id: item.id,
        definitionId: item.definitionId,
        layerDomains,
        parentPlaceId: item.parentPlaceId,
        placement: item.placement,
        placementDomainId: item.placementDomainId,
        externalBindings,
        metadata: item.metadata
      });

      for (const [portalId, patch] of item.portalOverrides) {
        registry.setPortalState(instance.id, portalId, patch);
      }
      for (const [boundaryId, patch] of item.boundaryOverrides) {
        registry.setBoundaryState(instance.id, boundaryId, patch);
      }
      for (const [, portal] of item.dynamicPortals) {
        registry.addPortal(instance.id, portal);
      }
      instance.revision = item.revision;
      restored.add(key);
      pending.delete(key);
      progress = true;
    }
    if (!progress) throw new Error("place parent graph contains a cycle");
  }

  registry.activeTravels = new Map();
  for (const travel of snapshot.activeTravels) {
    registry.activeTravels.set(travel.entityId, {
      entityId: travel.entityId,
      target: cloneJson(travel.target),
      options: cloneJson(travel.options),
      plan: deepFreezeTravelPlan(cloneJson(travel.plan)),
      legIndex: travel.legIndex,
      legStarted: travel.legStarted,
      status: "active",
      replans: travel.replans
    });
  }

  registry.time = snapshot.time;
  registry.graphRevision = snapshot.graphRevision;
  registry.drainEvents();
  registry.assertInternalConsistency();
  return registry;
}

function deepFreezeTravelPlan(plan) {
  if (plan && typeof plan === "object") {
    for (const value of Object.values(plan)) {
      if (value && typeof value === "object") deepFreezeTravelPlan(value);
    }
    Object.freeze(plan);
  }
  return plan;
}

function stateForHash(registry) {
  const snapshot = serializePlaceCore(registry);
  return {
    format: snapshot.format,
    version: snapshot.version,
    time: snapshot.time,
    graphRevision: snapshot.graphRevision,
    definitions: snapshot.definitions,
    instances: snapshot.instances,
    activeTravels: snapshot.activeTravels
  };
}

export function computePlaceCoreStateHash(registry) {
  return sha256(canonicalStringify(stateForHash(registry)));
}
