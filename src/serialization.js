import { PlaceRegistry } from "./place-registry.js";
import {
  PLACE_REGISTRY_RESTORE_BRIDGE_TOKEN,
  PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
  bindTravelRuntimeBridge
} from "./registry/support.js";
import { compilePlace } from "./definition.js";
import {
  assertId,
  assertStringId,
  canonicalStringify,
  cloneJson,
  compareStrings,
  deepFreeze,
  normalizeBoolean,
  sha256
} from "./utils.js";
import {
  _startTravelWithEntity,
  startTravel,
  stopTravel
} from "./travel.js";
import {
  PLACE_CORE_SNAPSHOT_VERSION,
  idKey
} from "./serialization/support.js";
import { validatePlaceCoreSnapshot } from "./serialization/validation.js";

export {
  PLACE_CORE_SNAPSHOT_VERSION,
  validatePlaceCoreSnapshot
};

const NO_THROWN_VALUE = Symbol("no-thrown-value");

function safeThrownString(value) {
  try {
    return String(value);
  } catch {
    return "[unprintable thrown value]";
  }
}

function serializeRestartError(error) {
  let name = "Error";
  let message;
  let isError = false;

  try {
    isError = error instanceof Error;
  } catch {}

  if (isError) {
    try {
      if (
        typeof error.name === "string" &&
        error.name.length > 0
      ) {
        name = error.name;
      }
    } catch {}

    try {
      if (typeof error.message === "string") {
        message = error.message;
      }
    } catch {}
  }

  return {
    name,
    message:
      message === undefined
        ? safeThrownString(error)
        : message
  };
}

function assertRestoredWorldEntityLocation(
  entity,
  expectedId
) {
  assertId(entity?.id, "restored world entity.id");
  if (entity.id !== expectedId) {
    throw new Error(
      `restored world entity identity mismatch: expected ${String(expectedId)}, got ${String(entity.id)}`
    );
  }

  assertStringId(
    entity.domainId ?? "default",
    "restored world entity.domainId"
  );

  if (
    !entity.position ||
    typeof entity.position !== "object" ||
    !Number.isFinite(entity.position.x) ||
    !Number.isFinite(entity.position.y)
  ) {
    throw new TypeError(
      "restored world entity.position must contain finite x/y"
    );
  }

  return entity;
}

function assertResumableWorldEntity(
  entity,
  expectedId
) {
  assertRestoredWorldEntityLocation(
    entity,
    expectedId
  );

  if (!entity.mobility) {
    throw new Error(
      `restored world entity ${String(entity.id)} has no mobility profile`
    );
  }

  return entity;
}

function assertMatchingRestoredOccupancy(
  entity,
  saved
) {
  assertRestoredWorldEntityLocation(
    entity,
    saved.entityId
  );

  const domainId =
    entity.domainId ?? "default";

  if (
    domainId !== saved.domainId ||
    entity.position.x !== saved.position.x ||
    entity.position.y !== saved.position.y
  ) {
    throw new Error(
      `resumeWorldCoreState tracked entity ${String(saved.entityId)} does not match saved occupancy`
    );
  }

  return entity;
}

function assertDeserializeOptions(options) {
  if (!options ||
      typeof options !== "object" ||
      Array.isArray(options)) {
    throw new TypeError(
      "deserialize options must be a plain object"
    );
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype &&
      prototype !== null) {
    throw new TypeError(
      "deserialize options must be a plain object"
    );
  }
  const allowed = new Set([
    "bridge",
    "captureEvents",
    "eventQueueLimit",
    "eventOverflowPolicy",
    "resumeWorldCoreState",
    "restartTravels"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new Error(
        `deserialize options contains unknown field ${key}`
      );
    }
  }
}

function canonicalClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(canonicalStringify(value));
}

function dynamicPortalInputFromSnapshot(portal) {
  const endpointInput = (endpoint) => {
    const {
      kind: _snapshotKind,
      ...input
    } = endpoint;
    return input;
  };

  return {
    ...portal,
    a: endpointInput(portal.a),
    b: endpointInput(portal.b)
  };
}

function mapToObject(map) {
  return canonicalClone(Object.fromEntries(map.entries()));
}

