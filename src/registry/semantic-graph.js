import { typedIdKey } from "./support.js";

export class SemanticGraphIndex {
  #instances;
  #primaryChildren = new Map();
  #membershipChildren = new Map();
  #closureCache = new Map();

  constructor(instances) {
    this.#instances = instances;
  }

  get membershipParentCount() {
    return this.#membershipChildren.size;
  }

  get closureCacheSize() {
    return this.#closureCache.size;
  }

  firstPrimaryChild(instanceId) {
    const children = this.#primaryChildren.get(instanceId);
    return children?.size ? children.values().next().value : null;
  }

  firstMembershipChild(instanceId) {
    const children = this.#membershipChildren.get(instanceId);
    return children?.size ? children.keys().next().value : null;
  }

  deleteCached(instanceId) {
    this.#closureCache.delete(instanceId);
  }

  registerPrimary(instance) {
    const parentId = instance?.parentId;
    if (parentId == null) return;
    let children = this.#primaryChildren.get(parentId);
    if (!children) {
      children = new Set();
      this.#primaryChildren.set(parentId, children);
    }
    children.add(instance.id);
  }

  unregisterPrimary(instance) {
    const parentId = instance?.parentId;
    if (parentId == null) return;
    const children = this.#primaryChildren.get(parentId);
    children?.delete(instance.id);
    if (children?.size === 0) {
      this.#primaryChildren.delete(parentId);
    }
  }

