# place-core

A semantic place, structure, occupancy and cross-domain travel core for large simulations.

`world-core` answers **where something physically is and how it moves through metric space**. `place-core` answers **what that location means, how places are structured, how spatial domains connect, and how an entity travels to a semantic destination across them**.

There is no player, camera, loaded-area or distance-based simulation-fidelity concept in the core.

## Model

A place definition is immutable shared structure. A place instance is a concrete occurrence with identity, domain bindings, attachments, placement and sparse deviations.

```text
PlaceDefinition: small-tavern          PlaceInstance: golden-goose
├── ground                             ├── definition → small-tavern
│   ├── taproom                        ├── ground → golden-goose:ground
│   ├── kitchen                        ├── cellar → golden-goose:cellar
│   └── front-door                     ├── street attachment → luebeck
├── cellar                             └── sparse overrides
└── anchors                                └── cellar-door.locked = true
```

First-class concepts:

- **PlaceDefinition** — reusable immutable blueprint.
- **PlaceInstance** — concrete occurrence with sparse mutable state.
- **SpatialLayer** — a metric layer that explicitly either owns a `world-core` domain or is embedded into an existing one.
- **Space** — semantic region such as room, hall, courtyard, deck or cellar.
- **Boundary** — wall, fence, partition or other separator.
- **Portal** — door, gate, stairs, ladder, hatch, bridge, gangplank or breach.
- **Anchor** — semantic target such as bed, counter, exit, forge or storage position.
- **Placement** — exterior transform of a place; interiors keep stable local coordinates.
- **Attachment** — a resolved connection from an external portal slot to another domain.

A room is deliberately **not** a domain. Several rooms usually occupy one continuous layer/domain.

### Structural containment, semantic membership and placement

Place-Core deliberately keeps three relationships separate:

- `parentId` is the **primary semantic containment chain**. It gives a stable, single-parent hierarchy for answers such as city → quarter → parcel → tavern.
- `memberships` form an **acyclic semantic DAG**. A tavern can simultaneously belong to a market district, tax jurisdiction, legal ward, guild precinct or any other overlapping place relation without inventing another physical position.
- `placement.parentPlaceId` is the **transform parent** used only for nested moving coordinate frames. It remains single-parent because a transform must have one unambiguous frame.

```js
places.createPlace({
  id: "golden-goose",
  definitionId: "small-tavern",
  parentId: "parcel-17",
  memberships: [
    {
      parentPlaceId: "market-quarter",
      kind: "district"
    },
    {
      parentPlaceId: "tax-ward-3",
      kind: "tax-jurisdiction"
    }
  ]
});
```

`locate()` returns both views:

- `places` — the stable primary containment chain.
- `semanticPlaces` — the deterministic, deduplicated transitive closure of the full semantic DAG.

Occupancy and `place-enter` / `place-leave` events use `semanticPlaces`, so membership changes propagate immediately even when an entity does not physically move. Mixed cycles across `parentId` and `memberships` are rejected.

## Shared definitions and navigation

```js
import { compilePlace } from "place-core";

const house = compilePlace({
  id: "small-house",
  defaultAnchorId: "bed",

  layers: [{
    id: "ground",
    spatialMode: "owned",
    navigation: {
      nodes: [
        { id: "front", x: 0, y: 5 },
        { id: "bed", x: 8, y: 5 }
      ],
      roads: [
        { id: "hall", from: "front", to: "bed", width: 2 }
      ]
    }
  }],

  spaces: [{
    id: "room",
    layerId: "ground",
    geometry: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 10
    },
    defaultAnchorId: "bed"
  }],

  portals: [{
    id: "front-door",
    a: { kind: "external", slot: "street" },
    b: {
      kind: "local",
      layerId: "ground",
      spaceId: "room",
      position: { x: 0, y: 5 },
      nodeId: "front"
    }
  }],

  anchors: [{
    id: "bed",
    layerId: "ground",
    spaceId: "room",
    position: { x: 8, y: 5 },
    nodeId: "bed",
    tags: ["sleep"]
  }]
});
```

Navigation declared by an `owned` layer becomes one shared `world-core` topology per definition layer. Thousands of place instances bind their owned domains to the same topology instead of cloning nodes, roads, static indexes and route caches.

Compilation validates IDs, containment cycles, portal/anchor references and embedded navigation references. Definitions receive a canonical content hash.

## Spatial ownership modes

Every spatial layer declares its ownership mode explicitly:

- `spatialMode: "owned"` means the place owns a dedicated world-core domain. This is the normal model for interiors, decks and other local coordinate spaces.
- `spatialMode: "embedded"` means the layer lives directly inside an existing world-core domain. This is for open places such as marketplaces, parks, yards, fields and harbor areas.

