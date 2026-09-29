import {
  assertId,
  assertStringId,
  cloneJson,
  normalizeBoolean
} from "../utils.js";

function assertPlainObject(value, label) {
  if (!value ||
      typeof value !== "object" ||
      Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertAllowedKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown field ${key}`);
    }
  }
}

function assertOptionalStringId(value, label) {
  if (value == null) return null;
  assertStringId(value, label);
  return value;
}

export function validateTravelTarget(target) {
  assertPlainObject(target, "travel target");

  if (target.kind != null) {
    if (target.kind !== "nearest") {
      throw new TypeError(
        'travel target.kind must be "nearest"'
      );
    }
    assertAllowedKeys(
      target,
      ["kind", "tag", "anchorKind", "placeId", "spaceId"],
      "nearest travel target"
    );
    assertStringId(target.tag, "nearest travel target.tag");
    assertOptionalStringId(
      target.anchorKind,
      "nearest travel target.anchorKind"
    );
    if (target.placeId != null) {
      assertId(target.placeId, "nearest travel target.placeId");
    }
    assertOptionalStringId(
      target.spaceId,
      "nearest travel target.spaceId"
    );
    return target;
  }

  if (target.domainId != null || target.position != null) {
    assertAllowedKeys(
      target,
      [
        "domainId",
        "position",
        "nodeId",
        "placeId",
        "anchorId",
        "spaceId",
        "layerId"
      ],
      "direct travel target"
    );
    assertStringId(target.domainId, "direct travel target.domainId");
    if (!target.position ||
        typeof target.position !== "object" ||
        Array.isArray(target.position) ||
        !Number.isFinite(target.position.x) ||
        !Number.isFinite(target.position.y)) {
      throw new TypeError(
        "direct travel target.position must be a finite Vec2"
      );
    }
    assertOptionalStringId(
      target.nodeId,
      "direct travel target.nodeId"
    );
    if (target.placeId != null) {
      assertId(target.placeId, "direct travel target.placeId");
    }
    assertOptionalStringId(
      target.anchorId,
      "direct travel target.anchorId"
    );
    assertOptionalStringId(
      target.spaceId,
      "direct travel target.spaceId"
    );
    assertOptionalStringId(
      target.layerId,
      "direct travel target.layerId"
    );
    return target;
  }

  assertAllowedKeys(
    target,
    ["placeId", "anchorId", "spaceId"],
    "place travel target"
  );
  assertId(target.placeId, "place travel target.placeId");
  assertOptionalStringId(
    target.anchorId,
    "place travel target.anchorId"
  );
  assertOptionalStringId(
    target.spaceId,
    "place travel target.spaceId"
  );
  return target;
}

function normalizeWorldChangePolicy(value) {
  const policy = value ?? "encounter";
  if (policy !== "encounter" && policy !== "eager") {
    throw new TypeError("worldChangePolicy must be \"encounter\" or \"eager\"");
  }
  return policy;
}

function normalizePortalEntryTolerance(value) {
  const tolerance = value ?? 0.25;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("portalEntryTolerance must be a finite number >= 0");
  }
  return tolerance;
}

function normalizeStringIterable(value, label) {
  if (value == null) return Object.freeze([]);
  if (typeof value === "string" ||
      typeof value?.[Symbol.iterator] !== "function") {
    throw new TypeError(
      `${label} must be an iterable of non-empty strings`
    );
  }

  const result = [];
  const seen = new Set();
  let index = 0;
  for (const item of value) {
    assertStringId(item, `${label}[${index}]`);
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
    index += 1;
  }
  return Object.freeze(result);
}

function assertTravelOptionKeys(options, allowed, label) {
  assertPlainObject(options, label);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(options)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${label} contains unknown field ${key}`);
    }
  }
}

