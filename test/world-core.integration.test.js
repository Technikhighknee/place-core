import test from "node:test";
import assert from "node:assert/strict";
import {
  compilePlace,
  PlaceRegistry,
  WorldCoreBridge,
  startTravel,
  stepPlaceSimulation
} from "../src/index.js";
import {
  World,
  Navigation,
  NavigationRegistry,
  mobilityProfile,
  startJourney,
  stopJourney,
  stepSimulation
} from "world-core";

test("real world-core moves Hans through house, street, tavern and cellar", () => {
  const world = new World();
  const navigation = new NavigationRegistry();

  const street = new Navigation();
  street.addNode({ id: "home-exit", x: 10, y: 0 });
  street.addNode({ id: "inn-entry", x: 50, y: 0 });
  street.addRoad({ id: "street", from: "home-exit", to: "inn-entry", width: 4 });
  navigation.registerTopology("street", street);
  navigation.setDefaultTopology("street");

  const bridge = new WorldCoreBridge({ world, navigation, startJourney, stopJourney, Navigation });
  const places = new PlaceRegistry({ bridge, captureEvents: true });

  const house = compilePlace({
    id: "house",
    defaultAnchorId: "bed",
    layers: [{
      id: "ground",
      navigation: {
        nodes: [{ id: "front", x: 0, y: 5 }, { id: "bed", x: 8, y: 5 }],
        roads: [{ id: "hall", from: "front", to: "bed", width: 2 }]
      }
    }],
    spaces: [{ id: "room", layerId: "ground", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }, defaultAnchorId: "bed" }],
    portals: [{
      id: "front",
      a: { kind: "external", slot: "street" },
      b: { kind: "local", layerId: "ground", spaceId: "room", position: { x: 0, y: 5 }, nodeId: "front" }
    }],
    anchors: [{ id: "bed", layerId: "ground", spaceId: "room", position: { x: 8, y: 5 }, nodeId: "bed" }]
  });

  const tavern = compilePlace({
    id: "tavern",
    defaultAnchorId: "barrel",
    layers: [
      { id: "ground", navigation: {
        nodes: [{ id: "front", x: 0, y: 10 }, { id: "stairs", x: 15, y: 10 }],
        roads: [{ id: "taproom", from: "front", to: "stairs", width: 3 }]
      }},
      { id: "cellar", navigation: {
        nodes: [{ id: "stairs", x: 5, y: 5 }, { id: "barrel", x: 15, y: 5 }],
        roads: [{ id: "cellar", from: "stairs", to: "barrel", width: 2 }]
      }}
    ],
    spaces: [
      { id: "taproom", layerId: "ground", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 20, maxY: 20 } },
      { id: "cellar", layerId: "cellar", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 20, maxY: 10 }, defaultAnchorId: "barrel" }
    ],
    portals: [
      {
        id: "front",
        a: { kind: "external", slot: "street" },
        b: { kind: "local", layerId: "ground", spaceId: "taproom", position: { x: 0, y: 10 }, nodeId: "front" }
      },
      {
        id: "stairs",
        a: { kind: "local", layerId: "ground", spaceId: "taproom", position: { x: 15, y: 10 }, nodeId: "stairs" },
        b: { kind: "local", layerId: "cellar", spaceId: "cellar", position: { x: 5, y: 5 }, nodeId: "stairs" }
      }
    ],
    anchors: [{ id: "barrel", layerId: "cellar", spaceId: "cellar", position: { x: 15, y: 5 }, nodeId: "barrel" }]
  });

  places.registerDefinition(house);
  places.registerDefinition(tavern);
  places.createPlace({ id: "home", definitionId: "house", attachments: {
    street: { domainId: "default", position: { x: 10, y: 0 }, nodeId: "home-exit" }
  }});
  places.createPlace({ id: "inn", definitionId: "tavern", attachments: {
    street: { domainId: "default", position: { x: 50, y: 0 }, nodeId: "inn-entry" }
  }});

  world.addEntity({
    id: "hans",
    domainId: "home:ground",
    position: { x: 8, y: 5 },
    mobility: mobilityProfile("pedestrian")
  });
  places.syncEntityOccupancy(world.getEntity("hans"));
  assert.ok(startTravel(places, "hans", { placeId: "inn", anchorId: "barrel" }));

  for (let i = 0; i < 2_000 && places.activeTravels.has("hans"); i += 1) {
    stepSimulation(world, navigation, 0.25);
    stepPlaceSimulation(places);
  }

  const hans = world.getEntity("hans");
  assert.equal(places.activeTravels.has("hans"), false);
  assert.equal(hans.domainId, "inn:cellar");
  assert.ok(Math.hypot(hans.position.x - 15, hans.position.y - 5) < 0.01);
  assert.equal(places.getEntityLocation("hans").spaces.at(-1).spaceId, "cellar");
  assert.ok(places.drainEvents().some((event) => event.type === "travel-complete"));
});
