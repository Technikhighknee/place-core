# place-core

A semantic place, interior, portal and cross-domain travel simulation core.

`world-core` answers **where something physically is and how it moves through metric space**. `place-core` answers **what that location means, how places are structured, how isolated spatial domains connect, and how an entity travels between semantic destinations**.

There is no player/camera/loaded-area concept and no distance-based simulation fidelity.

## Core model

A compiled definition is immutable shared structure. A place instance contains identity, domain bindings, exterior placement and sparse deviations from that shared structure.

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
- **SpatialLayer** — one local metric frame, normally backed by one `world-core` domain.
- **Space** — semantic region such as room, hall, courtyard, deck or cellar.
- **Boundary** — wall, fence, partition or other separator.
- **Portal** — door, gate, stairs, ladder, hatch, bridge, gangplank or breach.
- **Anchor** — semantic target such as bed, counter, exit, forge or storage position.
- **Placement** — exterior transform of a place; interiors keep stable local coordinates.

A room is deliberately **not** a domain. Multiple rooms usually share one continuous layer/domain.

## Definitions and shared navigation

```js
import { compilePlace } from "place-core";

const house = compilePlace({
  id: "small-house",
  defaultAnchorId: "bed",

  layers: [{
    id: "ground",
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
    geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 },
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

Embedded navigation is compiled into one shared `world-core` topology per layer. Thousands of instances bind domains to that topology instead of cloning graphs.

Compilation validates IDs, containment cycles, portal/anchor references and embedded navigation node/road references. Definitions receive a canonical content hash.

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

const world = new World();
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

Creating a place can create its domains, register its shared topology once, bind domains, and apply sparse road effects.

## Sparse structural state

```js
places.setPortalState("house-17", "front-door", { locked: true });
places.setBoundaryState("house-17", "west-wall", { enabled: false });
places.setSpaceState("house-17", "collapsed-room", { enabled: false });
```

Portal state affects traversal. A portal can bind to `world-core` roads so lock/block/destroy state becomes a per-domain road effect.

Boundaries can bind to precompiled breach roads. While the wall exists, those roads remain blocked for that instance. Destroying the boundary removes the road effect without cloning or mutating the shared topology.

Dynamic instance portals support sparse breaches, gangplanks and temporary cross-domain links.

## Location and occupancy

```js
places.locate("golden-goose:ground", { x: 8, y: 7 });
places.syncEntityOccupancy(world.getEntity("hans"));

places.entitiesInPlace("golden-goose");
places.entitiesInSpace("golden-goose", "taproom");
```

Physical position remains authoritative in `world-core`. `place-core` derives semantic location and emits bounded deterministic events such as:

```text
place-enter
place-leave
space-enter
space-leave
portal-enter
portal-traverse
portal-exit
```

## Global semantic travel

```js
import { startTravel, stepPlaceSimulation } from "place-core";

startTravel(places, "hans", {
  placeId: "golden-goose",
  anchorId: "barrel"
});

stepSimulation(world, navigation, deltaSeconds);
stepPlaceSimulation(places);
```

A travel plan composes:

```text
local world-core journey
→ portal traversal
→ local world-core journey
→ portal traversal
→ ...
→ semantic target anchor
```

The domain portal search is bidirectional. Every local leg is checked against actual `world-core` navigation. Unreachable entrances can be rejected and alternate portal chains tried deterministically.

Structural graph revisions invalidate active plans and trigger replanning. If no valid route remains, travel fails instead of following stale topology.

## Moving places

Exterior placement is independent from interior domains:

```js
places.setPlacement("cog-hildegard", {
  domainId: "luebeck-harbor",
  transform: { x: 500, y: 220, rotation: 0.7 },
  containment: "footprint"
});
```

A ship or wagon can move externally while occupants keep stable local coordinates inside its domains. `setAttachment()` can reconnect entrances such as gangplanks.

## Save/load and determinism

```js
import {
  serializePlaceCore,
  deserializePlaceCore,
  validatePlaceCoreSnapshot,
  computePlaceCoreStateHash
} from "place-core";
```

Snapshots store definition ID/hash references, instances, hierarchy, bindings, attachments, placements, sparse structural overrides, dynamic portals and travel intents.

Definition geometry is not duplicated per instance or per save. Restore rejects definition hash drift.

## Scale

```bash
npm test
npm run bench
npm run bench:locate
npm run bench:travel
```

The benchmark suite targets 100k place instances and large shared portal graphs. The architecture optimizes representation and query structure instead of deleting simulation truth based on player distance.

## Responsibility boundary

`place-core` owns semantic spatial structure and cross-domain travel orchestration. It does not own NPC cognition, property law, inventory, production, economy, relationships or rendering. Those systems can reference places, spaces, portals and anchors without reimplementing spatial meaning.