export function normalizeDomainPathOptions(options = {}) {
  assertTravelOptionKeys(
    options,
    ["excludedPortalKeys", "excludedDomainPairs"],
    "domain path options"
  );
  return {
    excludedPortalKeys: new Set(
      normalizeStringIterable(
        options.excludedPortalKeys,
        "excludedPortalKeys"
      )
    ),
    excludedPairs: new Set(
      normalizeStringIterable(
        options.excludedDomainPairs,
        "excludedDomainPairs"
      )
    )
  };
}

function normalizePositiveInteger(value, label, defaultValue) {
  const normalized = value ?? defaultValue;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return normalized;
}

function normalizeMaxCost(value) {
  if (value === undefined) return Infinity;
  if (value === Infinity) return Infinity;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("maxCost must be a finite number >= 0 or Infinity");
  }
  return value;
}

function normalizeDeltaSeconds(value, defaultValue = 0) {
  const normalized = value ?? defaultValue;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new RangeError("deltaSeconds must be a finite number >= 0");
  }
  return normalized;
}

export function normalizePlanningOptions(options = {}) {
  assertTravelOptionKeys(
    options,
    [
      "bridge",
      "journeyOptions",
      "excludedPortalKeys",
      "excludedDomainPairs",
      "maxDomainPathAttempts",
      "maxShortestDomainPaths",
      "allowPartialShortestPathSearch",
      "maxConcreteStatesPerLayer",
      "maxNearestTargetExpansions",
      "maxCost",
      "anchorPredicate",
      "worldChangePolicy",
      "portalEntryTolerance"
    ],
    "travel options"
  );

  if (options.bridge != null &&
      typeof options.bridge !== "object") {
    throw new TypeError("travel options.bridge must be an object");
  }
  if (options.anchorPredicate != null &&
      typeof options.anchorPredicate !== "function") {
    throw new TypeError("anchorPredicate must be a function");
  }

  const normalized = {
    ...options,
    excludedPortalKeys: normalizeStringIterable(
      options.excludedPortalKeys,
      "excludedPortalKeys"
    ),
    excludedDomainPairs: normalizeStringIterable(
      options.excludedDomainPairs,
      "excludedDomainPairs"
    ),
    maxDomainPathAttempts: normalizePositiveInteger(
      options.maxDomainPathAttempts,
      "maxDomainPathAttempts",
      32
    ),
    maxShortestDomainPaths: normalizePositiveInteger(
      options.maxShortestDomainPaths,
      "maxShortestDomainPaths",
      32
    ),
    allowPartialShortestPathSearch: normalizeBoolean(
      options.allowPartialShortestPathSearch,
      "allowPartialShortestPathSearch",
      { defaultValue: false }
    ),
    maxConcreteStatesPerLayer: normalizePositiveInteger(
      options.maxConcreteStatesPerLayer,
      "maxConcreteStatesPerLayer",
      128
    ),
    maxNearestTargetExpansions: normalizePositiveInteger(
      options.maxNearestTargetExpansions,
      "maxNearestTargetExpansions",
      250_000
    ),
    maxCost: normalizeMaxCost(options.maxCost),
    worldChangePolicy: normalizeWorldChangePolicy(
      options.worldChangePolicy
    ),
    portalEntryTolerance: normalizePortalEntryTolerance(
      options.portalEntryTolerance
    )
  };

  return normalized;
}

export function validatePersistedTravelOptions(
  options,
  label = "travel options"
) {
  assertPlainObject(options, label);
  assertTravelOptionKeys(
    options,
    [
      "journeyOptions",
      "excludedPortalKeys",
      "excludedDomainPairs",
      "maxDomainPathAttempts",
      "maxShortestDomainPaths",
      "allowPartialShortestPathSearch",
      "maxConcreteStatesPerLayer",
      "maxNearestTargetExpansions",
      "maxCost",
      "worldChangePolicy",
      "portalEntryTolerance"
    ],
    label
  );

  for (const key of [
    "excludedPortalKeys",
    "excludedDomainPairs"
  ]) {
    if (options[key] == null) continue;
    if (!Array.isArray(options[key])) {
      throw new TypeError(
        `${label}.${key} must be an array`
      );
    }
  }

  if (options.journeyOptions !== undefined) {
    cloneJson(options.journeyOptions);
  }

  if (options.maxCost !== undefined &&
      !Number.isFinite(options.maxCost)) {
    throw new RangeError(
      `${label}.maxCost must be a finite number >= 0`
    );
  }

  normalizePlanningOptions(options);
  return options;
}

