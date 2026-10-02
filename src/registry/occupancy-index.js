import { DynamicAabbIndex } from "../geometry.js";
import { compareStrings } from "../utils.js";
import {
  makeSpaceKey,
  typedIdKey
} from "./support.js";

export class OccupancyIndex {
  #locations = new Map();
  #spatialIndexes = new Map();
  #entitiesByPlace = new Map();
  #entitiesBySpace = new Map();
  #locate;
  #emit;

  constructor({ locate, emit }) {
    this.#locate = locate;
    this.#emit = emit;
  }

  get size() {
    return this.#locations.size;
  }

  get spatialDomainCount() {
    return this.#spatialIndexes.size;
  }

  snapshot() {
    return [...this.#locations.entries()]
      .map(([entityId, location]) => ({
        entityId,
        domainId: location.domainId,
        position: {
          x: location.position.x,
          y: location.position.y
        }
      }))
      .sort((a, b) =>
        compareStrings(
          typedIdKey(a.entityId),
          typedIdKey(b.entityId)
        )
      );
  }

  hasInPlace(instanceId) {
    return (this.#entitiesByPlace.get(instanceId)?.size ?? 0) > 0;
  }

  get(entityId) {
    return this.#locations.get(entityId) ?? null;
  }

  entitiesInPlace(instanceId) {
    return new Set(this.#entitiesByPlace.get(instanceId) ?? []);
  }

  entitiesInSpace(instanceId, spaceId) {
    return new Set(
      this.#entitiesBySpace.get(
        makeSpaceKey(instanceId, spaceId)
      ) ?? []
    );
  }

  entitiesInDomain(domainId) {
    const result = new Set();
    for (const [entityId, location] of
      this.#locations) {
      if (location.domainId === domainId) {
        result.add(entityId);
      }
    }
    return result;
  }

  update(entityId, next) {
    const previous = this.#locations.get(entityId) ?? null;

    if (previous && this.#sameLocation(previous, next)) {
      this.#unindexPoint(entityId, previous);
      this.#locations.set(entityId, next);
      this.#indexPoint(entityId, next);
      return next;
    }

    if (previous) {
      this.#removeMemberships(entityId, previous);
      this.#unindexPoint(entityId, previous);
    }

    this.#locations.set(entityId, next);
    this.#addMemberships(entityId, next);
    this.#indexPoint(entityId, next);
    this.#emitTransitions(entityId, previous, next);
    return next;
  }

  remove(entityId) {
    const previous = this.#locations.get(entityId);
    if (!previous) return false;

    this.#removeMemberships(entityId, previous);
    this.#unindexPoint(entityId, previous);
    this.#locations.delete(entityId);
    this.#emitTransitions(entityId, previous, null);
    return true;
  }

  clearPlace(instanceId) {
    const entityIds = [
      ...(this.#entitiesByPlace.get(instanceId) ?? [])
    ].sort((a, b) =>
      compareStrings(
        typedIdKey(a),
        typedIdKey(b)
      )
    );

    for (const entityId of entityIds) {
      this.remove(entityId);
    }
  }

  refresh(entityIds) {
    const orderedIds = [
      ...new Set(entityIds)
    ].sort((a, b) =>
      compareStrings(
        typedIdKey(a),
        typedIdKey(b)
      )
    );

    for (const entityId of orderedIds) {
      const previous = this.#locations.get(entityId);
      if (!previous) continue;

      const next = this.#locate(
        previous.domainId,
        previous.position
      );
      if (this.#sameLocation(previous, next)) {
        this.#locations.set(entityId, next);
        continue;
      }

      this.#removeMemberships(entityId, previous);
      this.#locations.set(entityId, next);
      this.#addMemberships(entityId, next);
      this.#emitTransitions(entityId, previous, next);
    }
  }

  queryBounds(domainId, bounds) {
    return this.#spatialIndexes
      .get(domainId)
      ?.queryBounds(bounds) ?? [];
  }

  assertConsistency() {
    const expectedByPlace =
      new Map();
    const expectedBySpace =
      new Map();
    const expectedByDomain =
      new Map();

    const addExpected = (
      map,
      key,
      entityId
    ) => {
      let entities = map.get(key);
      if (!entities) {
        entities = new Set();
        map.set(key, entities);
      }
      entities.add(entityId);
    };

    for (const [entityId, location] of
      this.#locations) {
      addExpected(
        expectedByDomain,
        location.domainId,
        entityId
      );

      const bounds =
        this.#spatialIndexes
          .get(location.domainId)
          ?.getBounds(entityId);
      if (
        !bounds ||
        bounds.minX !==
          location.position.x ||
        bounds.maxX !==
          location.position.x ||
        bounds.minY !==
          location.position.y ||
        bounds.maxY !==
          location.position.y
      ) {
        throw new Error(
          "occupancy spatial index drift"
        );
      }

      for (const placeId of
        location.semanticPlaces) {
        addExpected(
          expectedByPlace,
          placeId,
          entityId
        );
      }

      for (const space of
        location.spaces) {
        addExpected(
          expectedBySpace,
          makeSpaceKey(
            space.placeId,
            space.spaceId
          ),
          entityId
        );
      }
    }

    const assertSetMap = (
      actual,
      expected,
      label
    ) => {
      if (actual.size !== expected.size) {
        throw new Error(
          `${label} key count drift`
        );
      }

      for (const [key, expectedSet] of
        expected) {
        const actualSet =
          actual.get(key);
        if (
          !actualSet ||
          actualSet.size !==
            expectedSet.size
        ) {
          throw new Error(
            `${label} membership count drift`
          );
        }
        for (const entityId of
          expectedSet) {
          if (!actualSet.has(entityId)) {
            throw new Error(
              `${label} membership drift`
            );
          }
        }
      }
    };

    assertSetMap(
      this.#entitiesByPlace,
      expectedByPlace,
      "occupancy place index"
    );
    assertSetMap(
      this.#entitiesBySpace,
      expectedBySpace,
      "occupancy space index"
    );

    if (
      this.#spatialIndexes.size !==
      expectedByDomain.size
    ) {
      throw new Error(
        "occupancy spatial domain count drift"
      );
    }

    let indexedEntityCount = 0;
    for (const [domainId, index] of
      this.#spatialIndexes) {
      const expected =
        expectedByDomain.get(domainId);
      if (
        !expected ||
        index.size !== expected.size
      ) {
        throw new Error(
          "occupancy spatial domain membership drift"
        );
      }
      indexedEntityCount +=
        index.size;
    }

    if (
      indexedEntityCount !==
      this.#locations.size
    ) {
      throw new Error(
        "occupancy spatial entity count drift"
      );
    }

    return true;
  }

  #sameLocation(a, b) {
    if (!a || !b || a.domainId !== b.domainId) {
      return false;
    }

    if (a.places.length !== b.places.length ||
        a.semanticPlaces.length !== b.semanticPlaces.length ||
        a.spaces.length !== b.spaces.length) {
      return false;
    }

    for (let i = 0; i < a.places.length; i += 1) {
      if (a.places[i] !== b.places[i]) return false;
    }
    for (let i = 0; i < a.semanticPlaces.length; i += 1) {
      if (a.semanticPlaces[i] !== b.semanticPlaces[i]) {
        return false;
      }
    }
    for (let i = 0; i < a.spaces.length; i += 1) {
      if (a.spaces[i].placeId !== b.spaces[i].placeId ||
          a.spaces[i].spaceId !== b.spaces[i].spaceId) {
        return false;
      }
    }

    return true;
  }

  #indexPoint(entityId, location) {
    let index = this.#spatialIndexes.get(location.domainId);
    if (!index) {
      index = new DynamicAabbIndex();
      this.#spatialIndexes.set(location.domainId, index);
    }

    const { x, y } = location.position;
    index.set(entityId, {
      minX: x,
      minY: y,
      maxX: x,
      maxY: y
    });
  }

