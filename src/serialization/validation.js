import { compilePlace } from "../definition.js";
import { pointInGeometry } from "../geometry.js";
import {
  assertId,
  assertStringId,
  canonicalStringify,
  cloneJson,
  compareStrings,
  normalizeBoolean,
  normalizeStringList,
  tupleKey
} from "../utils.js";
import {
  validatePersistedTravelOptions,
  validateTravelTarget
} from "../travel/input.js";
import {
  portalTraversableState
} from "../registry/support.js";
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

function assertOnlyKeys(value, allowedKeys, label) {
  assertObject(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${label} contains unknown field ${key}`
      );
    }
  }
}

function ownValue(object, key) {
  return Object.hasOwn(object, key)
    ? object[key]
    : undefined;
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

function assertTravelPlan(
  plan,
  entityId,
  expectedTarget = null
) {
  const requiredPlanFields = [
    "entityId",
    "target",
    "resolvedTarget",
    "startDomainId",
    "domainPath",
    "steps",
    "legs",
    "estimatedSeconds",
    "rejectedDomainPairs"
  ];
  assertOnlyKeys(
    plan,
    requiredPlanFields,
    "active travel plan"
  );
  for (const key of requiredPlanFields) {
    if (!Object.hasOwn(plan, key)) {
      throw new Error(
        `active travel plan is missing required field ${key}`
      );
    }
  }
  if (plan.entityId !== entityId) {
    throw new Error("active travel plan entityId mismatch");
  }
  assertTravelTarget(
    plan.target,
    "active travel plan.target"
  );
  if (
    expectedTarget != null &&
    canonicalStringify(plan.target) !==
      canonicalStringify(expectedTarget)
  ) {
    throw new Error(
      "active travel plan target mismatch"
    );
  }

  assertOnlyKeys(
    plan.resolvedTarget,
    [
      "placeId",
      "anchorId",
      "spaceId",
      "layerId",
      "domainId",
      "position",
      "nodeId"
    ],
    "active travel plan.resolvedTarget"
  );
  assertOnlyKeys(
    plan.resolvedTarget.position,
    ["x", "y"],
    "active travel plan.resolvedTarget.position"
  );
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

  const target = plan.target;
  const resolvedTarget = plan.resolvedTarget;

  const assertResolvedField = (
    field,
    label = field
  ) => {
    if (
      target[field] != null &&
      resolvedTarget[field] !== target[field]
    ) {
      throw new Error(
        `active travel plan resolvedTarget.${label} does not match target`
      );
    }
  };

  if (target.domainId != null) {
    assertResolvedField("domainId");
    assertResolvedField("nodeId");
    assertResolvedField("placeId");
    assertResolvedField("anchorId");
    assertResolvedField("spaceId");
    assertResolvedField("layerId");

    if (
      resolvedTarget.position.x !==
        target.position.x ||
      resolvedTarget.position.y !==
        target.position.y
    ) {
      throw new Error(
        "active travel plan resolvedTarget.position does not match target"
      );
    }
  } else if (target.kind === "nearest") {
    assertResolvedField("placeId");
    assertResolvedField("spaceId");
  } else {
    assertResolvedField("placeId");
    assertResolvedField("anchorId");
    assertResolvedField("spaceId");
  }

  assertStringId(plan.startDomainId, "active travel plan.startDomainId");
  assertArray(plan.domainPath, "active travel plan.domainPath");
  normalizeStringList(
    plan.domainPath,
    "active travel plan.domainPath"
  );
  assertArray(plan.steps, "active travel plan.steps");

  let currentDomainId = plan.startDomainId;
  const expectedDomainPath = [currentDomainId];
  let expectedEstimatedSeconds = 0;

  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i];
    assertObject(step, `active travel plan.steps[${i}]`);

    if (step.type === "local-journey") {
      assertOnlyKeys(
        step,
        [
          "type",
          "domainId",
          "destinationNodeId",
          "destinationPosition",
          "estimatedSeconds"
        ],
        `active travel plan.steps[${i}]`
      );
      assertOnlyKeys(
        step.destinationPosition,
        ["x", "y"],
        `active travel plan.steps[${i}].destinationPosition`
      );
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
      if (step.domainId !== currentDomainId) {
        throw new Error(
          `active travel plan.steps[${i}] local-journey domain mismatch`
        );
      }
      expectedEstimatedSeconds +=
        step.estimatedSeconds;
      if (!Number.isFinite(expectedEstimatedSeconds)) {
        throw new Error(
          "active travel plan step cost sum must remain finite"
        );
      }
      continue;
    }

    if (step.type === "traverse-portal") {
      assertOnlyKeys(
        step,
        [
          "type",
          "portalKey",
          "placeId",
          "portalId",
          "fromDomainId",
          "toDomainId",
          "destinationPosition",
          "transitionCost"
        ],
        `active travel plan.steps[${i}]`
      );
      assertOnlyKeys(
        step.destinationPosition,
        ["x", "y"],
        `active travel plan.steps[${i}].destinationPosition`
      );
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

      const expectedPortalKey = tupleKey(
        idKey(step.placeId),
        step.portalId
      );
      if (step.portalKey !== expectedPortalKey) {
        throw new Error(
          `active travel plan.steps[${i}] portalKey mismatch for place/portal identity`
        );
      }

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
      if (step.fromDomainId !== currentDomainId) {
        throw new Error(
          `active travel plan.steps[${i}] portal fromDomainId mismatch`
        );
      }
      currentDomainId = step.toDomainId;
      expectedDomainPath.push(currentDomainId);
      expectedEstimatedSeconds +=
        step.transitionCost;
      if (!Number.isFinite(expectedEstimatedSeconds)) {
        throw new Error(
          "active travel plan step cost sum must remain finite"
        );
      }
      continue;
    }

    throw new Error(
      `unknown active travel plan step type: ${String(step.type)}`
    );
  }

  if (currentDomainId !== plan.resolvedTarget.domainId) {
    throw new Error(
      "active travel plan resolved target domain mismatch"
    );
  }
  if (
    plan.domainPath.length !== expectedDomainPath.length ||
    plan.domainPath.some(
      (domainId, index) =>
        domainId !== expectedDomainPath[index]
    )
  ) {
    throw new Error(
      "active travel plan domainPath mismatch"
    );
  }

  assertArray(
    plan.legs,
    "active travel plan.legs"
  );
  if (canonicalStringify(plan.legs) !==
      canonicalStringify(plan.steps)) {
    throw new Error(
      "active travel plan legs/steps mismatch"
    );
  }

  if (!Number.isFinite(plan.estimatedSeconds) || plan.estimatedSeconds < 0) {
    throw new Error("invalid active travel plan estimatedSeconds");
  }
  if (plan.estimatedSeconds !== expectedEstimatedSeconds) {
    throw new Error(
      "active travel plan estimatedSeconds mismatch with step cost sum"
    );
  }

  assertArray(
    plan.rejectedDomainPairs,
    "active travel plan.rejectedDomainPairs"
  );
  normalizeStringList(
    plan.rejectedDomainPairs,
    "active travel plan.rejectedDomainPairs"
  );
}

function assertAttachment(value, label) {
  const requiredAttachmentFields = [
    "domainId",
    "position",
    "nodeId",
    "placeId",
    "spaceId",
    "metadata"
  ];
  assertOnlyKeys(
    value,
    requiredAttachmentFields,
    label
  );
  for (const key of requiredAttachmentFields) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(
        `${label} is missing required field ${key}`
      );
    }
  }
  assertStringId(value.domainId, `${label}.domainId`);
  assertOnlyKeys(
    value.position,
    ["x", "y"],
    `${label}.position`
  );
  assertFiniteVec2(value.position, `${label}.position`);
  assertNullableString(value.nodeId, `${label}.nodeId`);
  if (value.placeId != null) assertId(value.placeId, `${label}.placeId`);
  assertNullableString(value.spaceId, `${label}.spaceId`);
  assertJsonSafe(
    value.metadata,
    `${label}.metadata`
  );
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

  const endpointDomains = new Set([
    portal.a.domainId,
    portal.b.domainId
  ]);

  for (const binding of portal.roadBindings ?? []) {
    const bindingDomainId =
      ownValue(
        item.layerDomains,
        binding.layerId
      );

    if (
      bindingDomainId != null &&
      !endpointDomains.has(
        bindingDomainId
      )
    ) {
      throw new Error(
        `${label} road binding ${binding.roadId} belongs to unrelated domain ${bindingDomainId}`
      );
    }
  }

  if (portal.a.domainId !== portal.b.domainId) return;

  const domainId = portal.a.domainId;
  const thresholdBindings = (portal.roadBindings ?? []).filter(
    (binding) =>
      ownValue(
        item.layerDomains,
        binding.layerId
      ) === domainId
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

function claimSnapshotThresholdRoadOwnership(
  portal,
  item,
  owners,
  label
) {
  if (!portal?.a || !portal?.b) return;
  if (portal.a.domainId !== portal.b.domainId) return;

  const domainId = portal.a.domainId;
  for (const binding of portal.roadBindings ?? []) {
    if (
      ownValue(
        item.layerDomains,
        binding.layerId
      ) !== domainId
    ) {
      continue;
    }

    const key = tupleKey(
      domainId,
      binding.roadId
    );
    const owner = owners.get(key);
    if (
      owner != null &&
      owner.portalId !== portal.id
    ) {
      throw new Error(
        `navigation road ${binding.roadId} in domain ${domainId} is already bound as a threshold by portal ${owner.portalId}; ${label} cannot also own it`
      );
    }

    owners.set(key, {
      portalId: portal.id,
      label
    });
  }
}

function resolveSnapshotPortalEndpoint(endpoint, item) {
  if (endpoint.kind === "local") {
    return {
      domainId: ownValue(item.layerDomains, endpoint.layerId),
      position: endpoint.position,
      nodeId: endpoint.nodeId ?? null,
      placeId: item.id,
      spaceId: endpoint.spaceId ?? null,
      layerId: endpoint.layerId
    };
  }

  if (endpoint.kind === "external") {
    const attachment = ownValue(item.attachments, endpoint.slot);
    if (!attachment) return null;
    return {
      ...attachment,
      layerId: null
    };
  }

  return endpoint;
}

function assertDynamicPortal(portal, definition, item, dynamicIds) {
  const requiredPortalFields = [
    "id",
    "kind",
    "tags",
    "a",
    "b",
    "bidirectional",
    "transitionCost",
    "enabled",
    "open",
    "locked",
    "blocked",
    "destroyed",
    "blocksWhenClosed",
    "roadBindings",
    "metadata"
  ];
  assertOnlyKeys(
    portal,
    requiredPortalFields,
    "dynamic portal"
  );
  for (const key of requiredPortalFields) {
    if (!Object.hasOwn(portal, key)) {
      throw new Error(
        `dynamic portal is missing required field ${key}`
      );
    }
  }
  assertStringId(portal.id, "dynamic portal.id");

  if (dynamicIds.has(portal.id) || definition.getPortal(portal.id)) {
    throw new Error(
      `duplicate dynamic portal ${portal.id} on instance ${String(item.id)}`
    );
  }
  dynamicIds.add(portal.id);

  assertStringId(portal.kind, `dynamic portal ${portal.id}.kind`);
  normalizeStringList(
    portal.tags,
    `dynamic portal ${portal.id}.tags`
  );

  const transitionCost = portal.transitionCost;
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
    normalizeBoolean(
      portal[key],
      `dynamic portal ${portal.id}.${key}`
    );
  }

  for (const [side, endpoint] of [["a", portal.a], ["b", portal.b]]) {
    const endpointLabel =
      `dynamic portal ${portal.id}.${side}`;
    const requiredEndpointFields = [
      "kind",
      "domainId",
      "position",
      "nodeId",
      "placeId",
      "spaceId",
      "layerId",
      "metadata"
    ];
    assertOnlyKeys(
      endpoint,
      requiredEndpointFields,
      endpointLabel
    );
    for (const key of requiredEndpointFields) {
      if (!Object.hasOwn(endpoint, key)) {
        throw new Error(
          `${endpointLabel} is missing required field ${key}`
        );
      }
    }
    if (endpoint.kind !== "resolved") {
      throw new Error(
        `${endpointLabel}.kind must be "resolved"`
      );
    }
    assertStringId(
      endpoint.domainId,
      `${endpointLabel}.domainId`
    );
    assertOnlyKeys(
      endpoint.position,
      ["x", "y"],
      `${endpointLabel}.position`
    );
    assertFiniteVec2(
      endpoint.position,
      `${endpointLabel}.position`
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
    assertJsonSafe(
      endpoint.metadata,
      `dynamic portal ${portal.id}.${side}.metadata`
    );
  }

  assertArray(
    portal.roadBindings,
    `dynamic portal ${portal.id}.roadBindings`
  );
  for (let i = 0; i < portal.roadBindings.length; i += 1) {
    const binding = portal.roadBindings[i];
    assertOnlyKeys(
      binding,
      ["layerId", "roadId"],
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

  assertJsonSafe(
    portal.metadata,
    `dynamic portal ${portal.id}.metadata`
  );

  assertSnapshotResolvedPortalPhysical(
    portal,
    definition,
    item,
    `dynamic portal ${portal.id}`
  );
}


function assertPersistedActiveTravelState(
  travel,
  label
) {
  assertOnlyKeys(
    travel,
    [
      "entityId",
      "target",
      "plan",
      "options",
      "stepIndex",
      "localStarted",
      "portalEntered",
      "portalTransitionRemaining",
      "worldChangePolicy",
      "status",
      "failureReason",
      "replans",
      "planStale"
    ],
    label
  );
  assertId(
    travel.entityId,
    `${label}.entityId`
  );

  if (travel.status !== "active") {
    throw new Error(
      `${label} must contain an active travel state`
    );
  }
  assertTravelTarget(
    travel.target,
    `${label}.target`
  );

  normalizeBoolean(
    travel.localStarted,
    `${label}.localStarted`
  );
  normalizeBoolean(
    travel.portalEntered,
    `${label}.portalEntered`
  );

  if (
    !Number.isFinite(
      travel.portalTransitionRemaining
    ) ||
    travel.portalTransitionRemaining < 0
  ) {
    throw new Error(
      `invalid ${label}.portalTransitionRemaining`
    );
  }
  if (
    !Number.isInteger(travel.stepIndex) ||
    travel.stepIndex < 0
  ) {
    throw new Error(
      `invalid ${label}.stepIndex`
    );
  }
  if (
    !Number.isSafeInteger(travel.replans) ||
    travel.replans < 0
  ) {
    throw new Error(
      `${label}.replans must be a non-negative safe integer`
    );
  }
  if (
    !Object.hasOwn(
      travel,
      "planStale"
    ) ||
    typeof travel.planStale !==
      "boolean"
  ) {
    throw new TypeError(
      `${label}.planStale must be a boolean`
    );
  }
  if (travel.failureReason !== null) {
    throw new Error(
      `${label}.failureReason must be null`
    );
  }

  if (
    travel.worldChangePolicy !==
      "encounter" &&
    travel.worldChangePolicy !== "eager"
  ) {
    throw new Error(
      `invalid ${label}.worldChangePolicy`
    );
  }

  assertTravelOptions(
    travel.options,
    `${label}.options`
  );
  for (const key of [
    "worldChangePolicy",
    "portalEntryTolerance"
  ]) {
    if (
      !Object.hasOwn(
        travel.options,
        key
      )
    ) {
      throw new Error(
        `${label}.options is missing required field ${key}`
      );
    }
  }
  const optionPolicy =
    travel.options.worldChangePolicy ??
    travel.worldChangePolicy;
  if (
    optionPolicy !==
    travel.worldChangePolicy
  ) {
    throw new Error(
      `${label}.options.worldChangePolicy disagrees with travel state`
    );
  }

  assertTravelPlan(
    travel.plan,
    travel.entityId,
    travel.target
  );
  if (
    travel.stepIndex >=
    travel.plan.steps.length
  ) {
    throw new Error(
      `${label}.stepIndex must reference an executable plan step`
    );
  }

  const currentStep =
    travel.plan.steps[travel.stepIndex];

  if (
    travel.localStarted &&
    currentStep.type !== "local-journey"
  ) {
    throw new Error(
      `${label}.localStarted requires a local-journey step`
    );
  }
  if (
    travel.portalEntered &&
    currentStep.type !== "traverse-portal"
  ) {
    throw new Error(
      `${label}.portalEntered requires a traverse-portal step`
    );
  }
  if (
    travel.portalTransitionRemaining > 0 &&
    (
      !travel.portalEntered ||
      currentStep.type !==
        "traverse-portal"
    )
  ) {
    throw new Error(
      `${label}.portalTransitionRemaining requires an entered portal step`
    );
  }
  if (
    travel.portalEntered &&
    travel.portalTransitionRemaining <= 0
  ) {
    throw new Error(
      `${label} entered portal must have positive portalTransitionRemaining`
    );
  }
  if (
    currentStep.type ===
      "traverse-portal" &&
    travel.portalTransitionRemaining >
      currentStep.transitionCost
  ) {
    throw new Error(
      `${label}.portalTransitionRemaining cannot exceed step transitionCost`
    );
  }

  return true;
}

export function validatePlaceCoreSnapshot(snapshot, options = {}) {
  assertOnlyKeys(
    options,
    ["expectedVersion"],
    "snapshot validation options"
  );
  assertOnlyKeys(
    snapshot,
    [
      "format",
      "version",
      "definitions",
      "instances",
      "occupancy",
      "activeTravels",
      "pendingTravels"
    ],
    "place-core snapshot"
  );
  for (const key of [
    "format",
    "version",
    "definitions",
    "instances",
    "occupancy",
    "activeTravels",
    "pendingTravels"
  ]) {
    if (!Object.hasOwn(snapshot, key)) {
      throw new Error(
        `place-core snapshot is missing required field ${key}`
      );
    }
  }

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
  assertArray(snapshot.occupancy, "snapshot.occupancy");
  assertArray(snapshot.activeTravels, "snapshot.activeTravels");
  assertArray(snapshot.pendingTravels, "snapshot.pendingTravels");

  const definitions = new Map();
  for (let i = 0; i < snapshot.definitions.length; i += 1) {
    const ref = snapshot.definitions[i];
    assertOnlyKeys(
      ref,
      ["id", "revision", "contentHash", "blueprint"],
      `snapshot.definitions[${i}]`
    );
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
    const itemLabel = `snapshot.instances[${i}]`;
    const requiredInstanceFields = [
      "id",
      "definitionId",
      "parentId",
      "memberships",
      "layerDomains",
      "attachments",
      "placement",
      "metadata",
      "portalOverrides",
      "boundaryOverrides",
      "spaceOverrides",
      "dynamicPortals"
    ];
    assertOnlyKeys(
      item,
      requiredInstanceFields,
      itemLabel
    );
    for (const key of requiredInstanceFields) {
      if (!Object.hasOwn(item, key)) {
        throw new Error(
          `${itemLabel} is missing required field ${key}`
        );
      }
    }
    assertId(item.id, `${itemLabel}.id`);
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

      const membershipKey = tupleKey(
        idKey(membership.parentPlaceId),
        membership.kind
      );
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
      const domainId = ownValue(item.layerDomains, layer.id);
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
    const thresholdRoadOwners = new Map();

    for (const portal of item.dynamicPortals ?? []) {
      assertDynamicPortal(
        portal,
        definition,
        item,
        dynamicIds
      );
      claimSnapshotThresholdRoadOwnership(
        portal,
        item,
        thresholdRoadOwners,
        `dynamic portal ${portal.id}`
      );
    }

    for (const basePortal of definition.portals) {
      const override =
        ownValue(item.portalOverrides ?? {}, basePortal.id) ??
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
        claimSnapshotThresholdRoadOwnership(
          resolved,
          item,
          thresholdRoadOwners,
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
      const placementLabel =
        `instance ${String(item.id)}.placement`;
      const requiredPlacementFields = [
        "domainId",
        "parentPlaceId",
        "containment",
        "transform"
      ];
      assertOnlyKeys(
        item.placement,
        requiredPlacementFields,
        placementLabel
      );
      for (const key of requiredPlacementFields) {
        if (!Object.hasOwn(item.placement, key)) {
          throw new Error(
            `${placementLabel} is missing required field ${key}`
          );
        }
      }
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

      const requiredTransformFields = [
        "x",
        "y",
        "rotation",
        "scale"
      ];
      assertOnlyKeys(
        item.placement.transform,
        requiredTransformFields,
        `instance ${String(item.id)}.placement.transform`
      );
      for (const key of requiredTransformFields) {
        if (
          !Object.hasOwn(
            item.placement.transform,
            key
          )
        ) {
          throw new Error(
            `instance ${String(item.id)}.placement.transform is missing required field ${key}`
          );
        }
      }
      for (const key of requiredTransformFields) {
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
        compareStrings(idKey(a), idKey(b))
      );
  };

  const semanticRoots = [...snapshot.instances]
    .sort((a, b) =>
      compareStrings(idKey(a.id), idKey(b.id))
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
  }

  const placementPermanent = new Set();

  for (const item of semanticRoots) {
    const rootKey = idKey(item.id);
    if (placementPermanent.has(rootKey)) {
      continue;
    }

    const path = [];
    const visiting = new Set();
    let cursor = item;

    while (cursor != null) {
      const key = idKey(cursor.id);
      if (placementPermanent.has(key)) {
        break;
      }
      if (visiting.has(key)) {
        throw new Error(
          `place placement cycle involving ${String(cursor.id)}`
        );
      }

      visiting.add(key);
      path.push(cursor);

      const parentId =
        cursor.placement?.parentPlaceId;
      if (parentId == null) {
        break;
      }

      cursor = instances.get(
        idKey(parentId)
      );
    }

    for (const member of path) {
      placementPermanent.add(
        idKey(member.id)
      );
    }
  }

  const occupancyEntities = new Set();
  for (let i = 0; i < snapshot.occupancy.length; i += 1) {
    const item = snapshot.occupancy[i];
    const label =
      `snapshot.occupancy[${i}]`;

    assertOnlyKeys(
      item,
      [
        "entityId",
        "domainId",
        "position"
      ],
      label
    );
    for (const key of [
      "entityId",
      "domainId",
      "position"
    ]) {
      if (!Object.hasOwn(item, key)) {
        throw new Error(
          `${label} is missing required field ${key}`
        );
      }
    }

    assertId(
      item.entityId,
      `${label}.entityId`
    );
    assertStringId(
      item.domainId,
      `${label}.domainId`
    );
    assertOnlyKeys(
      item.position,
      ["x", "y"],
      `${label}.position`
    );
    assertFiniteVec2(
      item.position,
      `${label}.position`
    );

    const key = idKey(item.entityId);
    if (occupancyEntities.has(key)) {
      throw new Error(
        `duplicate occupancy entity ${String(item.entityId)}`
      );
    }
    occupancyEntities.add(key);
  }

  const assertFreshTravelReferences = (
    travel,
    label
  ) => {
    if (travel.planStale !== false) {
      return;
    }

    const semanticTarget =
      travel.target.domainId == null;
    const target =
      travel.plan.resolvedTarget;

    if (!semanticTarget) {
      const requested =
        travel.target;
      if (
        target.domainId !==
          requested.domainId ||
        target.position.x !==
          requested.position.x ||
        target.position.y !==
          requested.position.y ||
        (target.nodeId ?? null) !==
          (requested.nodeId ?? null) ||
        (target.placeId ?? null) !==
          (requested.placeId ?? null) ||
        (target.anchorId ?? null) !==
          (requested.anchorId ?? null) ||
        (target.spaceId ?? null) !==
          (requested.spaceId ?? null) ||
        (target.layerId ?? null) !==
          (requested.layerId ?? null)
      ) {
        throw new Error(
          `${label} fresh plan resolved target no longer matches direct target`
        );
      }
    }

    if (semanticTarget) {
      const targetPlaceId =
        target.placeId;
      const item =
        targetPlaceId == null
          ? null
          : instances.get(
              idKey(targetPlaceId)
            );

      if (!item) {
        throw new Error(
          `${label} fresh plan references missing target place ${String(targetPlaceId)}`
        );
      }

      const definition =
        definitions.get(
          item.definitionId
        );

      if (
        target.layerId == null ||
        !definition?.getLayer(
          target.layerId
        )
      ) {
        throw new Error(
          `${label} fresh plan references missing target layer ${String(target.layerId)}`
        );
      }

      if (
        ownValue(
          item.layerDomains,
          target.layerId
        ) !== target.domainId
      ) {
        throw new Error(
          `${label} fresh plan target domain no longer matches target layer`
        );
      }

      if (target.spaceId != null) {
        const space =
          definition.getSpace(
            target.spaceId
          );
        if (
          !space ||
          space.layerId !==
            target.layerId
        ) {
          throw new Error(
            `${label} fresh plan references missing or mismatched target space ${target.spaceId}`
          );
        }
      }

      const spaceEnabled = (
        spaceId
      ) => {
        let current =
          spaceId == null
            ? null
            : definition.getSpace(
                spaceId
              );

        while (current) {
          if (
            ownValue(
              item.spaceOverrides ?? {},
              current.id
            )?.enabled === false
          ) {
            return false;
          }

          current =
            current.parentSpaceId == null
              ? null
              : definition.getSpace(
                  current.parentSpaceId
                );
        }

        return true;
      };

      const requestedTarget =
        travel.target;
      const nearestTarget =
        requestedTarget.kind === "nearest";

      if (
        nearestTarget &&
        requestedTarget.placeId != null &&
        target.placeId !==
          requestedTarget.placeId
      ) {
        throw new Error(
          `${label} fresh nearest target no longer matches requested place ${String(requestedTarget.placeId)}`
        );
      }

      if (
        !nearestTarget &&
        target.placeId !==
          requestedTarget.placeId
      ) {
        throw new Error(
          `${label} fresh plan resolved target no longer matches requested place ${String(requestedTarget.placeId)}`
        );
      }

      if (
        target.spaceId != null &&
        !spaceEnabled(target.spaceId)
      ) {
        throw new Error(
          `${label} fresh plan target space is disabled`
        );
      }

      if (
        nearestTarget &&
        requestedTarget.spaceId != null &&
        target.spaceId !==
          requestedTarget.spaceId
      ) {
        throw new Error(
          `${label} fresh nearest target no longer matches requested space ${requestedTarget.spaceId}`
        );
      }

      const anchor =
        target.anchorId == null
          ? null
          : definition.getAnchor(
              target.anchorId
            );

      if (!anchor) {
        throw new Error(
          `${label} fresh plan references missing target anchor ${String(target.anchorId)}`
        );
      }

      if (!nearestTarget) {
        if (
          requestedTarget.anchorId != null &&
          target.anchorId !==
            requestedTarget.anchorId
        ) {
          throw new Error(
            `${label} fresh plan resolved target no longer matches requested anchor ${requestedTarget.anchorId}`
          );
        }

        if (
          requestedTarget.spaceId != null &&
          target.spaceId !==
            requestedTarget.spaceId
        ) {
          throw new Error(
            `${label} fresh plan resolved target no longer matches requested space ${requestedTarget.spaceId}`
          );
        }

        if (requestedTarget.anchorId == null) {
          const anchorAvailable = (
            candidate
          ) =>
            candidate != null &&
            (
              candidate.spaceId == null ||
              spaceEnabled(
                candidate.spaceId
              )
            );

          let expectedAnchor = null;

          if (
            requestedTarget.spaceId != null
          ) {
            const requestedSpace =
              definition.getSpace(
                requestedTarget.spaceId
              );
            if (
              !requestedSpace ||
              !spaceEnabled(
                requestedTarget.spaceId
              )
            ) {
              throw new Error(
                `${label} fresh plan requested target space is unavailable`
              );
            }

            if (
              requestedSpace.defaultAnchorId != null
            ) {
              const candidate =
                definition.getAnchor(
                  requestedSpace.defaultAnchorId
                );
              if (anchorAvailable(candidate)) {
                expectedAnchor =
                  candidate;
              }
            }

            if (!expectedAnchor) {
              expectedAnchor = [
                ...definition.getAnchorsForSpace(
                  requestedSpace.id
                )
              ]
                .filter(anchorAvailable)
                .sort((a, b) =>
                  compareStrings(
                    a.id,
                    b.id
                  )
                )[0] ?? null;
            }
          } else {
            if (
              definition.defaultAnchorId != null
            ) {
              const candidate =
                definition.getAnchor(
                  definition.defaultAnchorId
                );
              if (anchorAvailable(candidate)) {
                expectedAnchor =
                  candidate;
              }
            }

            if (!expectedAnchor) {
              expectedAnchor = [
                ...definition.getAnchorsByTag(
                  "entry"
                )
              ]
                .filter(anchorAvailable)
                .sort((a, b) =>
                  compareStrings(
                    a.id,
                    b.id
                  )
                )[0] ?? [
                  ...definition.anchors
                ]
                  .filter(anchorAvailable)
                  .sort((a, b) =>
                    compareStrings(
                      a.id,
                      b.id
                    )
                  )[0] ?? null;
            }
          }

          if (
            !expectedAnchor ||
            target.anchorId !==
              expectedAnchor.id
          ) {
            throw new Error(
              `${label} fresh plan resolved target no longer matches implicit anchor selection`
            );
          }
        }
      }

      const targetSpaceMatchesAnchor = (() => {
        const anchorSpaceId =
          anchor.spaceId ?? null;
        const resolvedSpaceId =
          target.spaceId ?? null;

        if (anchorSpaceId === resolvedSpaceId) {
          return true;
        }

        const requestedSpaceId =
          travel.target?.domainId == null &&
          travel.target?.kind == null
            ? travel.target?.spaceId ?? null
            : null;

        if (
          requestedSpaceId == null ||
          resolvedSpaceId !== requestedSpaceId
        ) {
          return false;
        }

        const requestedSpace =
          definition.getSpace(
            requestedSpaceId
          );
        if (
          !requestedSpace ||
          requestedSpace.layerId !==
            anchor.layerId ||
          !pointInGeometry(
            anchor.position,
            requestedSpace.geometry
          )
        ) {
          return false;
        }

        if (anchorSpaceId == null) {
          return true;
        }

        let current =
          definition.getSpace(
            anchorSpaceId
          );
        while (current) {
          if (
            current.id ===
              requestedSpaceId
          ) {
            return true;
          }
          current =
            current.parentSpaceId == null
              ? null
              : definition.getSpace(
                  current.parentSpaceId
                );
        }
        return false;
      })();

      if (
        anchor.layerId !==
          target.layerId ||
        !targetSpaceMatchesAnchor ||
        (anchor.nodeId ?? null) !==
          (target.nodeId ?? null) ||
        anchor.position.x !==
          target.position.x ||
        anchor.position.y !==
          target.position.y
      ) {
        throw new Error(
          `${label} fresh plan target anchor no longer matches resolved target`
        );
      }

      if (
        anchor.spaceId != null &&
        !spaceEnabled(anchor.spaceId)
      ) {
        throw new Error(
          `${label} fresh plan target anchor is in a disabled space`
        );
      }

      if (travel.target.kind === "nearest") {
        if (
          travel.target.spaceId != null &&
          anchor.spaceId !==
            travel.target.spaceId
        ) {
          throw new Error(
            `${label} fresh nearest target anchor no longer matches space ${travel.target.spaceId}`
          );
        }
        if (
          !anchor.tags.includes(
            travel.target.tag
          )
        ) {
          throw new Error(
            `${label} fresh nearest target anchor no longer matches tag ${travel.target.tag}`
          );
        }
        if (
          travel.target.anchorKind != null &&
          anchor.kind !==
            travel.target.anchorKind
        ) {
          throw new Error(
            `${label} fresh nearest target anchor no longer matches kind ${travel.target.anchorKind}`
          );
        }
      }
    }

    for (
      let i = 0;
      i < travel.plan.steps.length;
      i += 1
    ) {
      const step = travel.plan.steps[i];
      if (step.type !== "traverse-portal") {
        continue;
      }

      const item =
        instances.get(idKey(step.placeId));
      if (!item) {
        throw new Error(
          `${label} fresh plan step ${i} references missing portal place ${String(step.placeId)}`
        );
      }

      const definition =
        definitions.get(item.definitionId);
      const dynamic =
        (item.dynamicPortals ?? [])
          .find((portal) =>
            portal.id === step.portalId
          ) ??
        null;
      const base =
        dynamic == null
          ? definition?.getPortal(
              step.portalId
            ) ?? null
          : null;
      const source = dynamic ?? base;

      if (!source) {
        throw new Error(
          `${label} fresh plan step ${i} references missing portal ${step.portalId} on place ${String(step.placeId)}`
        );
      }

      const override =
        dynamic == null
          ? ownValue(
              item.portalOverrides ?? {},
              step.portalId
            ) ?? {}
          : {};
      const portal = {
        ...source,
        ...override
      };
      const a =
        resolveSnapshotPortalEndpoint(
          portal.a,
          item
        );
      const b =
        resolveSnapshotPortalEndpoint(
          portal.b,
          item
        );

      if (!a || !b) {
        throw new Error(
          `${label} fresh plan step ${i} references disconnected portal ${step.portalId}`
        );
      }

      const directions = [
        { from: a, to: b }
      ];
      if (portal.bidirectional !== false) {
        directions.push({
          from: b,
          to: a
        });
      }

      if (
        !portalTraversableState({
          ...portal,
          connected: true
        })
      ) {
        throw new Error(
          `${label} fresh plan step ${i} references non-traversable portal ${step.portalId}`
        );
      }

      if (
        step.transitionCost !==
        (portal.transitionCost ?? 0)
      ) {
        throw new Error(
          `${label} fresh plan step ${i} portal transitionCost no longer matches snapshot state`
        );
      }

      const matchedDirection =
        directions.find(
          ({ from, to }) =>
            from.domainId ===
              step.fromDomainId &&
            to.domainId ===
              step.toDomainId &&
            to.position.x ===
              step.destinationPosition.x &&
            to.position.y ===
              step.destinationPosition.y
        ) ?? null;

      if (!matchedDirection) {
        throw new Error(
          `${label} fresh plan step ${i} portal route no longer matches snapshot state`
        );
      }

      const previous =
        travel.plan.steps[i - 1] ??
        null;
      if (
        previous?.type ===
        "local-journey" &&
        (
          previous.domainId !==
            matchedDirection.from.domainId ||
          previous.destinationNodeId !==
            matchedDirection.from.nodeId ||
          previous.destinationPosition.x !==
            matchedDirection.from.position.x ||
          previous.destinationPosition.y !==
            matchedDirection.from.position.y
        )
      ) {
        throw new Error(
          `${label} fresh plan local step before portal ${step.portalId} no longer matches portal entry`
        );
      }
    }

    const finalStep =
      travel.plan.steps.at(-1) ??
      null;
    if (
      finalStep?.type ===
      "local-journey" &&
      (
        finalStep.domainId !==
          travel.plan.resolvedTarget.domainId ||
        finalStep.destinationNodeId !==
          travel.plan.resolvedTarget.nodeId ||
        finalStep.destinationPosition.x !==
          travel.plan.resolvedTarget.position.x ||
        finalStep.destinationPosition.y !==
          travel.plan.resolvedTarget.position.y
      )
    ) {
      throw new Error(
        `${label} fresh plan final local step no longer matches resolved target`
      );
    }
    if (
      finalStep?.type ===
      "traverse-portal" &&
      (
        finalStep.toDomainId !==
          travel.plan.resolvedTarget.domainId ||
        finalStep.destinationPosition.x !==
          travel.plan.resolvedTarget.position.x ||
        finalStep.destinationPosition.y !==
          travel.plan.resolvedTarget.position.y
      )
    ) {
      throw new Error(
        `${label} fresh plan final portal step no longer matches resolved target`
      );
    }
  };

  const travelEntities = new Set();
  for (const travel of snapshot.activeTravels ?? []) {
    assertPersistedActiveTravelState(
      travel,
      "active travel"
    );
    assertFreshTravelReferences(
      travel,
      "active travel"
    );

    const key = idKey(travel.entityId);
    if (travelEntities.has(key)) {
      throw new Error(
        `duplicate active travel for ${String(travel.entityId)}`
      );
    }
    travelEntities.add(key);

    if (!occupancyEntities.has(key)) {
      throw new Error(
        `active travel entity ${String(travel.entityId)} is missing from snapshot occupancy`
      );
    }
  }

  for (let i = 0; i < (snapshot.pendingTravels ?? []).length; i += 1) {
    const pending = snapshot.pendingTravels[i];
    const pendingLabel =
      `snapshot.pendingTravels[${i}]`;
    assertOnlyKeys(
      pending,
      [
        "entityId",
        "target",
        "savedState",
        "restartError"
      ],
      pendingLabel
    );
    for (const key of [
      "entityId",
      "target",
      "savedState"
    ]) {
      if (!Object.hasOwn(pending, key)) {
        throw new Error(
          `${pendingLabel} is missing required field ${key}`
        );
      }
    }
    assertJsonSafe(pending, pendingLabel);
    assertId(
      pending.entityId,
      `${pendingLabel}.entityId`
    );
    assertTravelTarget(
      pending.target,
      `${pendingLabel}.target`
    );
    assertObject(
      pending.savedState,
      `${pendingLabel}.savedState`
    );
    if (
      pending.savedState.entityId !==
      pending.entityId
    ) {
      throw new Error(
        `${pendingLabel}.savedState entityId mismatch`
      );
    }
    if (
      canonicalStringify(
        pending.savedState.target
      ) !==
      canonicalStringify(
        pending.target
      )
    ) {
      throw new Error(
        `${pendingLabel}.savedState target mismatch`
      );
    }
    assertPersistedActiveTravelState(
      pending.savedState,
      `${pendingLabel}.savedState`
    );
    if (
      pending.savedState.planStale !==
      true
    ) {
      throw new Error(
        `${pendingLabel}.savedState.planStale must be true for retained pending travel`
      );
    }
    assertFreshTravelReferences(
      pending.savedState,
      `${pendingLabel}.savedState`
    );
    if (pending.restartError != null) {
      assertOnlyKeys(
        pending.restartError,
        ["name", "message"],
        `${pendingLabel}.restartError`
      );
      assertStringId(
        pending.restartError.name,
        `${pendingLabel}.restartError.name`
      );
      if (typeof pending.restartError.message !== "string") {
        throw new TypeError(
          `${pendingLabel}.restartError.message must be a string`
        );
      }
    }
  }

  return true;
}