function serializePlan(plan) {
  if (!plan) return null;
  const copy = canonicalClone(plan);
  delete copy.travelRevision;
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

function serializeTravelState(
  state,
  currentTravelRevision
) {
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
    replans: state.replans ?? 0,
    planStale:
      state.travelRevision !==
      currentTravelRevision
  };
}

export function serializePlaceCore(registry) {
  if (!(registry instanceof PlaceRegistry)) {
    throw new TypeError(
      "serializePlaceCore requires PlaceRegistry"
    );
  }

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
      .sort((a, b) => compareStrings(a.id, b.id)),
    instances: [...registry.instances.values()]
      .map((instance) => ({
        id: instance.id,
        definitionId: instance.definitionId,
        parentId: instance.parentId,
        memberships: instance.getMemberships()
          .map(canonicalClone)
          .sort((a, b) =>
            compareStrings(
              idKey(a.parentPlaceId),
              idKey(b.parentPlaceId)
            ) ||
            compareStrings(a.kind, b.kind)
          ),
        layerDomains: mapToObject(instance.layerDomains),
        attachments: mapToObject(instance.attachments),
        embeddedNodeBindings:
          mapToObject(
            instance.embeddedNodeBindings
          ),
        placement: canonicalClone(instance.placement),
        metadata: canonicalClone(instance.metadata),
        portalOverrides: mapToObject(instance.portalOverrides),
        boundaryOverrides: mapToObject(instance.boundaryOverrides),
        spaceOverrides: mapToObject(instance.spaceOverrides),
        dynamicPortals: [...instance.dynamicPortals.values()]
          .map(canonicalClone)
          .sort((a, b) => compareStrings(a.id, b.id))
      }))
      .sort((a, b) => compareStrings(idKey(a.id), idKey(b.id))),
    occupancy: registry._snapshotOccupancy()
      .map(canonicalClone),
    activeTravels: [...registry.activeTravels.values()]
      .filter((state) => state.status === "active")
      .map((state) =>
        serializeTravelState(
          state,
          registry.travelRevision
        )
      )
      .sort((a, b) => compareStrings(idKey(a.entityId), idKey(b.entityId))),
    pendingTravels: registry.pendingTravels
      .map(canonicalClone)
      .sort((a, b) =>
        compareStrings(
          idKey(a.entityId),
          idKey(b.entityId)
        ) ||
        compareStrings(
          canonicalStringify(a),
          canonicalStringify(b)
        )
      )
  };
}


