import { composeTransforms } from "../geometry.js";
import {
  compareStrings,
  deepFreeze
} from "../utils.js";
import { typedIdKey } from "./support.js";

export class PlacementGraphIndex {
  #instances;
  #children = new Map();

  constructor(instances) {
    this.#instances = instances;
  }

  hasChildren(instanceId) {
    return (this.#children.get(instanceId)?.size ?? 0) > 0;
  }

  register(instance) {
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

  assertParentDoesNotCycle(instanceId, parentId) {
    let cursorId = parentId;
    const visited = new Set([typedIdKey(instanceId)]);

    while (cursorId != null) {
      const key = typedIdKey(cursorId);
      if (visited.has(key)) {
        throw new Error("place placement cycle");
      }

      visited.add(key);
      const cursor = this.#instances.get(cursorId);
      cursorId = cursor?.placement?.parentPlaceId ?? null;
    }
  }

  resolve(instanceId) {
    const chain = [];
    const visited = new Set();
    let current = this.#instances.get(instanceId);

    while (current?.placement) {
      const key = typedIdKey(current.id);
      if (visited.has(key)) {
        throw new Error("place placement cycle");
      }

      visited.add(key);
      chain.push(current.placement);
      if (current.placement.domainId != null) break;
      current = this.#instances.get(
        current.placement.parentPlaceId
      );
    }

    if (!chain.length ||
        chain[chain.length - 1].domainId == null) {
      return null;
    }

    const root = chain.pop();
    let transform = root.transform;
    const domainId = root.domainId;

    while (chain.length) {
      transform = composeTransforms(
        transform,
        chain.pop().transform
      );
    }

    return deepFreeze({
      domainId,
      transform,
      containment:
        this.#instances.get(instanceId)
          ?.placement?.containment ?? "none"
    });
  }

  assertInstanceIndexed(instance) {
    const parentId = instance.placement?.parentPlaceId;
    if (parentId == null) return;

    if (!this.#instances.has(parentId)) {
      throw new Error(
        `instance ${String(instance.id)} references missing placement parent`
      );
    }

    this.assertParentDoesNotCycle(instance.id, parentId);

    if (!this.#children.get(parentId)?.has(instance.id)) {
      throw new Error(
        `instance ${String(instance.id)} missing placement dependency index`
      );
    }
  }
}
