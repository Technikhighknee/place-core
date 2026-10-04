import { composeTransforms } from "../geometry.js";
import {
  compareStrings,
  deepFreeze
} from "../utils.js";
import { typedIdKey } from "./support.js";

export class PlacementGraphIndex {
  #instances;
  #children = new Map();
  #resolvedCache = new Map();

  constructor(instances) {
    this.#instances = instances;
  }

  hasChildren(instanceId) {
    return (this.#children.get(instanceId)?.size ?? 0) > 0;
  }

  register(instance) {
    this.invalidateResolvedDescendants(
      instance.id
    );

    const parentId = instance?.placement?.parentPlaceId;
    if (parentId == null) return;

    let children = this.#children.get(parentId);
    if (!children) {
      children = new Set();
      this.#children.set(parentId, children);
    }
    children.add(instance.id);
  }

  unregister(instance) {
    this.invalidateResolvedDescendants(
      instance.id
    );

    const parentId = instance?.placement?.parentPlaceId;
    if (parentId == null) return;

    const children = this.#children.get(parentId);
    children?.delete(instance.id);
    if (children?.size === 0) {
      this.#children.delete(parentId);
    }
  }

  collectDescendants(instanceId) {
    const result = [];
    const queue = [instanceId];
    const visited = new Set();

    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      const key = typedIdKey(id);
      if (visited.has(key)) {
        throw new Error("placement dependency cycle");
      }

      visited.add(key);
      result.push(id);

      const children = this.#children.get(id);
      if (children) {
        queue.push(
          ...[...children].sort((a, b) =>
            compareStrings(typedIdKey(a), typedIdKey(b))
          )
        );
      }
    }

    return result;
  }

  invalidateResolvedDescendants(instanceId) {
    for (const id of
      this.collectDescendants(instanceId)) {
      this.#resolvedCache.delete(id);
    }
  }

  assertParentDoesNotCycle(instanceId, parentId) {
    const parentKey = typedIdKey(parentId);
    const queue = [instanceId];
    const visited = new Set();

    for (let i = 0; i < queue.length; i += 1) {
      const currentId = queue[i];
      const currentKey = typedIdKey(currentId);

      if (currentKey === parentKey) {
        throw new Error("place placement cycle");
      }
      if (visited.has(currentKey)) {
        continue;
      }
      visited.add(currentKey);

      const children = this.#children.get(currentId);
      if (!children) continue;

      queue.push(
        ...[...children].sort((a, b) =>
          compareStrings(
            typedIdKey(a),
            typedIdKey(b)
          )
        )
      );
    }
  }

  resolve(instanceId) {
    if (this.#resolvedCache.has(instanceId)) {
      return this.#resolvedCache.get(instanceId);
    }

    const chain = [];
    const visited = new Set();
    let current = this.#instances.get(instanceId);
    let resolved = null;
    let baseKnown = false;

    while (current?.placement) {
      const key = typedIdKey(current.id);
      if (visited.has(key)) {
        throw new Error("place placement cycle");
      }
      visited.add(key);

      if (this.#resolvedCache.has(current.id)) {
        resolved =
          this.#resolvedCache.get(current.id);
        baseKnown = true;
        break;
      }

      if (current.placement.domainId != null) {
        resolved = deepFreeze({
          domainId:
            current.placement.domainId,
          transform:
            current.placement.transform,
          containment:
            current.placement.containment ??
            "none"
        });
        this.#resolvedCache.set(
          current.id,
          resolved
        );
        baseKnown = true;
        break;
      }

      chain.push(current);
      current = this.#instances.get(
        current.placement.parentPlaceId
      );
    }

    if (!baseKnown) {
      resolved = null;
    }

    while (chain.length) {
      const child = chain.pop();

      if (resolved == null) {
        this.#resolvedCache.set(
          child.id,
          null
        );
        continue;
      }

      resolved = deepFreeze({
        domainId: resolved.domainId,
        transform: composeTransforms(
          resolved.transform,
          child.placement.transform
        ),
        containment:
          child.placement.containment ??
          "none"
      });
      this.#resolvedCache.set(
        child.id,
        resolved
      );
    }

    if (!this.#resolvedCache.has(instanceId)) {
      this.#resolvedCache.set(
        instanceId,
        resolved
      );
    }

    return this.#resolvedCache.get(instanceId);
  }

  assertInstanceIndexed(instance) {
    const parentId = instance.placement?.parentPlaceId;
    if (parentId == null) return;

    if (!this.#instances.has(parentId)) {
      throw new Error(
        `instance ${String(instance.id)} references missing placement parent`
      );
    }

    if (!this.#children.get(parentId)?.has(instance.id)) {
      throw new Error(
        `instance ${String(instance.id)} missing placement dependency index`
      );
    }
  }

  assertConsistency() {
    for (const instanceId of this.#resolvedCache.keys()) {
      if (!this.#instances.has(instanceId)) {
        throw new Error(
          `placement resolve cache references missing instance ${String(instanceId)}`
        );
      }
    }

    for (const instance of this.#instances.values()) {
      this.assertInstanceIndexed(instance);
    }

    for (const [parentId, children] of this.#children) {
      if (!this.#instances.has(parentId)) {
        throw new Error(
          `placement dependency index references missing parent ${String(parentId)}`
        );
      }

      for (const childId of children) {
        const child = this.#instances.get(childId);
        if (!child) {
          throw new Error(
            `placement dependency index references missing child ${String(childId)}`
          );
        }
        if (
          child.placement?.parentPlaceId !==
          parentId
        ) {
          throw new Error(
            `placement dependency index drift for ${String(childId)}`
          );
        }
      }
    }

    const permanent = new Set();
    const roots = [...this.#instances.keys()]
      .sort((a, b) =>
        compareStrings(
          typedIdKey(a),
          typedIdKey(b)
        )
      );

    for (const rootId of roots) {
      const rootKey = typedIdKey(rootId);
      if (permanent.has(rootKey)) {
        continue;
      }

      const path = [];
      const visiting = new Set();
      let cursorId = rootId;

      while (cursorId != null) {
        const key = typedIdKey(cursorId);
        if (permanent.has(key)) {
          break;
        }
        if (visiting.has(key)) {
          throw new Error(
            "place placement cycle"
          );
        }

        visiting.add(key);
        path.push(cursorId);

        const cursor =
          this.#instances.get(cursorId);
        cursorId =
          cursor?.placement
            ?.parentPlaceId ?? null;
      }

      for (const id of path) {
        permanent.add(
          typedIdKey(id)
        );
      }
    }
  }
}
