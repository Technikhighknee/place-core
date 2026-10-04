import { performance } from "node:perf_hooks";
import {
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore,
  validatePlaceCoreSnapshot
} from "../src/index.js";

const fast = process.env.GUARDRAIL_FAST === "1";
const count = Number(process.env.GUARDRAIL_COUNT ?? (fast ? 5_000 : 25_000));
const queryCount = Number(process.env.GUARDRAIL_QUERIES ?? (fast ? 20_000 : 100_000));
const mutationCount = Number(process.env.GUARDRAIL_MUTATIONS ?? (fast ? 10_000 : 50_000));

const limits = {
  createMs: Number(process.env.GUARDRAIL_CREATE_MS ?? (fast ? 8_000 : 20_000)),
  locateMs: Number(process.env.GUARDRAIL_LOCATE_MS ?? (fast ? 8_000 : 20_000)),
  mutationMs: Number(process.env.GUARDRAIL_MUTATION_MS ?? (fast ? 8_000 : 20_000)),
  validateMs: Number(process.env.GUARDRAIL_VALIDATE_MS ?? (fast ? 4_000 : 10_000)),
  restoreMs: Number(process.env.GUARDRAIL_RESTORE_MS ?? (fast ? 12_000 : 30_000)),
  jsonMiB: Number(process.env.GUARDRAIL_JSON_MIB ?? 128),
  heapMiB: Number(process.env.GUARDRAIL_HEAP_MIB ?? 768)
};

const places = new PlaceRegistry();
places.registerDefinition({
  id: "guardrail-place",
  layers: [{ id: "ground" }, { id: "cellar" }],
  spaces: [
    {
      id: "whole",
      layerId: "ground",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 20, maxY: 20 }
    },
    {
      id: "room-a",
      layerId: "ground",
      parentSpaceId: "whole",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 20 }
    },
    {
      id: "room-b",
      layerId: "ground",
      parentSpaceId: "whole",
      geometry: { type: "aabb", minX: 10, minY: 0, maxX: 20, maxY: 20 }
    },
    {
      id: "cellar",
      layerId: "cellar",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 20, maxY: 20 }
    }
  ],
  portals: [{
    id: "stairs",
    a: { kind: "local", layerId: "ground", position: { x: 15, y: 10 } },
    b: { kind: "local", layerId: "cellar", position: { x: 5, y: 10 } }
  }]
});

let t = performance.now();
for (let i = 0; i < count; i += 1) {
  places.createPlace({ id: `p-${i}`, definitionId: "guardrail-place" });
}
const createMs = performance.now() - t;

t = performance.now();
let checksum = 0;
for (let i = 0; i < queryCount; i += 1) {
  const id = i % count;
  checksum += places.locate(
    `p-${id}:ground`,
    { x: i % 20, y: (i * 7) % 20 }
  ).spaces.length;
}
const locateMs = performance.now() - t;

t = performance.now();
for (let i = 0; i < mutationCount; i += 1) {
  places.setPortalState(
    `p-${i % count}`,
    "stairs",
    { locked: (i & 1) === 0 }
  );
}
const mutationMs = performance.now() - t;

const snapshot = serializePlaceCore(places);
const json = JSON.stringify(snapshot);
const jsonMiB = Buffer.byteLength(json) / 1024 / 1024;
const parsed = JSON.parse(json);

t = performance.now();
validatePlaceCoreSnapshot(parsed);
const validateMs = performance.now() - t;

t = performance.now();
const restored = deserializePlaceCore(parsed);
const restoreMs = performance.now() - t;
restored.assertInternalConsistency();

if (global.gc) global.gc();
const heapMiB = process.memoryUsage().heapUsed / 1024 / 1024;

const metrics = {
  count,
  queryCount,
  mutationCount,
  createMs,
  locateMs,
  mutationMs,
  validateMs,
  restoreMs,
  jsonMiB,
  heapMiB,
  checksum
};

console.log("=== place-core regression guardrails ===");
console.log(JSON.stringify(metrics, null, 2));

const failures = [];
if (createMs > limits.createMs) failures.push(`create ${createMs.toFixed(0)}ms > ${limits.createMs}ms`);
if (locateMs > limits.locateMs) failures.push(`locate ${locateMs.toFixed(0)}ms > ${limits.locateMs}ms`);
if (mutationMs > limits.mutationMs) failures.push(`mutation ${mutationMs.toFixed(0)}ms > ${limits.mutationMs}ms`);
if (validateMs > limits.validateMs) failures.push(`validation ${validateMs.toFixed(0)}ms > ${limits.validateMs}ms`);
if (restoreMs > limits.restoreMs) failures.push(`restore ${restoreMs.toFixed(0)}ms > ${limits.restoreMs}ms`);
if (jsonMiB > limits.jsonMiB) failures.push(`snapshot ${jsonMiB.toFixed(1)}MiB > ${limits.jsonMiB}MiB`);
if (heapMiB > limits.heapMiB) failures.push(`heap ${heapMiB.toFixed(1)}MiB > ${limits.heapMiB}MiB`);

if (failures.length) {
  throw new Error(`place-core guardrail failure:\n- ${failures.join("\n- ")}`);
}
