import { performance } from "node:perf_hooks";
import {
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore,
  validatePlaceCoreSnapshot,
  computePlaceCoreStateHash
} from "../src/index.js";

const count = Number(process.env.PLACE_COUNT ?? 50_000);

const places = new PlaceRegistry();
places.registerDefinition({
  id: "snapshot-house",
  layers: [{ spatialMode: "owned", id: "ground" }, { spatialMode: "owned", id: "cellar" }],
  spaces: [
    {
      id: "room",
      layerId: "ground",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
    },
    {
      id: "cellar",
      layerId: "cellar",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
    }
  ],
  portals: [{
    id: "stairs",
    a: { kind: "local", layerId: "ground", position: { x: 5, y: 5 } },
    b: { kind: "local", layerId: "cellar", position: { x: 5, y: 5 } }
  }]
});

for (let i = 0; i < count; i += 1) {
  places.createPlace({ id: `house-${i}`, definitionId: "snapshot-house" });
  if (i % 20 === 0) places.setPortalState(`house-${i}`, "stairs", { locked: true });
  if (i % 50 === 0) places.setSpaceState(`house-${i}`, "cellar", { enabled: false });
}

if (global.gc) global.gc();
const memoryBefore = process.memoryUsage();

let t = performance.now();
const snapshot = serializePlaceCore(places);
const serializeMs = performance.now() - t;

t = performance.now();
const json = JSON.stringify(snapshot);
const encodeMs = performance.now() - t;

t = performance.now();
const parsed = JSON.parse(json);
const parseMs = performance.now() - t;

t = performance.now();
validatePlaceCoreSnapshot(parsed);
const validateMs = performance.now() - t;

t = performance.now();
const restored = deserializePlaceCore(parsed);
const restoreMs = performance.now() - t;

t = performance.now();
const originalHash = computePlaceCoreStateHash(places);
const restoredHash = computePlaceCoreStateHash(restored);
const hashMs = performance.now() - t;

if (originalHash !== restoredHash) throw new Error("snapshot roundtrip state hash mismatch");
restored.assertInternalConsistency();

if (global.gc) global.gc();
const memoryAfter = process.memoryUsage();

console.log("=== place-core snapshot benchmark ===");
console.log(`instances: ${count.toLocaleString()}`);
console.log(`JSON size: ${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MiB`);
console.log(`serialize: ${serializeMs.toFixed(2)} ms`);
console.log(`JSON encode: ${encodeMs.toFixed(2)} ms`);
console.log(`JSON parse: ${parseMs.toFixed(2)} ms`);
console.log(`validate: ${validateMs.toFixed(2)} ms`);
console.log(`restore: ${restoreMs.toFixed(2)} ms`);
console.log(`hash both states: ${hashMs.toFixed(2)} ms`);
console.log(`post-GC heap delta: ${((memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024).toFixed(2)} MiB`);
