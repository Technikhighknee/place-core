import {
  PerformanceObserver,
  performance
} from "node:perf_hooks";

import {
  startTravel
} from "../src/index.js";

import {
  addLuebeckTraveler,
  buildLuebeckScenario,
  stepScenario
} from "../test/support/luebeck-scenario.js";

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number > 0`);
  }
  return value;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index];
}

function heapMiB() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

const travelerCount =
  positiveInteger("LUEBECK_TRAVELERS", 2000);
const queryCount =
  positiveInteger("LUEBECK_QUERY_COUNT", 50000);
const maxTicks =
  positiveInteger("LUEBECK_MAX_TICKS", 1200);
const deltaSeconds =
  Number(process.env.LUEBECK_DELTA_SECONDS ?? 1);

if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
  throw new RangeError(
    "LUEBECK_DELTA_SECONDS must be a finite number > 0"
  );
}

let gcEvents = 0;
let gcDurationMs = 0;
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcEvents += 1;
    gcDurationMs += entry.duration;
  }
});
gcObserver.observe({ entryTypes: ["gc"] });

const scenario = buildLuebeckScenario({
  captureEvents: false
});
const {
  world,
  navigation,
  places,
  houses,
  tavern
} = scenario;

for (let i = 45; i < 50; i += 1) {
  places.setPortalState(
    `house-${i}`,
    "bedroom-door",
    { locked: true }
  );
}

const sparseDiagnostics =
  navigation.getDiagnostics();
if (sparseDiagnostics.overriddenDomainCount !== 5 ||
    sparseDiagnostics.overrideEffectCount !== 5) {
  throw new Error(
    `expected five sparse per-domain overrides, got ${JSON.stringify(sparseDiagnostics)}`
  );
}

const portalDomain =
  houses[17].layerDomains.get("upper");

let checksum = 0;
let started = performance.now();
for (let i = 0; i < queryCount; i += 1) {
  const hit = places.findNearestPortal(
    portalDomain,
    {
      x: 6.5 + (i % 3) * 0.01,
      y: 0
    },
    { traversableOnly: false }
  );
  if (hit) checksum += hit.portal.id.length;
}
const portalLookupMs =
  performance.now() - started;

started = performance.now();
for (let i = 0; i < queryCount; i += 1) {
  const houseIndex = i % 45;
  const location = places.locate(
    houses[houseIndex].layerDomains.get("upper"),
    {
      x: (i & 1) === 0 ? 10 : 4,
      y: 0
    }
  );
  checksum += location.semanticPlaces.length;
}
const locateMs =
  performance.now() - started;

if (global.gc) global.gc();
const heapBeforeTravelMiB = heapMiB();

started = performance.now();
for (let i = 0; i < travelerCount; i += 1) {
  const id =
    `traveler-${String(i).padStart(6, "0")}`;
  const houseIndex = i % 45;
  addLuebeckTraveler(
    scenario,
    id,
    houseIndex
  );
  const state = startTravel(
    places,
    scenario.bridge,
    id,
    {
      placeId: "golden-goose",
      anchorId: "barrel"
    },
    {
      worldChangePolicy: "eager"
    }
  );
  if (!state) {
    throw new Error(
      `failed to start travel for ${id}`
    );
  }
}
const planningMs =
  performance.now() - started;

const tickDurations = [];
let replanTickMs = 0;
let replanCount = 0;
let tick = 0;

while (places.activeTravels.size > 0 &&
       tick < maxTicks) {
  if (tick === 5) {
    places.setPortalState(
      "golden-goose",
      "cellar-main",
      { locked: true }
    );
  }

  const tickStarted = performance.now();
  stepScenario(scenario, deltaSeconds);
  const elapsed = performance.now() - tickStarted;
  tickDurations.push(elapsed);

  if (tick === 5) {
    replanTickMs = elapsed;
    replanCount =
      [...places.activeTravels.values()]
        .filter((state) => state.replans > 0)
        .length;
  }

  tick += 1;
}

if (places.activeTravels.size !== 0) {
  throw new Error(
    `${places.activeTravels.size} travels still active after ${maxTicks} ticks`
  );
}

const targetDomain =
  tavern.layerDomains.get("cellar");
let completedAtTarget = 0;
for (let i = 0; i < travelerCount; i += 1) {
  const id =
    `traveler-${String(i).padStart(6, "0")}`;
  const entity = world.getEntity(id);
  if (entity?.domainId === targetDomain &&
      Math.abs(entity.position.x - 4) < 1e-6 &&
      Math.abs(entity.position.y) < 1e-6) {
    completedAtTarget += 1;
  }
}

if (completedAtTarget !== travelerCount) {
  throw new Error(
    `only ${completedAtTarget}/${travelerCount} travelers reached the barrel`
  );
}

if (replanCount !== travelerCount) {
  throw new Error(
    `expected ${travelerCount} eager replans after cellar lock, got ${replanCount}`
  );
}

places.assertInternalConsistency();
navigation.assertInternalConsistency();
world.assertInternalConsistency();

if (global.gc) global.gc();
await new Promise((resolve) => setImmediate(resolve));
const heapAfterTravelMiB = heapMiB();
gcObserver.disconnect();

const sortedTicks =
  [...tickDurations].sort((a, b) => a - b);
const finalNavigationDiagnostics =
  navigation.getDiagnostics();
const metrics = {
  travelerCount,
  ticks: tick,
  deltaSeconds,
  planningMs,
  planningPerSecond:
    travelerCount / (planningMs / 1000),
  replanCount,
  replanTickMs,
  replansPerSecond:
    replanCount / (replanTickMs / 1000),
  tickMs: {
    p50: percentile(sortedTicks, 0.50),
    p95: percentile(sortedTicks, 0.95),
    p99: percentile(sortedTicks, 0.99),
    max: sortedTicks.at(-1) ?? 0
  },
  portalLookup: {
    queries: queryCount,
    totalMs: portalLookupMs,
    queriesPerSecond:
      queryCount / (portalLookupMs / 1000)
  },
  semanticLocate: {
    queries: queryCount,
    totalMs: locateMs,
    queriesPerSecond:
      queryCount / (locateMs / 1000)
  },
  heapMiB: {
    beforeTravel: heapBeforeTravelMiB,
    afterTravel: heapAfterTravelMiB,
    delta: heapAfterTravelMiB - heapBeforeTravelMiB
  },
  gc: {
    events: gcEvents,
    durationMs: gcDurationMs
  },
  topologyCount:
    finalNavigationDiagnostics.topologyCount,
  boundDomainCount:
    finalNavigationDiagnostics.boundDomainCount,
  overriddenDomainCount:
    finalNavigationDiagnostics.overriddenDomainCount,
  overrideEffectCount:
    finalNavigationDiagnostics.overrideEffectCount,
  placeDiagnostics: places.getDiagnostics(),
  checksum
};

console.log(
  "=== Lübeck integrated travel workload ==="
);
console.log(
  JSON.stringify(metrics, null, 2)
);

const limits = {
  minPlanningPerSecond: positiveNumber(
    "LUEBECK_MIN_PLANNING_PER_SECOND",
    1500
  ),
  minReplansPerSecond: positiveNumber(
    "LUEBECK_MIN_REPLANS_PER_SECOND",
    2000
  ),
  maxTickP95Ms: positiveNumber(
    "LUEBECK_MAX_TICK_P95_MS",
    100
  ),
  maxTickP99Ms: positiveNumber(
    "LUEBECK_MAX_TICK_P99_MS",
    250
  ),
  maxTickMs: positiveNumber(
    "LUEBECK_MAX_TICK_MS",
    1000
  ),
  minPortalQueriesPerSecond: positiveNumber(
    "LUEBECK_MIN_PORTAL_QUERIES_PER_SECOND",
    250000
  ),
  minLocateQueriesPerSecond: positiveNumber(
    "LUEBECK_MIN_LOCATE_QUERIES_PER_SECOND",
    50000
  ),
  maxHeapDeltaMiB: positiveNumber(
    "LUEBECK_MAX_HEAP_DELTA_MIB",
    128
  )
};

const failures = [];
if (metrics.planningPerSecond < limits.minPlanningPerSecond) {
  failures.push(
    `planning ${metrics.planningPerSecond.toFixed(0)}/s < ${limits.minPlanningPerSecond}/s`
  );
}
if (metrics.replansPerSecond < limits.minReplansPerSecond) {
  failures.push(
    `replans ${metrics.replansPerSecond.toFixed(0)}/s < ${limits.minReplansPerSecond}/s`
  );
}
if (metrics.tickMs.p95 > limits.maxTickP95Ms) {
  failures.push(
    `tick p95 ${metrics.tickMs.p95.toFixed(1)}ms > ${limits.maxTickP95Ms}ms`
  );
}
if (metrics.tickMs.p99 > limits.maxTickP99Ms) {
  failures.push(
    `tick p99 ${metrics.tickMs.p99.toFixed(1)}ms > ${limits.maxTickP99Ms}ms`
  );
}
if (metrics.tickMs.max > limits.maxTickMs) {
  failures.push(
    `tick max ${metrics.tickMs.max.toFixed(1)}ms > ${limits.maxTickMs}ms`
  );
}
if (metrics.portalLookup.queriesPerSecond <
    limits.minPortalQueriesPerSecond) {
  failures.push(
    `portal lookup ${metrics.portalLookup.queriesPerSecond.toFixed(0)}/s < ${limits.minPortalQueriesPerSecond}/s`
  );
}
if (metrics.semanticLocate.queriesPerSecond <
    limits.minLocateQueriesPerSecond) {
  failures.push(
    `semantic locate ${metrics.semanticLocate.queriesPerSecond.toFixed(0)}/s < ${limits.minLocateQueriesPerSecond}/s`
  );
}
if (metrics.heapMiB.delta > limits.maxHeapDeltaMiB) {
  failures.push(
    `heap delta ${metrics.heapMiB.delta.toFixed(1)}MiB > ${limits.maxHeapDeltaMiB}MiB`
  );
}

if (failures.length) {
  throw new Error(
    `Lübeck integrated guardrail failure:\n- ${failures.join("\n- ")}`
  );
}