Embedded layers require an explicit `layerDomains` host binding when an instance is created. They do not create, adopt, topology-bind or remove that host domain, and multiple embedded places may share the same domain.

An embedded layer does not define its own navigation topology. Its spaces, boundaries and anchors are authored in place-local coordinates and projected through the instance placement into host-domain coordinates.

```js
const market = compilePlace({
  id: "marketplace",
  layers: [{
    id: "market",
    spatialMode: "embedded"
  }],
  spaces: [{
    id: "market-square",
    layerId: "market",
    geometry: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 20,
      maxY: 14
    }
  }],
  anchors: [{
    id: "food-stall",
    layerId: "market",
    spaceId: "market-square",
    position: { x: 4, y: 5 }
  }]
});

places.createPlace({
  id: "luebeck-market",
  definitionId: "marketplace",
  layerDomains: {
    market: "luebeck"
  },
  embeddedNodeBindings: {
    anchors: {
      "food-stall": "market-food"
    }
  },
  placement: {
    domainId: "luebeck",
    containment: "footprint",
    transform: {
      x: 120,
      y: 80,
      rotation: 0,
      scale: 1
    }
  }
});
```

Host navigation nodes are instance-specific. Embedded definitions therefore do not hard-code `nodeId` values. A concrete place instance supplies `embeddedNodeBindings` for anchors or portal endpoints that should be routable in its host domain. The bridge validates that each bound node exists and that its host position exactly matches the transformed semantic position. Unbound anchors remain valid semantic targets for queries but are not independently routable.

## world-core integration

```js
import {
  World,
  Navigation,
  NavigationRegistry,
  startJourney,
  stopJourney
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge
} from "place-core";

const world = new World({ domains: [{ id: "luebeck" }] });
const navigation = new NavigationRegistry();

const bridge = new WorldCoreBridge({
  world,
  navigation,
  startJourney,
  stopJourney,
  Navigation
});

const places = new PlaceRegistry({ bridge });
places.registerDefinition(house);

places.createPlace({
  id: "house-17",
  definitionId: "small-house",
  attachments: {
    street: {
      domainId: "luebeck",
      position: { x: 120, y: 80 },
      nodeId: "house-17-door"
    }
  }
});
```

Creating an instance can create its `world-core` domains, register its shared topologies once, bind those domains and apply instance-local road effects.

`WorldCoreBridge` requires the live `World.subscribeEvents()` observer API. This lets same-domain structural crossings such as room-to-room doors emit semantic portal events even when the bounded world-core event capture queue is disabled.

By default, Place-Core refuses to materialize into a world-core domain that already exists. `existingDomainPolicy: "adopt"` is an explicit ownership transfer: the compatible existing domain becomes Place-Core-owned for that place and normal `removePlace()` cleanup may unbind and remove it. It is not a temporary borrow mode.

## Sparse structural state

```js
places.setPortalState("house-17", "front-door", {
  locked: true
});

places.setBoundaryState("house-17", "west-wall", {
  enabled: false
});

places.setSpaceState("house-17", "collapsed-room", {
  enabled: false
});
```

Returning a property to its definition value removes the sparse override again.

Portals and boundaries can bind to `world-core` roads. A locked door can block an instance-local road; destroying a prepared boundary can remove the corresponding road effect without cloning or mutating the shared topology.

Dynamic instance portals support sparse structural changes such as breaches, temporary passages and gangplanks:

```js
places.addPortal("house-17", {
  id: "breach-west",
  kind: "breach",
  a: {
    domainId: "house-17:ground",
    position: { x: 10, y: 5 }
  },
  b: {
    domainId: "luebeck",
    position: { x: 125, y: 80 }
  }
});
```

The domain→portal index is updated atomically when portal state, attachments or dynamic structure change.

## Location and occupancy

Physical position remains authoritative in `world-core`. `place-core` derives semantic context:

```js
const context = places.locate(
  "golden-goose:ground",
  { x: 8, y: 7 }
);

// context.placeId
// context.layerId
// context.spaces
// context.deepestSpace

places.updateEntityOccupancy(world.getEntity("hans"));

places.entitiesInPlace("golden-goose");
places.entitiesInSpace("golden-goose", "taproom");
```

Nested place and space membership is indexed separately from physical position. Event capture is opt-in and bounded. It can emit deterministic structural/location/travel events including:

```text
place-enter / place-leave
space-enter / space-leave
portal-enter / portal-traverse / portal-exit
travel-start / travel-replan / travel-complete / travel-failed
```

## Global semantic travel

A caller targets meaning rather than manually stitching domain transitions:

```js
import {
  startTravel,
  stepPlaceSimulation
} from "place-core";

startTravel(
  places,
  "hans",
  {
    placeId: "golden-goose",
    anchorId: "barrel"
  }
);

stepSimulation(world, navigation, deltaSeconds);
stepPlaceSimulation(places, { deltaSeconds });
```

