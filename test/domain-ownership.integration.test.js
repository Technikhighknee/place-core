import test from "node:test";
import assert from "node:assert/strict";

import {
  World,
  Navigation,
  NavigationRegistry,
  startJourney,
  stopJourney
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge,
  compilePlace
} from "../src/index.js";

function definition(id = "owned-place", layers = ["inside"]) {
  return compilePlace({
    id,
    layers: layers.map((layerId) => ({
      id: layerId,
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b"
        }]
      }
    }))
  });
}

function runtime(existingDomainPolicy = "reject") {
  const world = new World();
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney,
    existingDomainPolicy
  });
  return { world, navigation, bridge };
}

test("WorldCoreBridge rejects unknown existing-domain policies", () => {
  const world = new World();
  const navigation = new NavigationRegistry();

  assert.throws(
    () => new WorldCoreBridge({
      world,
      navigation,
      Navigation,
      startJourney,
      stopJourney,
      existingDomainPolicy: "overwrite"
    }),
    /existingDomainPolicy/
  );
});

test("normal materialization never hijacks a pre-existing world-core domain", () => {
  const { world, navigation, bridge } = runtime();
  world.addDomain({ id: "house:inside" });

  const places = new PlaceRegistry({ bridge });
  places.registerDefinition(definition("house"));

  assert.throws(
    () => places.createPlace({
      id: "house",
      definitionId: "house"
    }),
    /domain already exists and cannot be adopted/
  );

  assert.ok(world.getDomain("house:inside"));
  assert.equal(navigation.domainBindings.has("house:inside"), false);
  assert.equal(navigation.topologies.size, 0);
  assert.equal(places.getPlace("house"), null);
  assert.equal(places.getDomainBinding("house:inside"), null);
});

test("adopt policy explicitly takes ownership of an existing compatible domain", () => {
  const { world, navigation, bridge } = runtime("adopt");
  world.addDomain({ id: "house:inside" });

  const places = new PlaceRegistry({ bridge });
  const compiled = definition("house");
  places.registerDefinition(compiled);

  const place = places.createPlace({
    id: "house",
    definitionId: "house"
  });

  assert.ok(place);
  assert.ok(world.getDomain("house:inside"));
  assert.equal(
    navigation.domainBindings.get("house:inside"),
    compiled.getLayer("inside").topologyId
  );

  // Explicit adoption transfers ownership to place-core; normal removal owns
  // cleanup of that restored/adopted domain as well.
  assert.equal(places.removePlace("house"), true);
  assert.equal(world.getDomain("house:inside"), undefined);
  assert.equal(navigation.domainBindings.has("house:inside"), false);
});

test("adopt policy rejects incompatible pre-existing topology bindings without mutation", () => {
  const { world, navigation, bridge } = runtime("adopt");
  world.addDomain({ id: "house:inside" });
  navigation.registerTopology("foreign-topology", new Navigation());
  navigation.bindDomain("house:inside", "foreign-topology");

  const places = new PlaceRegistry({ bridge });
  places.registerDefinition(definition("house"));

  assert.throws(
    () => places.createPlace({
      id: "house",
      definitionId: "house"
    }),
    /already bound to incompatible topology/
  );

  assert.ok(world.getDomain("house:inside"));
  assert.equal(
    navigation.domainBindings.get("house:inside"),
    "foreign-topology"
  );
  assert.ok(navigation.topologies.has("foreign-topology"));
  assert.equal(places.getPlace("house"), null);
});

test("adopt rollback never removes a binding that existed before materialization", () => {
  const { world, navigation, bridge } = runtime("adopt");
  const compiled = definition("two-layer", ["first", "second"]);

  // Prepare the restored first domain exactly as a matching world-core
  // snapshot would contain it.
  bridge.ensureLayerTopology(compiled, compiled.getLayer("first"));
  world.addDomain({ id: "place:first" });
  navigation.bindDomain(
    "place:first",
    compiled.getLayer("first").topologyId
  );

  const originalAddDomain = world.addDomain.bind(world);
  world.addDomain = (input) => {
    if (input.id === "place:second") {
      throw new Error("synthetic second-domain failure");
    }
    return originalAddDomain(input);
  };

  const places = new PlaceRegistry({ bridge });
  places.registerDefinition(compiled);

  assert.throws(
    () => places.createPlace({
      id: "place",
      definitionId: "two-layer"
    }),
    /synthetic second-domain failure/
  );

  world.addDomain = originalAddDomain;

  assert.ok(world.getDomain("place:first"));
  assert.equal(
    navigation.domainBindings.get("place:first"),
    compiled.getLayer("first").topologyId
  );
  assert.equal(world.getDomain("place:second"), undefined);
  assert.equal(places.getPlace("place"), null);
});