export function deserializePlaceCore(snapshot, options = {}) {
  assertDeserializeOptions(options);
  validatePlaceCoreSnapshot(snapshot);

  const bridge = options.bridge ?? null;
  const resumeWorldCoreState = normalizeBoolean(
    options.resumeWorldCoreState,
    "resumeWorldCoreState",
    { defaultValue: false }
  );
  const restartTravels = normalizeBoolean(
    options.restartTravels,
    "restartTravels",
    { defaultValue: true }
  );

  if (resumeWorldCoreState && !bridge) {
    throw new Error(
      "resumeWorldCoreState requires a WorldCoreBridge"
    );
  }

  if (
    bridge &&
    snapshot.occupancy.length > 0 &&
    typeof bridge.getEntity !== "function"
  ) {
    throw new TypeError(
      "bridge.getEntity must be a function when restoring tracked occupancy"
    );
  }

  const captureEvents = normalizeBoolean(
    options.captureEvents,
    "deserialize captureEvents",
    { defaultValue: false }
  );
  const registry = new PlaceRegistry({
    captureEvents: false,
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

  const orderedInstances = [...snapshot.instances]
    .sort((a, b) =>
      compareStrings(idKey(a.id), idKey(b.id))
    );

  // Restore graph-independent instance state first. Semantic containment,
  // semantic memberships and placement are independent DAGs/trees and may
  // legally have cross-graph dependency cycles that cannot be topologically
  // ordered as one combined graph.
  for (const item of orderedInstances) {
    registry.createPlace({
      id: item.id,
      definitionId: item.definitionId,
      parentId: null,
      memberships: [],
      layerDomains: item.layerDomains,
      attachments: item.attachments,
      embeddedNodeBindings:
        item.embeddedNodeBindings,
      placement: null,
      metadata: item.metadata
    });
  }

  // Primary containment is a stable single-parent semantic chain.
  for (const item of orderedInstances) {
    if (item.parentId != null) {
      registry.setParent(
        item.id,
        item.parentId
      );
    }
  }

  // Additional semantic relations form the independent membership DAG.
  for (const item of orderedInstances) {
    for (const membership of item.memberships) {
      registry.addMembership(
        item.id,
        membership
      );
    }
  }

  // Placement is an independent single-parent transform graph.
  for (const item of orderedInstances) {
    if (item.placement != null) {
      registry.setPlacement(
        item.id,
        item.placement
      );
    }
  }

  // Structural sparse state is restored only after all graph identities and
  // coordinate-frame relationships exist.
  for (const item of orderedInstances) {
    for (const portal of item.dynamicPortals) {
      registry.addPortal(
        item.id,
        dynamicPortalInputFromSnapshot(portal)
      );
    }
    for (const [portalId, patch] of Object.entries(
      item.portalOverrides
    )) {
      registry.setPortalState(
        item.id,
        portalId,
        patch
      );
    }
    for (const [boundaryId, patch] of Object.entries(
      item.boundaryOverrides
    )) {
      registry.setBoundaryState(
        item.id,
        boundaryId,
        patch
      );
    }
    for (const [spaceId, patch] of Object.entries(
      item.spaceOverrides
    )) {
      registry.setSpaceState(
        item.id,
        spaceId,
        patch
      );
    }
  }


  const occupancy = snapshot.occupancy;
  const active = snapshot.activeTravels;
  const activeEntityKeys = new Set(
    active.map((saved) =>
      idKey(saved.entityId)
    )
  );
  const resumableEntities = new Map();
  const liveOccupancyEntities =
    new Map();
  const liveOccupancyLookupErrors =
    new Map();

  // Resume requires the restored world to match every selectively tracked
  // place-core entity, not only entities that happen to be travelling.
  // Verify this before materializing any place state into that world.
  if (bridge && resumeWorldCoreState) {
    for (const saved of occupancy) {
      const entity =
        bridge.getEntity?.(saved.entityId);
      if (!entity) {
        throw new Error(
          `resumeWorldCoreState is missing world entity ${String(saved.entityId)}`
        );
      }
      assertMatchingRestoredOccupancy(
        entity,
        saved
      );
      resumableEntities.set(
        saved.entityId,
        entity
      );
    }

    for (const saved of active) {
      const entity =
        resumableEntities.get(
          saved.entityId
        ) ??
        bridge.getEntity?.(saved.entityId);
      if (!entity) {
        throw new Error(
          `resumeWorldCoreState is missing world entity ${String(saved.entityId)}`
        );
      }
      assertResumableWorldEntity(
        entity,
        saved.entityId
      );
      resumableEntities.set(
        saved.entityId,
        entity
      );
    }
  } else if (bridge) {
    // With a live bridge but without resume semantics, world-core is the
    // physical authority. Preserve only the selectively tracked identity set
    // from the snapshot and re-derive each surviving entity's current
    // domain/position from the live world. Resolve every tracked identity
    // exactly once so occupancy and travel restart observe one coherent world
    // state. Missing entities disappear from occupancy. A lookup failure can
    // be retained as a pending-travel error for active travel, but stationary
    // tracked occupancy has no equivalent uncertainty state and must fail the
    // restore rather than silently lose tracking.
    for (const saved of occupancy) {
      let entity;
      try {
        entity =
          bridge.getEntity(
            saved.entityId
          );
      } catch (error) {
        if (
          !activeEntityKeys.has(
            idKey(saved.entityId)
          )
        ) {
          throw error;
        }
        liveOccupancyLookupErrors.set(
          saved.entityId,
          error
        );
        continue;
      }
      if (!entity) continue;

      assertRestoredWorldEntityLocation(
        entity,
        saved.entityId
      );
      liveOccupancyEntities.set(
        saved.entityId,
        entity
      );
    }
  }

  // Occupancy is a selectively tracked place-core index over physical state.
  // Standalone restore uses the snapshot; bridge-backed restore uses the live
  // world unless resume semantics already proved both states identical.
  for (const saved of occupancy) {
    if (bridge && !resumeWorldCoreState) {
      const entity =
        liveOccupancyEntities.get(
          saved.entityId
        );
      if (entity) {
        registry.updateEntityOccupancy(
          entity
        );
      }
      continue;
    }

    registry.updateEntityOccupancy({
      id: saved.entityId,
      domainId: saved.domainId,
      position: {
        x: saved.position.x,
        y: saved.position.y
      }
    });
  }

  // Materialize the fully restored structural state in one late-attach
  // transaction. PlaceRegistry.attachWorldCoreBridge rolls all earlier places back if
  // any later materialization/sync fails.
  if (bridge) {
    registry.attachWorldCoreBridge(
      bridge,
      resumeWorldCoreState
        ? PLACE_REGISTRY_RESTORE_BRIDGE_TOKEN
        : null
    );
  }

  // resumeWorldCoreState already proved every tracked live entity
  // matches the snapshot before bridge materialization. Re-reading live
  // entity getters here would reopen a failure/TOCTOU window after attach,
  // while producing the same occupancy that was restored above.
  const retainPending = (
    saved,
    ...restartErrors
  ) => {
    const pending = {
      entityId: saved.entityId,
      target: cloneJson(saved.target),
      savedState: cloneJson(saved)
    };
    if (restartErrors.length > 0) {
      pending.restartError =
        serializeRestartError(
          restartErrors[0]
        );
    }
    registry._pushPendingTravel(
      PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
      pending
    );
  };

  if (bridge && resumeWorldCoreState) {
    for (const saved of active) {
      const state = cloneJson(saved);
      const planWasStale =
        state.planStale;
      delete state.planStale;
      state.options = Object.freeze({
        ...state.options
      });
      state.worldChangePolicy =
        state.options.worldChangePolicy;
      const resumedTravelRevision =
        planWasStale
          ? (
              registry.travelRevision === 0
                ? 1
                : registry.travelRevision - 1
            )
          : registry.travelRevision;
      if (state.plan) {
        state.plan.travelRevision =
          resumedTravelRevision;
        state.plan.legs = state.plan.steps;
        deepFreeze(state.plan);
      }
      state.travelRevision =
        resumedTravelRevision;
      bindTravelRuntimeBridge(
        state,
        bridge
      );
      registry._setActiveTravel(
        PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
        state.entityId,
        state
      );
    }
  } else if (bridge && restartTravels) {
    for (const saved of active) {
      try {
        if (
          liveOccupancyLookupErrors.has(
            saved.entityId
          )
        ) {
          retainPending(
            saved,
            liveOccupancyLookupErrors.get(
              saved.entityId
            )
          );
          continue;
        }

        const entity =
          liveOccupancyEntities.get(
            saved.entityId
          ) ??
          null;
        if (!entity) {
          retainPending(saved);
          continue;
        }

        assertResumableWorldEntity(
          entity,
          saved.entityId
        );
        registry.updateEntityOccupancy(
          entity
        );

        const restarted = _startTravelWithEntity(
          registry,
          bridge,
          saved.entityId,
          entity,
          saved.target,
          saved.options
        );
        if (!restarted) {
          retainPending(saved);
        } else if (restarted.status === "failed") {
          retainPending(
            saved,
            new Error(
              restarted.failureReason ??
              "travel restart failed"
            )
          );
        }
      } catch (error) {
        let cleanupError = NO_THROWN_VALUE;
        if (registry._hasActiveTravel(
          PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
          saved.entityId
        )) {
          try {
            stopTravel(
              registry,
              bridge,
              saved.entityId,
              { reason: "restart-error" }
            );
          } catch (failure) {
            cleanupError = failure;
            registry._deleteActiveTravel(
              PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
              saved.entityId
            );
          }
        }

        retainPending(
          saved,
          cleanupError !== NO_THROWN_VALUE
            ? new AggregateError(
                [error, cleanupError],
                "travel restart and cleanup failed"
              )
            : error
        );
      }
    }
  } else {
    for (const saved of active) retainPending(saved);
  }

  for (const pending of snapshot.pendingTravels) {
    registry._pushPendingTravel(
      PLACE_REGISTRY_TRAVEL_MUTATION_TOKEN,
      pending
    );
  }

  registry.drainEvents();
  registry.setEventCapture(
    captureEvents
  );
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
    occupancy: snapshot.occupancy,
    activeTravels: snapshot.activeTravels,
    pendingTravels: snapshot.pendingTravels
  };
}

export function computePlaceCoreStateHash(registry) {
  return sha256(canonicalStringify(canonicalStateForHash(registry)));
}
