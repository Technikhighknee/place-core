import { compilePlace } from "../definition.js";
import {
  assertId,
  assertStringId,
  canonicalStringify,
  cloneJson,
  normalizeBoolean,
  normalizeStringList
} from "../utils.js";
import {
  validatePersistedTravelOptions,
  validateTravelTarget
} from "../travel/input.js";
import {
  PLACE_CORE_SNAPSHOT_VERSION,
  idKey
} from "./support.js";

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


function assertTravelTarget(target, _label = "travel target") {
  return validateTravelTarget(target);
}

function assertTravelOptions(options, label) {
  return validatePersistedTravelOptions(options, label);
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
  if (plan.resolvedTarget.placeId != null) {
    assertId(
      plan.resolvedTarget.placeId,
      "active travel plan.resolvedTarget.placeId"
    );
  }
  assertNullableString(
    plan.resolvedTarget.anchorId,
    "active travel plan.resolvedTarget.anchorId"
  );
  assertNullableString(
    plan.resolvedTarget.spaceId,
    "active travel plan.resolvedTarget.spaceId"
  );
  assertNullableString(
    plan.resolvedTarget.layerId,
    "active travel plan.resolvedTarget.layerId"
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

function snapshotPortalTraversable(portal) {
  return (portal.enabled ?? true) &&
    !(portal.locked ?? false) &&
    !(portal.blocked ?? false) &&
    !(portal.destroyed ?? false) &&
    (!(portal.blocksWhenClosed ?? false) || (portal.open ?? true));
}

function assertSnapshotResolvedPortalPhysical(
  portal,
  definition,
  item,
  label
) {
  if (!portal?.a || !portal?.b) return;
  if (portal.a.domainId !== portal.b.domainId) return;

  const domainId = portal.a.domainId;
  const thresholdBindings = (portal.roadBindings ?? []).filter(
    (binding) => item.layerDomains[binding.layerId] === domainId
  );
  const crossesSpaces =
    portal.a.spaceId != null &&
    portal.b.spaceId != null &&
    portal.a.spaceId !== portal.b.spaceId;
  const needsPhysicalEnforcement =
    crossesSpaces ||
    (portal.transitionCost ?? 0) > 0 ||
    !snapshotPortalTraversable(portal);

  if (needsPhysicalEnforcement && thresholdBindings.length === 0) {
    throw new Error(
      `${label} requires a road binding in domain ${domainId} for same-domain physical enforcement`
    );
  }

  if (thresholdBindings.length === 0) return;

  let allowsForward = false;
  let allowsReverse = false;
  let verifiedEmbeddedRoad = false;

  for (const binding of thresholdBindings) {
    const layer = definition.getLayer(binding.layerId);
    if (!layer?.navigation) continue;

    const road = layer.navigation.roads.find(
      (candidate) => candidate.id === binding.roadId
    );
    if (!road) {
      throw new Error(
        `${label} references unknown navigation road ${binding.roadId}`
      );
    }
    verifiedEmbeddedRoad = true;

    if (portal.a.nodeId == null || portal.b.nodeId == null) {
      throw new Error(
        `${label} with a same-domain threshold road binding requires nodeId on both endpoints`
      );
    }

    const forward =
      road.from === portal.a.nodeId &&
      road.to === portal.b.nodeId;
    const reverse =
      road.from === portal.b.nodeId &&
      road.to === portal.a.nodeId;

    if (!forward && !reverse) {
      throw new Error(
        `${label} road binding ${binding.roadId} does not connect its endpoint nodes`
      );
    }

    allowsForward ||= forward || (reverse && road.bidirectional);
    allowsReverse ||= reverse || (forward && road.bidirectional);
  }

  if (!verifiedEmbeddedRoad) return;

  if (!allowsForward) {
    throw new Error(
      `${label} threshold roads do not allow traversal from endpoint a to b`
    );
  }

  if (portal.bidirectional ?? true) {
    if (!allowsReverse) {
      throw new Error(
        `${label} is bidirectional but its threshold roads do not allow traversal from endpoint b to a`
      );
    }
  } else if (allowsReverse) {
    throw new Error(
      `${label} is unidirectional but its threshold roads allow reverse traversal`
    );
  }
}

function resolveSnapshotPortalEndpoint(endpoint, item) {
  if (endpoint.kind === "local") {
    return {
      domainId: item.layerDomains[endpoint.layerId],
      position: endpoint.position,
      nodeId: endpoint.nodeId ?? null,
      placeId: item.id,
      spaceId: endpoint.spaceId ?? null,
      layerId: endpoint.layerId
    };
  }

  if (endpoint.kind === "external") {
    const attachment = item.attachments[endpoint.slot];
    if (!attachment) return null;
    return {
      ...attachment,
      layerId: null
    };
  }

  return endpoint;
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
    if (layer.topologyId == null) {
      throw new Error(
        `dynamic portal ${portal.id} road binding requires navigation topology on layer ${binding.layerId}`
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

  assertSnapshotResolvedPortalPhysical(
    portal,
    definition,
    item,
    `dynamic portal ${portal.id}`
  );
}

export function validatePlaceCoreSnapshot(snapshot, options = {}) {
  assertObject(snapshot, "place-core snapshot");
  if (snapshot.format !== "place-core") {
    throw new Error(
      `invalid place-core snapshot format: ${snapshot.format}`
    );
  }
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
    if (typeof ref.id !== "string" || !ref.id) {
      throw new TypeError(
        "definition id must be a non-empty string"
      );
    }
    if (definitions.has(ref.id)) {
      throw new Error(
        `duplicate definition reference: ${ref.id}`
      );
    }
    if (typeof ref.contentHash !== "string" ||
        !ref.contentHash) {
      throw new TypeError(
        `definition ${ref.id} missing contentHash`
      );
    }
    assertObject(ref.blueprint, `definition ${ref.id}.blueprint`);

    const compiled = compilePlace(ref.blueprint);
    if (compiled.id !== ref.id) {
      throw new Error(`definition id mismatch for ${ref.id}`);
    }
    if (compiled.revision !== ref.revision) {
      throw new Error(`definition revision mismatch for ${ref.id}`);
    }
    if (compiled.contentHash !== ref.contentHash) {
      throw new Error(`definition hash mismatch for ${ref.id}`);
    }
    definitions.set(ref.id, compiled);
  }

  const instances = new Map();
  const domains = new Set();
  for (let i = 0; i < snapshot.instances.length; i += 1) {
    const item = snapshot.instances[i];
    assertObject(item, `snapshot.instances[${i}]`);
    assertId(item.id, `snapshot.instances[${i}].id`);
    assertStringId(
      item.definitionId,
      `snapshot.instances[${i}].definitionId`
    );
    if (item.parentId != null) {
      assertId(item.parentId, `snapshot.instances[${i}].parentId`);
    }

    assertArray(
      item.memberships ?? [],
      `snapshot.instances[${i}].memberships`
    );

    const membershipKeys = new Set();
    for (let j = 0; j < (item.memberships ?? []).length; j += 1) {
      const membership = item.memberships[j];
      const label =
        `snapshot.instances[${i}].memberships[${j}]`;

      assertObject(membership, label);

      const allowedMembershipKeys = new Set([
        "parentPlaceId",
        "kind",
        "metadata"
      ]);
      for (const field of Object.keys(membership)) {
        if (!allowedMembershipKeys.has(field)) {
          throw new Error(
            `${label} contains unknown field ${field}`
          );
        }
      }

      assertId(
        membership.parentPlaceId,
        `${label}.parentPlaceId`
      );
      assertStringId(
        membership.kind,
        `${label}.kind`
      );
      if (membership.metadata !== undefined) {
        assertJsonSafe(
          membership.metadata,
          `${label}.metadata`
        );
      }

      if (membership.parentPlaceId === item.id) {
        throw new Error(
          `instance ${String(item.id)} has a semantic membership to itself`
        );
      }

      const membershipKey =
        `${idKey(membership.parentPlaceId)}\u0000${membership.kind}`;
      if (membershipKeys.has(membershipKey)) {
        throw new Error(
          `instance ${String(item.id)} has duplicate semantic membership ${membership.kind} -> ${String(membership.parentPlaceId)}`
        );
      }
      membershipKeys.add(membershipKey);
    }

    if (item.metadata !== undefined) {
      assertJsonSafe(
        item.metadata,
        `instance ${String(item.id)}.metadata`
      );
    }

    const key = idKey(item.id);
    if (instances.has(key)) {
      throw new Error(`duplicate place instance: ${String(item.id)}`);
    }
    const definition = definitions.get(item.definitionId);
    if (!definition) {
      throw new Error(
        `instance ${String(item.id)} references unknown definition ${item.definitionId}`
      );
    }

    assertObject(item.layerDomains, `instance ${String(item.id)}.layerDomains`);
    assertObject(item.attachments, `instance ${String(item.id)}.attachments`);
    assertObject(item.portalOverrides ?? {}, `instance ${String(item.id)}.portalOverrides`);
    assertObject(item.boundaryOverrides ?? {}, `instance ${String(item.id)}.boundaryOverrides`);
    assertObject(item.spaceOverrides ?? {}, `instance ${String(item.id)}.spaceOverrides`);
    assertArray(item.dynamicPortals ?? [], `instance ${String(item.id)}.dynamicPortals`);

    const expectedLayerIds = new Set(
      definition.layers.map((layer) => layer.id)
    );
    for (const layerId of Object.keys(item.layerDomains)) {
      if (!expectedLayerIds.has(layerId)) {
        throw new Error(
          `instance ${String(item.id)} has domain for unknown layer ${layerId}`
        );
      }
    }

    for (const [slot, attachment] of Object.entries(item.attachments)) {
      assertStringId(slot, `instance ${String(item.id)} attachment slot`);
      assertAttachment(
        attachment,
        `instance ${String(item.id)}.attachments.${slot}`
      );
    }

    for (const layer of definition.layers) {
      const domainId = item.layerDomains[layer.id];
      if (typeof domainId !== "string" || !domainId) {
        throw new Error(`instance ${String(item.id)} missing domain for layer ${layer.id}`);
      }
      if (domains.has(domainId)) {
        throw new Error(
          `duplicate bound domain: ${domainId}`
        );
      }
      domains.add(domainId);
    }

    for (const [portalId, patch] of Object.entries(
      item.portalOverrides ?? {}
    )) {
      if (!definition.getPortal(portalId)) {
        throw new Error(
          `instance ${String(item.id)} has orphan portal override ${portalId}`
        );
      }
      assertBooleanPatch(
        patch,
        ["enabled", "open", "locked", "blocked", "destroyed"],
        `instance ${String(item.id)}.portalOverrides.${portalId}`
      );
    }

    for (const [boundaryId, patch] of Object.entries(
      item.boundaryOverrides ?? {}
    )) {
      if (!definition.getBoundary(boundaryId)) {
        throw new Error(
          `instance ${String(item.id)} has orphan boundary override ${boundaryId}`
        );
      }
      assertBooleanPatch(
        patch,
        ["enabled"],
        `instance ${String(item.id)}.boundaryOverrides.${boundaryId}`
      );
    }

    for (const [spaceId, patch] of Object.entries(
      item.spaceOverrides ?? {}
    )) {
      if (!definition.getSpace(spaceId)) {
        throw new Error(
          `instance ${String(item.id)} has orphan space override ${spaceId}`
        );
      }
      assertBooleanPatch(
        patch,
        ["enabled"],
        `instance ${String(item.id)}.spaceOverrides.${spaceId}`
      );
    }

    const dynamicIds = new Set();
    for (const portal of item.dynamicPortals ?? []) {
      assertDynamicPortal(
        portal,
        definition,
        item,
        dynamicIds
      );
    }

    for (const basePortal of definition.portals) {
      const override =
        item.portalOverrides?.[basePortal.id] ??
        {};
      const resolved = {
        ...basePortal,
        ...override,
        a: resolveSnapshotPortalEndpoint(basePortal.a, item),
        b: resolveSnapshotPortalEndpoint(basePortal.b, item)
      };
      if (resolved.a && resolved.b) {
        assertSnapshotResolvedPortalPhysical(
          resolved,
          definition,
          item,
          `portal ${basePortal.id}`
        );
      }
    }

    instances.set(key, item);
  }

  for (const item of snapshot.instances) {
    if (item.parentId != null &&
        !instances.has(idKey(item.parentId))) {
      throw new Error(
        `instance ${String(item.id)} references missing parent ${String(item.parentId)}`
      );
    }

    for (const membership of item.memberships ?? []) {
      if (!instances.has(idKey(membership.parentPlaceId))) {
        throw new Error(
          `instance ${String(item.id)} references missing membership parent ${String(membership.parentPlaceId)}`
        );
      }
    }

    if (item.placement != null) {
      assertObject(item.placement, `instance ${String(item.id)}.placement`);
      const hasDomain = item.placement.domainId != null;
      const hasParent = item.placement.parentPlaceId != null;
      if (hasDomain === hasParent) {
        throw new Error(
          `instance ${String(item.id)} placement must reference exactly one frame`
        );
      }

      if (hasDomain) {
        assertStringId(
          item.placement.domainId,
          `instance ${String(item.id)}.placement.domainId`
        );
      }

      if (hasParent) {
        assertId(
          item.placement.parentPlaceId,
          `instance ${String(item.id)}.placement.parentPlaceId`
        );
        if (!instances.has(idKey(item.placement.parentPlaceId))) {
          throw new Error(
            `instance ${String(item.id)} references missing placement parent ${String(item.placement.parentPlaceId)}`
          );
        }
      }

      if (item.placement.containment !== "none" &&
          item.placement.containment !== "footprint") {
        throw new Error(
          `instance ${String(item.id)} placement has invalid containment`
        );
      }

      assertObject(
        item.placement.transform,
        `instance ${String(item.id)}.placement.transform`
      );
      for (const key of ["x", "y", "rotation", "scale"]) {
        if (!Number.isFinite(item.placement.transform[key])) {
          throw new Error(
            `instance ${String(item.id)} placement transform ${key} must be finite`
          );
        }
      }
      if (!(item.placement.transform.scale > 0)) {
        throw new Error(
          `instance ${String(item.id)} placement scale must be > 0`
        );
      }
    }
  }

  const semanticPermanent = new Set();
  const semanticVisiting = new Set();

  const semanticParentIds = (item) => {
    const parents = new Map();

    if (item.parentId != null) {
      parents.set(
        idKey(item.parentId),
        item.parentId
      );
    }

    for (const membership of item.memberships ?? []) {
      parents.set(
        idKey(membership.parentPlaceId),
        membership.parentPlaceId
      );
    }

    return [...parents.values()]
      .sort((a, b) =>
        idKey(a).localeCompare(idKey(b))
      );
  };

  const semanticRoots = [...snapshot.instances]
    .sort((a, b) =>
      idKey(a.id).localeCompare(idKey(b.id))
    );

  for (const item of semanticRoots) {
    const rootKey = idKey(item.id);
    if (!semanticPermanent.has(rootKey)) {
      const stack = [{
        item,
        entered: false,
        parents: null,
        index: 0
      }];

      while (stack.length) {
        const frame =
          stack[stack.length - 1];
        const key = idKey(frame.item.id);

        if (semanticPermanent.has(key)) {
          stack.pop();
          continue;
        }

        if (!frame.entered) {
          if (semanticVisiting.has(key)) {
            throw new Error(
              `place semantic membership cycle involving ${String(frame.item.id)}`
            );
          }

          semanticVisiting.add(key);
          frame.entered = true;
          frame.parents =
            semanticParentIds(frame.item);
          frame.index = 0;
        }

        if (frame.index < frame.parents.length) {
          const parentId =
            frame.parents[frame.index++];
          const parentKey = idKey(parentId);

          if (semanticPermanent.has(parentKey)) {
            continue;
          }
          if (semanticVisiting.has(parentKey)) {
            throw new Error(
              `place semantic membership cycle involving ${String(parentId)}`
            );
          }

          stack.push({
            item: instances.get(parentKey),
            entered: false,
            parents: null,
            index: 0
          });
          continue;
        }

        semanticVisiting.delete(key);
        semanticPermanent.add(key);
        stack.pop();
      }
    }

    const placementVisited = new Set();
    let cursor = item;
    while (cursor?.placement?.parentPlaceId != null) {
      const key = idKey(cursor.id);
      if (placementVisited.has(key)) {
        throw new Error(
          `place placement cycle involving ${String(cursor.id)}`
        );
      }
      placementVisited.add(key);
      cursor = instances.get(
        idKey(cursor.placement.parentPlaceId)
      );
    }
  }

  const travelEntities = new Set();
  for (const travel of snapshot.activeTravels ?? []) {
    assertObject(travel, "active travel");
    assertId(travel.entityId, "active travel.entityId");

    const key = idKey(travel.entityId);
    if (travelEntities.has(key)) {
      throw new Error(
        `duplicate active travel for ${String(travel.entityId)}`
      );
    }
    travelEntities.add(key);

    if (travel.status !== "active") {
      throw new Error(
        "only active travel states may be persisted in activeTravels"
      );
    }
    assertTravelTarget(travel.target, "active travel.target");

    normalizeBoolean(travel.localStarted, "active travel.localStarted");
    normalizeBoolean(travel.portalEntered, "active travel.portalEntered");

    if (!Number.isFinite(travel.portalTransitionRemaining) ||
        travel.portalTransitionRemaining < 0) {
      throw new Error("invalid active travel portalTransitionRemaining");
    }
    if (!Number.isInteger(travel.stepIndex) || travel.stepIndex < 0) {
      throw new Error("invalid active travel stepIndex");
    }
    if (!Number.isInteger(travel.replans) || travel.replans < 0) {
      throw new Error("invalid active travel replans");
    }
    if (travel.failureReason != null &&
        typeof travel.failureReason !== "string") {
      throw new Error("invalid active travel failureReason");
    }

    if (travel.worldChangePolicy !== "encounter" &&
        travel.worldChangePolicy !== "eager") {
      throw new Error("invalid active travel worldChangePolicy");
    }

    assertTravelOptions(travel.options, "active travel options");
    const optionPolicy =
      travel.options.worldChangePolicy ??
      travel.worldChangePolicy;
    if (optionPolicy !== travel.worldChangePolicy) {
      throw new Error(
        "active travel options.worldChangePolicy disagrees with travel state"
      );
    }

    assertTravelPlan(travel.plan, travel.entityId);
    if (canonicalStringify(travel.plan.target) !==
        canonicalStringify(travel.target)) {
      throw new Error("active travel plan target mismatch");
    }
    if (travel.stepIndex > travel.plan.steps.length) {
      throw new Error("active travel stepIndex exceeds plan");
    }
  }

  for (let i = 0; i < (snapshot.pendingTravels ?? []).length; i += 1) {
    const pending = snapshot.pendingTravels[i];
    assertObject(pending, `snapshot.pendingTravels[${i}]`);
    assertJsonSafe(pending, `snapshot.pendingTravels[${i}]`);
    if (pending.entityId != null) {
      assertId(
        pending.entityId,
        `snapshot.pendingTravels[${i}].entityId`
      );
    }
    if (pending.target != null) {
      assertTravelTarget(
        pending.target,
        `snapshot.pendingTravels[${i}].target`
      );
    }
  }

  return true;
}