  #unindexPoint(entityId, location) {
    const index = this.#spatialIndexes.get(location.domainId);
    if (!index) return;

    index.delete(entityId);
    if (index.size === 0) {
      this.#spatialIndexes.delete(location.domainId);
    }
  }

  #addMemberships(entityId, location) {
    for (const placeId of location.semanticPlaces) {
      let entities = this.#entitiesByPlace.get(placeId);
      if (!entities) {
        entities = new Set();
        this.#entitiesByPlace.set(placeId, entities);
      }
      entities.add(entityId);
    }

    for (const space of location.spaces) {
      const key = makeSpaceKey(
        space.placeId,
        space.spaceId
      );
      let entities = this.#entitiesBySpace.get(key);
      if (!entities) {
        entities = new Set();
        this.#entitiesBySpace.set(key, entities);
      }
      entities.add(entityId);
    }
  }

  #removeMemberships(entityId, location) {
    for (const placeId of location.semanticPlaces) {
      const entities = this.#entitiesByPlace.get(placeId);
      entities?.delete(entityId);
      if (entities?.size === 0) {
        this.#entitiesByPlace.delete(placeId);
      }
    }

    for (const space of location.spaces) {
      const key = makeSpaceKey(
        space.placeId,
        space.spaceId
      );
      const entities = this.#entitiesBySpace.get(key);
      entities?.delete(entityId);
      if (entities?.size === 0) {
        this.#entitiesBySpace.delete(key);
      }
    }
  }

  #emitTransitions(entityId, previous, next) {
    const beforePlaces = new Set(
      previous?.semanticPlaces ?? []
    );
    const afterPlaces = new Set(
      next?.semanticPlaces ?? []
    );

    for (const placeId of beforePlaces) {
      if (!afterPlaces.has(placeId)) {
        this.#emit("place-leave", { entityId, placeId });
      }
    }
    for (const placeId of afterPlaces) {
      if (!beforePlaces.has(placeId)) {
        this.#emit("place-enter", { entityId, placeId });
      }
    }

    const beforeSpaces = new Map(
      (previous?.spaces ?? []).map((space) => [
        makeSpaceKey(space.placeId, space.spaceId),
        space
      ])
    );
    const afterSpaces = new Map(
      (next?.spaces ?? []).map((space) => [
        makeSpaceKey(space.placeId, space.spaceId),
        space
      ])
    );

    for (const [key, space] of beforeSpaces) {
      if (!afterSpaces.has(key)) {
        this.#emit("space-leave", {
          entityId,
          ...space
        });
      }
    }
    for (const [key, space] of afterSpaces) {
      if (!beforeSpaces.has(key)) {
        this.#emit("space-enter", {
          entityId,
          ...space
        });
      }
    }
  }
}
