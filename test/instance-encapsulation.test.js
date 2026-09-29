import test from "node:test";
import assert from "node:assert/strict";

import { PlaceRegistry } from "../src/index.js";

function definition() {
  return {
    id: "encapsulation-place",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10
      }
    }]
  };
}

test("PlaceInstance structural state cannot be mutated outside PlaceRegistry", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const parent = places.createPlace({
    id: "parent",
    definitionId: "encapsulation-place"
  });
  const child = places.createPlace({
    id: "child",
    definitionId: "encapsulation-place",
    metadata: {
      owner: {
        id: "hans"
      }
    }
  });

  assert.throws(
    () => {
      child.id = "corrupted";
    },
    TypeError
  );
  assert.throws(
    () => {
      child.parentId = "parent";
    },
    TypeError
  );
  assert.throws(
    () => {
      child.placement = {
        domainId: "world"
      };
    },
    TypeError
  );
  assert.throws(
    () => {
      child.metadata = null;
    },
    TypeError
  );
  assert.throws(
    () => {
      child.metadata.owner.id = "corrupted";
    },
    TypeError
  );

  assert.equal(
    typeof child.layerDomains.set,
    "undefined"
  );
  assert.equal(
    typeof child.attachments.set,
    "undefined"
  );
  assert.equal(
    typeof child.portalOverrides.set,
    "undefined"
  );
  assert.equal(
    typeof child.boundaryOverrides.set,
    "undefined"
  );
  assert.equal(
    typeof child.spaceOverrides.set,
    "undefined"
  );
  assert.equal(
    typeof child.dynamicPortals.set,
    "undefined"
  );

  assert.throws(
    () => child.setParentId("parent"),
    /registry-managed/
  );
  assert.throws(
    () => child.setPlacement(null),
    /registry-managed/
  );
  assert.throws(
    () => child.setAttachment(
      "street",
      {
        domainId: "street",
        position: { x: 0, y: 0 }
      }
    ),
    /registry-managed/
  );
  assert.throws(
    () => child.setPortalOverride(
      "door",
      { locked: true }
    ),
    /registry-managed/
  );

  assert.equal(child.id, "child");
  assert.equal(child.parentId, null);
  assert.equal(child.metadata.owner.id, "hans");
  assert.equal(parent.id, "parent");
  places.assertInternalConsistency();
});

test("dynamic portal values are immutable while registry mutation remains functional", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const place = places.createPlace({
    id: "house",
    definitionId: "encapsulation-place"
  });
  const inside =
    place.layerDomains.get("inside");

  places.addPortal("house", {
    id: "breach",
    kind: "breach",
    a: {
      domainId: inside,
      position: { x: 10, y: 5 }
    },
    b: {
      domainId: "street",
      position: { x: 20, y: 5 }
    }
  });

  const stored =
    place.dynamicPortals.get("breach");

  assert.ok(stored);
  assert.equal(stored.locked, false);
  assert.throws(
    () => {
      stored.locked = true;
    },
    TypeError
  );
  assert.equal(
    place.dynamicPortals.get("breach").locked,
    false
  );

  const updated = places.setPortalState(
    "house",
    "breach",
    { locked: true }
  );

  assert.equal(updated.locked, true);
  assert.equal(
    place.dynamicPortals.get("breach").locked,
    true
  );
  assert.notStrictEqual(
    place.dynamicPortals.get("breach"),
    stored,
    "dynamic portal state should use immutable replace-on-write"
  );

  assert.equal(
    places.removePortal("house", "breach"),
    true
  );
  assert.equal(
    place.dynamicPortals.has("breach"),
    false
  );
  places.assertInternalConsistency();
});

test("registry-managed parent placement and attachment mutation still work through readonly instance views", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  places.createPlace({
    id: "parent",
    definitionId: "encapsulation-place",
    placement: {
      domainId: "world",
      transform: {
        x: 10,
        y: 20
      },
      containment: "none"
    }
  });

  const child = places.createPlace({
    id: "child",
    definitionId: "encapsulation-place"
  });

  places.setParent("child", "parent");
  assert.equal(child.parentId, "parent");

  places.setPlacement("child", {
    parentPlaceId: "parent",
    transform: {
      x: 3,
      y: 4
    },
    containment: "none"
  });
  assert.equal(
    child.placement.parentPlaceId,
    "parent"
  );

  places.setAttachment("child", "street", {
    domainId: "street",
    position: {
      x: 50,
      y: 60
    },
    nodeId: "door"
  });
  assert.equal(
    child.attachments.get("street").nodeId,
    "door"
  );

  assert.equal(
    places.clearAttachment("child", "street"),
    true
  );
  assert.equal(
    child.attachments.has("street"),
    false
  );

  places.assertInternalConsistency();
});


test("registry structural collections are readonly views", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());
  places.createPlace({
    id: "house",
    definitionId: "encapsulation-place"
  });

  assert.equal(typeof places.definitions.set, "undefined");
  assert.equal(typeof places.instances.set, "undefined");
  assert.equal(typeof places.domainBindings.set, "undefined");

  assert.equal(
    places.definitions.has("encapsulation-place"),
    true
  );
  assert.equal(
    places.instances.has("house"),
    true
  );
  assert.equal(
    places.domainBindings.size,
    1
  );

  places.assertInternalConsistency();
});