  registerMembership(childId, membership) {
    let children = this.#membershipChildren.get(
      membership.parentPlaceId
    );
    if (!children) {
      children = new Map();
      this.#membershipChildren.set(
        membership.parentPlaceId,
        children
      );
    }
    children.set(
      childId,
      (children.get(childId) ?? 0) + 1
    );
  }

  unregisterMembership(childId, membership) {
    const children = this.#membershipChildren.get(
      membership.parentPlaceId
    );
    if (!children) return;

    const count = children.get(childId) ?? 0;
    if (count <= 1) {
      children.delete(childId);
    } else {
      children.set(childId, count - 1);
    }
    if (children.size === 0) {
      this.#membershipChildren.delete(
        membership.parentPlaceId
      );
    }
  }

  registerMemberships(instance) {
    for (const membership of instance.getMemberships()) {
      this.registerMembership(instance.id, membership);
    }
  }

  unregisterMemberships(instance) {
    for (const membership of instance.getMemberships()) {
      this.unregisterMembership(instance.id, membership);
    }
  }

  parentIds(instanceId) {
    const instance = this.#instances.get(instanceId);
    if (!instance) return [];

    const parents = new Map();
    if (instance.parentId != null) {
      parents.set(
        typedIdKey(instance.parentId),
        instance.parentId
      );
    }
    for (const membership of instance.getMemberships()) {
      parents.set(
        typedIdKey(membership.parentPlaceId),
        membership.parentPlaceId
      );
    }

    return [...parents.values()]
      .sort((a, b) =>
        typedIdKey(a).localeCompare(typedIdKey(b))
      );
  }

  assertEdgeDoesNotCycle(
    instanceId,
    parentId,
    message = "place semantic membership cycle"
  ) {
    const targetKey = typedIdKey(instanceId);
    const stack = [parentId];
    const visited = new Set();

    while (stack.length) {
      const currentId = stack.pop();
      const currentKey = typedIdKey(currentId);
      if (currentKey === targetKey) {
        throw new Error(message);
      }
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);

      const parents = this.parentIds(currentId);
      for (let i = parents.length - 1; i >= 0; i -= 1) {
        stack.push(parents[i]);
      }
    }
  }

  childrenOf(instanceId) {
    const children = new Map();

    for (const childId of
      this.#primaryChildren.get(instanceId) ?? []) {
      children.set(typedIdKey(childId), childId);
    }

    for (const childId of
      this.#membershipChildren
        .get(instanceId)
        ?.keys?.() ?? []) {
      children.set(typedIdKey(childId), childId);
    }

    return [...children.values()]
      .sort((a, b) =>
        typedIdKey(a).localeCompare(typedIdKey(b))
      );
  }

  invalidateClosureDescendants(instanceId) {
    if (this.#closureCache.size === 0) return;

    const queue = [instanceId];
    const visited = new Set();

    for (let i = 0; i < queue.length; i += 1) {
      const currentId = queue[i];
      const key = typedIdKey(currentId);
      if (visited.has(key)) continue;
      visited.add(key);

      this.#closureCache.delete(currentId);
      for (const childId of this.childrenOf(currentId)) {
        queue.push(childId);
      }
    }
  }

  computeClosure(instanceId) {
    const output = [];
    const permanent = new Set();
    const visiting = new Set();
    const stack = [{
      id: instanceId,
      entered: false,
      parents: null,
      index: 0
    }];

    while (stack.length) {
      const frame = stack[stack.length - 1];
      const key = typedIdKey(frame.id);

      if (permanent.has(key)) {
        stack.pop();
        continue;
      }

      if (!frame.entered) {
        const instance = this.#instances.get(frame.id);
        if (!instance) {
          stack.pop();
          continue;
        }

        if (visiting.has(key)) {
          throw new Error("place semantic membership cycle");
        }

        visiting.add(key);
        frame.entered = true;
        frame.parents = this.parentIds(frame.id);
        frame.index = 0;
      }

      if (frame.index < frame.parents.length) {
        const parentId = frame.parents[frame.index++];
        const parentKey = typedIdKey(parentId);

        if (permanent.has(parentKey)) continue;
        if (visiting.has(parentKey)) {
          throw new Error("place semantic membership cycle");
        }

        stack.push({
          id: parentId,
          entered: false,
          parents: null,
          index: 0
        });
        continue;
      }

      visiting.delete(key);
      permanent.add(key);
      output.push(frame.id);
      stack.pop();
    }

    return output;
  }

  closureForInstance(instanceId) {
    const cached = this.#closureCache.get(instanceId);
    if (cached) return cached;

    const computed = Object.freeze(
      this.computeClosure(instanceId)
    );
    this.#closureCache.set(instanceId, computed);
    return computed;
  }

  closure(instanceIds) {
    const output = [];
    const seen = new Set();
    const roots = [...instanceIds]
      .sort((a, b) =>
        typedIdKey(a).localeCompare(typedIdKey(b))
      );

    for (const instanceId of roots) {
      for (const semanticId of
        this.closureForInstance(instanceId)) {
        const key = typedIdKey(semanticId);
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(semanticId);
      }
    }

    return output;
  }

  assertInstanceIndexed(instance) {
    if (instance.parentId != null) {
      if (!this.#instances.has(instance.parentId)) {
        throw new Error(
          `instance ${String(instance.id)} references missing parent`
        );
      }
      if (!this.#primaryChildren
        .get(instance.parentId)
        ?.has(instance.id)) {
        throw new Error(
          `instance ${String(instance.id)} missing semantic dependency index`
        );
      }
    }

    for (const membership of instance.getMemberships()) {
      if (!this.#instances.has(membership.parentPlaceId)) {
        throw new Error(
          `instance ${String(instance.id)} references missing membership parent ${String(membership.parentPlaceId)}`
        );
      }

      const count = this.#membershipChildren
        .get(membership.parentPlaceId)
        ?.get(instance.id) ?? 0;
      const expectedCount = instance.getMemberships()
        .filter((candidate) =>
          candidate.parentPlaceId === membership.parentPlaceId
        ).length;

      if (count !== expectedCount) {
        throw new Error(
          `instance ${String(instance.id)} membership reverse index drift`
        );
      }
    }
  }

  assertConsistency() {
    this.#assertAcyclic();

    let indexedMembershipCount = 0;
    for (const [parentId, children] of this.#membershipChildren) {
      if (!this.#instances.has(parentId)) {
        throw new Error(
          `membership reverse index references missing parent ${String(parentId)}`
        );
      }
      for (const [childId, count] of children) {
        if (!this.#instances.has(childId) ||
            !Number.isInteger(count) ||
            count < 1) {
          throw new Error(
            "membership reverse index contains invalid child/count"
          );
        }
        indexedMembershipCount += count;
      }
    }

    let actualMembershipCount = 0;
    for (const instance of this.#instances.values()) {
      actualMembershipCount += instance.getMemberships().length;
    }
    if (indexedMembershipCount !== actualMembershipCount) {
      throw new Error(
        "semantic membership reverse index count drift"
      );
    }

    for (const [instanceId, cached] of this.#closureCache) {
      if (!this.#instances.has(instanceId)) {
        throw new Error(
          "semantic closure cache references missing instance"
        );
      }

      const expected = this.computeClosure(instanceId);
      if (cached.length !== expected.length ||
          cached.some(
            (id, index) => id !== expected[index]
          )) {
        throw new Error(
          `semantic closure cache drift for ${String(instanceId)}`
        );
      }
    }
  }

  #assertAcyclic() {
    const permanent = new Set();
    const visiting = new Set();
    const roots = [...this.#instances.keys()]
      .sort((a, b) =>
        typedIdKey(a).localeCompare(typedIdKey(b))
      );

    for (const rootId of roots) {
      const rootKey = typedIdKey(rootId);
      if (permanent.has(rootKey)) continue;

      const stack = [{
        id: rootId,
        entered: false,
        parents: null,
        index: 0
      }];

      while (stack.length) {
        const frame = stack[stack.length - 1];
        const key = typedIdKey(frame.id);

        if (permanent.has(key)) {
          stack.pop();
          continue;
        }

        if (!frame.entered) {
          if (visiting.has(key)) {
            throw new Error("place semantic membership cycle");
          }

          visiting.add(key);
          frame.entered = true;
          frame.parents = this.parentIds(frame.id);
          frame.index = 0;
        }

        if (frame.index < frame.parents.length) {
          const parentId = frame.parents[frame.index++];
          const parentKey = typedIdKey(parentId);

          if (permanent.has(parentKey)) continue;
          if (visiting.has(parentKey)) {
            throw new Error("place semantic membership cycle");
          }

          stack.push({
            id: parentId,
            entered: false,
            parents: null,
            index: 0
          });
          continue;
        }

        visiting.delete(key);
        permanent.add(key);
        stack.pop();
      }
    }
  }
}
