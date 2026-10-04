import test from "node:test";
import assert from "node:assert/strict";

import {
  BoundedEventQueue
} from "../src/utils.js";
import {
  PlaceRegistry
} from "../src/index.js";

test("event queue drop-newest never throws and preserves existing events", () => {
  const queue = new BoundedEventQueue({
    limit: 2,
    overflowPolicy: "drop-newest"
  });

  assert.equal(queue.push({ id: 1 }), true);
  assert.equal(queue.push({ id: 2 }), true);
  assert.equal(queue.push({ id: 3 }), false);

  assert.deepEqual(queue.peek(), [
    { id: 1 },
    { id: 2 }
  ]);
  assert.equal(queue.dropped, 1);
});

test("event queue drop-oldest never throws and retains newest events", () => {
  const queue = new BoundedEventQueue({
    limit: 2,
    overflowPolicy: "drop-oldest"
  });

  assert.equal(queue.push({ id: 1 }), true);
  assert.equal(queue.push({ id: 2 }), true);
  assert.equal(queue.push({ id: 3 }), false);

  assert.deepEqual(queue.peek(), [
    { id: 2 },
    { id: 3 }
  ]);
  assert.equal(queue.dropped, 1);
});

test("throwing overflow policy is rejected at configuration boundary", () => {
  assert.throws(
    () => new BoundedEventQueue({
      limit: 1,
      overflowPolicy: "throw"
    }),
    /drop-newest.*drop-oldest/
  );
});

test("full captured-event queue cannot turn a committed mutation into an error", () => {
  const places = new PlaceRegistry({
    captureEvents: true,
    eventQueueLimit: 1,
    eventOverflowPolicy: "drop-newest"
  });

  places.registerDefinition({
    id: "event-place",
    layers: [{ id: "inside" }]
  });

  places.createPlace({
    id: "first",
    definitionId: "event-place"
  });

  assert.equal(places.peekEvents().length, 1);

  assert.doesNotThrow(() =>
    places.createPlace({
      id: "second",
      definitionId: "event-place"
    })
  );

  assert.ok(places.getPlace("second"));
  assert.equal(places.peekEvents().length, 1);
  assert.equal(places.getEventQueueStats().dropped, 1);
});

test("zero-sized event queue records drops without affecting simulation", () => {
  const places = new PlaceRegistry({
    captureEvents: true,
    eventQueueLimit: 0,
    eventOverflowPolicy: "drop-newest"
  });

  places.registerDefinition({
    id: "zero-event-place",
    layers: [{ id: "inside" }]
  });

  assert.doesNotThrow(() =>
    places.createPlace({
      id: "house",
      definitionId: "zero-event-place"
    })
  );

  assert.ok(places.getPlace("house"));
  assert.equal(places.peekEvents().length, 0);
  assert.equal(places.getEventQueueStats().dropped, 1);
});


test("event drain target must be an array and failures preserve queued events", () => {
  const places =
    new PlaceRegistry({
      captureEvents: true
    });

  places.emit(
    "queued",
    { value: 1 }
  );

  for (const target of [
    null,
    {},
    {
      push() {}
    },
    "events"
  ]) {
    assert.throws(
      () =>
        places.drainEvents(
          target
        ),
      /event drain target must be an array/
    );
    assert.equal(
      places.peekEvents().length,
      1
    );
  }

  const target = [{
    sequence: 0,
    type: "existing"
  }];
  const drained =
    places.drainEvents(target);

  assert.equal(
    drained,
    target
  );
  assert.equal(
    target.length,
    2
  );
  assert.equal(
    places.peekEvents().length,
    0
  );
});


test("public emit validates event type and data before capture policy", () => {
  for (const captureEvents of [
    false,
    true
  ]) {
    const places =
      new PlaceRegistry({
        captureEvents
      });

    for (const type of [
      "",
      null,
      0,
      false,
      {}
    ]) {
      assert.throws(
        () =>
          places.emit(
            type,
            {}
          ),
        /event type/
      );
    }

    for (const data of [
      null,
      [],
      "payload",
      17,
      false
    ]) {
      assert.throws(
        () =>
          places.emit(
            "custom-event",
            data
          ),
        /event data/
      );
    }

    assert.equal(
      places.peekEvents().length,
      0
    );
  }
});


test("public emit cannot spoof reserved event envelope fields", () => {
  const places = new PlaceRegistry({
    captureEvents: true
  });

  const event = places.emit(
    "expected",
    {
      type: "spoofed",
      sequence: 999,
      payload: "ok"
    }
  );

  assert.equal(event.type, "expected");
  assert.equal(event.sequence, 1);
  assert.equal(event.payload, "ok");
});