The explicit bridge form is also supported:

```js
startTravel(
  places,
  bridge,
  "hans",
  { placeId: "golden-goose", spaceId: "cellar" }
);

stepPlaceSimulation(places, bridge, deltaSeconds);
```

A plan is composed from:

```text
local world-core journey
→ portal traversal
→ local world-core journey
→ portal traversal
→ ...
→ semantic target anchor
```

Planning is hierarchical rather than one giant A* over every interior node:

1. Build the reachable semantic domain structure from indexed portal transitions.
2. Consider all topologically shortest domain paths.
3. Optimize concrete portal choices using actual local `world-core` route costs.
4. Keep deterministic alternatives and fall back to longer semantic detours if shortest paths are locally unroutable.
5. Assemble executable local-journey and portal-traversal steps.

Portal `transitionCost` contributes to planning cost and execution time. Structural graph revisions invalidate active plans and trigger deterministic replanning. If no route remains, travel fails instead of following stale topology.

## Moving places

Exterior placement is independent from stable interior coordinate frames:

```js
places.setPlacement("cog-hildegard", {
  domainId: "luebeck-harbor",
  transform: {
    x: 500,
    y: 220,
    rotation: 0.7
  },
  containment: "footprint"
});
```

A ship, wagon or other moving place can move externally while occupants retain local coordinates inside its domains. Exterior footprint queries are reindexed when placement changes. `setAttachment()` can reconnect entrances such as gangplanks.

## Save/load, validation and determinism

Snapshots are self-contained:

```js
import {
  serializePlaceCore,
  deserializePlaceCore,
  validatePlaceCoreSnapshot,
  computePlaceCoreStateHash
} from "place-core";

const snapshot = serializePlaceCore(places);
validatePlaceCoreSnapshot(snapshot);

const restored = deserializePlaceCore(snapshot);
```

Each shared definition blueprint is stored **once per snapshot**, with its canonical content hash. Instances still store only their sparse state. Selectively tracked occupancy is persisted as entity identity plus physical domain/position; semantic place/space memberships are rebuilt from the restored structure.

Standalone restore uses that persisted occupancy directly. With a bridge and `resumeWorldCoreState: true`, the restored `world-core` entity state must match it exactly. With a bridge but without resume semantics, the saved identity set is preserved selectively while current domain/position is re-derived from live `world-core`; missing entities do not survive as ghost occupancy.

Validation recompiles and hashes definitions before restore and checks:

- definition hashes
- duplicate IDs/domains
- hierarchy references and cycles
- sparse override references
- dynamic portal endpoints
- active travel structure

State hashes are canonical across irrelevant insertion order, including dynamic portal creation order.

When restoring alongside matching restored `world-core` state, `resumeWorldCoreState: true` can retain active travel progress. Otherwise travel intents can be restarted through the bridge or retained as pending intents.

## Tests and scale

```bash
npm test
npm run test:stress

npm run bench
npm run bench:locate
npm run bench:travel
npm run bench:snapshot
npm run bench:mutations
npm run bench:retention
npm run bench:guardrails
npm run bench:luebeck
```

The suite exercises:

- 100k shared-definition place instances
- large semantic location-query loads
- large portal graphs
- sparse structural mutation churn
- self-contained snapshot validation/restore
- constant-population retention churn
- deterministic randomized structural churn
- real `world-core` cross-domain travel
- broad performance-regression guardrails

CI runs tests, the real mini-city consumer, reduced regression guardrails and a reduced Lübeck integration workload. Full-scale 100k-instance, 20k-retention and multi-thousand-traveler workloads remain available for dedicated/manual performance runs.

## CI workflow policy

Normal development branches, pull requests and pushes to `main` do not run CI automatically. Repository workflows are `workflow_dispatch` only.

Each repository has exactly one persistent CI branch named `CI`. The same branch is reused for every CI run, regardless of which development branch or commit is being tested.

When a CI run is wanted:

1. Force-update `CI` to the exact commit that should be tested, discarding any previous CI-only workflow commit.
2. On `CI` only, add one workflow commit that enables a `push` trigger scoped only to `CI`.
3. Run and inspect CI.
4. For the next validation run, repeat the process from the new target commit.

Do not create feature-specific, numbered or throwaway CI branches. Do not merge the CI-only workflow commit into `main` or any development branch. The `CI` branch is persistent and is not deleted after feature merges.

This keeps one stable CI branch per repository while making the tested revision explicit and preventing CI-branch sprawl.

## Responsibility boundary

`place-core` owns semantic spatial structure, structural reachability, occupancy and cross-domain travel orchestration.

It does **not** own cognition, property law, inventory, production, economy, relationships or rendering. Those systems can reference places, spaces, portals and anchors without reimplementing spatial meaning.
