import { PlaceRegistry } from "./registry.js";
import { canonicalStringify, cloneJson, sha256 } from "./utils.js";
import { startTravel } from "./travel.js";

export const PLACE_CORE_SNAPSHOT_VERSION = 1;

function mapToObject(map) {
  return Object.fromEntries(map.entries());
}

export function serializePlaceCore(registry) {
  if (!(registry instanceof PlaceRegistry)) throw new TypeError("serializePlaceCore requires PlaceRegistry");
  return {
    format: "place-core",
    version: PLACE_CORE_SNAPSHOT_VERSION,
    definitions: [...registry.definitions.values()]
      .map((d) => ({ id: d.id, revision: d.revision, contentHash: d.contentHash }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    instances: [...registry.instances.values()].map((instance) => ({
      id: instance.id,
      definitionId: instance.definitionId,
      parentId: instance.parentId,
      layerDomains: mapToObject(instance.layerDomains),
      attachments: mapToObject(instance.attachments),
      placement: cloneJson(instance.placement),
      metadata: cloneJson(instance.metadata),
      portalOverrides: mapToObject(instance.portalOverrides),
      boundaryOverrides: mapToObject(instance.boundaryOverrides),
      spaceOverrides: mapToObject(instance.spaceOverrides),
      dynamicPortals: [...instance.dynamicPortals.values()].map(cloneJson)
    })),
    activeTravels: [...registry.activeTravels.values()].map((state) => ({
      entityId: state.entityId,
      target: cloneJson(state.target),
      status: state.status
    })),
    pendingTravels: registry.pendingTravels.map(cloneJson)
  };
}

export function validatePlaceCoreSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("place-core snapshot must be an object");
  if (snapshot.format !== "place-core") throw new Error(`invalid place-core snapshot format: ${snapshot.format}`);
  if (snapshot.version !== (options.expectedVersion ?? PLACE_CORE_SNAPSHOT_VERSION)) {
    throw new Error(`unsupported place-core snapshot version: ${snapshot.version}`);
  }
  if (!Array.isArray(snapshot.definitions) || !Array.isArray(snapshot.instances)) {
    throw new TypeError("snapshot definitions/instances must be arrays");
  }
  const definitions = new Set();
  for (const ref of snapshot.definitions) {
    if (!ref || typeof ref.id !== "string" || !ref.id || typeof ref.contentHash !== "string") throw new TypeError("invalid definition reference");
    if (definitions.has(ref.id)) throw new Error(`duplicate definition reference: ${ref.id}`);
    definitions.add(ref.id);
  }
  const instances = new Set();
  for (const item of snapshot.instances) {
    const key = `${typeof item.id}:${String(item.id)}`;
    if (instances.has(key)) throw new Error(`duplicate place instance: ${String(item.id)}`);
    instances.add(key);
    if (!definitions.has(item.definitionId)) throw new Error(`instance ${String(item.id)} references unknown definition`);
    if (!item.layerDomains || !item.attachments || !item.portalOverrides || !Array.isArray(item.dynamicPortals)) {
      throw new TypeError(`instance ${String(item.id)} has invalid persisted state`);
    }
  }
  for (const item of snapshot.instances) {
    if (item.parentId == null) continue;
    if (!instances.has(`${typeof item.parentId}:${String(item.parentId)}`)) {
      throw new Error(`instance ${String(item.id)} references missing parent`);
    }
  }
  return true;
}

function normalizeDefinitions(definitions) {
  if (definitions instanceof Map) return definitions;
  if (Array.isArray(definitions)) return new Map(definitions.map((d) => [d.id, d]));
  if (definitions && typeof definitions === "object") return new Map(Object.values(definitions).map((d) => [d.id, d]));
  throw new TypeError("deserializePlaceCore requires compiled definitions");
}

export function deserializePlaceCore(snapshot, options = {}) {
  validatePlaceCoreSnapshot(snapshot);
  const definitions = normalizeDefinitions(options.definitions);
  for (const ref of snapshot.definitions) {
    const definition = definitions.get(ref.id);
    if (!definition) throw new Error(`missing compiled definition ${ref.id}`);
    if (definition.contentHash !== ref.contentHash) throw new Error(`definition hash mismatch for ${ref.id}`);
  }

  const registry = new PlaceRegistry({
    bridge: options.bridge,
    captureEvents: options.captureEvents === true,
    eventQueueLimit: options.eventQueueLimit,
    eventOverflowPolicy: options.eventOverflowPolicy
  });
  for (const ref of snapshot.definitions) registry.registerDefinition(definitions.get(ref.id));

  const remaining = new Map(snapshot.instances.map((item) => [`${typeof item.id}:${String(item.id)}`, item]));
  while (remaining.size) {
    let progressed = false;
    for (const [key, item] of [...remaining]) {
      if (item.parentId != null && !registry.getPlace(item.parentId)) continue;
      registry.createPlace({
        id: item.id,
        definitionId: item.definitionId,
        parentId: item.parentId,
        layerDomains: item.layerDomains,
        attachments: item.attachments,
        placement: item.placement,
        metadata: item.metadata
      });
      for (const portal of item.dynamicPortals) registry.addInstancePortal(item.id, portal);
      for (const [id, patch] of Object.entries(item.portalOverrides ?? {})) registry.setPortalState(item.id, id, patch);
      for (const [id, patch] of Object.entries(item.boundaryOverrides ?? {})) registry.setBoundaryState(item.id, id, patch);
      for (const [id, patch] of Object.entries(item.spaceOverrides ?? {})) registry.setSpaceState(item.id, id, patch);
      remaining.delete(key);
      progressed = true;
    }
    if (!progressed) throw new Error("could not restore place hierarchy");
  }

  const intents = [
    ...(snapshot.pendingTravels ?? []),
    ...(snapshot.activeTravels ?? []).filter((x) => x.status === "active").map((x) => ({ entityId: x.entityId, target: x.target }))
  ];
  if (options.bridge && options.restartTravels !== false) {
    for (const intent of intents) startTravel(registry, intent.entityId, intent.target, { bridge: options.bridge });
  } else {
    registry.pendingTravels.push(...intents.map(cloneJson));
  }
  registry.assertInternalConsistency();
  return registry;
}

export function computePlaceCoreStateHash(registry) {
  return sha256(canonicalStringify(serializePlaceCore(registry)));
}