export function validateStepOptionsInput(options = {}) {
  assertTravelOptionKeys(
    options,
    [
      "bridge",
      "journeyOptions",
      "excludedPortalKeys",
      "excludedDomainPairs",
      "maxDomainPathAttempts",
      "maxShortestDomainPaths",
      "allowPartialShortestPathSearch",
      "maxConcreteStatesPerLayer",
      "maxNearestTargetExpansions",
      "maxCost",
      "anchorPredicate",
      "worldChangePolicy",
      "portalEntryTolerance",
      "deltaSeconds"
    ],
    "travel step options"
  );

  const {
    deltaSeconds,
    ...planningInput
  } = options;

  // Validate all planning overrides without using the resulting defaults.
  normalizePlanningOptions(planningInput);
  if (deltaSeconds !== undefined) {
    normalizeDeltaSeconds(deltaSeconds);
  }

  return options;
}

export function normalizeEffectiveStepOptions(options = {}) {
  validateStepOptionsInput(options);

  const {
    deltaSeconds,
    ...planningInput
  } = options;

  return {
    ...normalizePlanningOptions(planningInput),
    deltaSeconds: normalizeDeltaSeconds(deltaSeconds)
  };
}

export function normalizeStopOptions(options = {}) {
  assertTravelOptionKeys(
    options,
    ["bridge", "reason"],
    "stop travel options"
  );

  if (options.bridge != null &&
      typeof options.bridge !== "object") {
    throw new TypeError(
      "stop travel options.bridge must be an object"
    );
  }
  if (options.reason != null) {
    assertStringId(options.reason, "stop travel options.reason");
  }

  return {
    bridge: options.bridge ?? null,
    reason: options.reason ?? "cancelled"
  };
}

export function captureTravelOptions(options = {}) {
  const normalized = normalizePlanningOptions(options);
  const captured = {
    worldChangePolicy: normalizeWorldChangePolicy(normalized.worldChangePolicy),
    portalEntryTolerance: normalizePortalEntryTolerance(
      normalized.portalEntryTolerance
    )
  };

  if (normalized.journeyOptions !== undefined) {
    captured.journeyOptions = cloneJson(normalized.journeyOptions);
  }
  if (options.excludedPortalKeys !== undefined) {
    captured.excludedPortalKeys = normalized.excludedPortalKeys;
  }
  if (options.excludedDomainPairs !== undefined) {
    captured.excludedDomainPairs = normalized.excludedDomainPairs;
  }

  for (const key of [
    "maxDomainPathAttempts",
    "maxShortestDomainPaths",
    "allowPartialShortestPathSearch",
    "maxConcreteStatesPerLayer",
    "maxNearestTargetExpansions"
  ]) {
    if (options[key] !== undefined) captured[key] = normalized[key];
  }

  if (options.maxCost !== undefined && normalized.maxCost !== Infinity) {
    captured.maxCost = normalized.maxCost;
  }

  if (normalized.anchorPredicate !== undefined) {
    captured.anchorPredicate = normalized.anchorPredicate;
  }

  return Object.freeze(captured);
}

export function effectiveTravelOptions(state, runtimeOptions = {}) {
  return {
    ...(state.options ?? {
      worldChangePolicy: state.worldChangePolicy ?? "encounter",
      portalEntryTolerance: 0.25
    }),
    ...runtimeOptions
  };
}
