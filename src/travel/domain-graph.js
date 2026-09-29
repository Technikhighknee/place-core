import { isPortalTraversable } from "../registry.js";
import {
  assertStringId,
  tupleKey
} from "../utils.js";
import { normalizeDomainPathOptions } from "./input.js";

const EMPTY_SET = new Set();

export class MinHeap {
  #items = [];

  push(item) {
    let index = this.#items.length;
    this.#items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareQueue(this.#items[parent], item) <= 0) break;
      this.#items[index] = this.#items[parent];
      index = parent;
    }
    this.#items[index] = item;
  }

  pop() {
    if (!this.#items.length) return null;
    const root = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= this.#items.length) break;
        const right = left + 1;
        let child = left;
        if (right < this.#items.length && compareQueue(this.#items[right], this.#items[left]) < 0) child = right;
        if (compareQueue(this.#items[child], last) >= 0) break;
        this.#items[index] = this.#items[child];
        index = child;
      }
      this.#items[index] = last;
    }
    return root;
  }

  get size() { return this.#items.length; }
}

function compareQueue(a, b) {
  if (a.cost !== b.cost) return a.cost - b.cost;
  return a.key.localeCompare(b.key);
}

export function pairKey(a, b) {
  return tupleKey(a, b);
}

function legacyPairKey(a, b) {
  return `${a}\u0000${b}`;
}

function pairIsExcluded(excludedPairs, a, b) {
  return excludedPairs.has(pairKey(a, b)) ||
    excludedPairs.has(legacyPairKey(a, b));
}

export function transitionKey(edge) {
  return tupleKey(
    edge.portal.key,
    edge.side
  );
}

export function transitionsFrom(registry, domainId, options = {}) {
  const excludedPortalKeys = options.excludedPortalKeys ?? EMPTY_SET;
  const excludedPairs = options.excludedPairs ?? EMPTY_SET;
  const edges = [];

  for (const portal of registry.getPortalsForDomain(domainId)) {
    if (!portal || excludedPortalKeys.has(portal.key) || !isPortalTraversable(portal)) continue;
    if (portal.a.domainId === portal.b.domainId) continue;

    if (portal.a.domainId === domainId) {
      if (!pairIsExcluded(excludedPairs, domainId, portal.b.domainId)) {
        edges.push({ portal, portalKey: portal.key, side: "a", from: portal.a, to: portal.b });
      }
    }
    if (portal.bidirectional !== false && portal.b.domainId === domainId) {
      if (!pairIsExcluded(excludedPairs, domainId, portal.a.domainId)) {
        edges.push({ portal, portalKey: portal.key, side: "b", from: portal.b, to: portal.a });
      }
    }
  }

  edges.sort((a, b) => transitionKey(a).localeCompare(transitionKey(b)));
  return edges;
}

function transitionsInto(registry, domainId, options = {}) {
  const excludedPortalKeys = options.excludedPortalKeys ?? EMPTY_SET;
  const excludedPairs = options.excludedPairs ?? EMPTY_SET;
  const edges = [];

  for (const portal of registry.getPortalsForDomain(domainId)) {
    if (!portal || excludedPortalKeys.has(portal.key) || !isPortalTraversable(portal)) continue;
    if (portal.a.domainId === portal.b.domainId) continue;

    if (portal.b.domainId === domainId) {
      if (!pairIsExcluded(excludedPairs, portal.a.domainId, domainId)) {
        edges.push({ portal, portalKey: portal.key, side: "a", from: portal.a, to: portal.b });
      }
    }
    if (portal.bidirectional !== false && portal.a.domainId === domainId) {
      if (!pairIsExcluded(excludedPairs, portal.b.domainId, domainId)) {
        edges.push({ portal, portalKey: portal.key, side: "b", from: portal.b, to: portal.a });
      }
    }
  }

  edges.sort((a, b) => transitionKey(a).localeCompare(transitionKey(b)));
  return edges;
}

function neighborDomains(edges, direction) {
  const set = new Set();
  for (const edge of edges) set.add(direction === "out" ? edge.to.domainId : edge.from.domainId);
  return [...set].sort();
}

export function findDomainPortalPath(
  registry,
  startDomainId,
  targetDomainId,
  options = {}
) {
  assertStringId(startDomainId, "startDomainId");
  assertStringId(targetDomainId, "targetDomainId");

  return findDomainPortalPathInternal(
    registry,
    startDomainId,
    targetDomainId,
    normalizeDomainPathOptions(options)
  );
}

export function findDomainPortalPathInternal(
  registry,
  startDomainId,
  targetDomainId,
  options = {}
) {
  if (startDomainId === targetDomainId) return [];

  const forwardVisited = new Map([[startDomainId, null]]);
  const backwardVisited = new Map([[targetDomainId, null]]);
  let forwardFrontier = new Set([startDomainId]);
  let backwardFrontier = new Set([targetDomainId]);
  let meeting = null;
  let preferForward = true;

  while (forwardFrontier.size && backwardFrontier.size) {
    const expandForward = forwardFrontier.size < backwardFrontier.size ||
      (forwardFrontier.size === backwardFrontier.size && preferForward);
    preferForward = !preferForward;

    if (expandForward) {
      const next = new Set();
      for (const domainId of [...forwardFrontier].sort()) {
        const neighbors = neighborDomains(transitionsFrom(registry, domainId, options), "out");
        for (const neighbor of neighbors) {
          if (forwardVisited.has(neighbor)) continue;
          forwardVisited.set(neighbor, domainId);
          if (backwardVisited.has(neighbor)) {
            meeting = neighbor;
            break;
          }
          next.add(neighbor);
        }
        if (meeting) break;
      }
      if (meeting) break;
      forwardFrontier = next;
    } else {
      const next = new Set();
      for (const domainId of [...backwardFrontier].sort()) {
        const predecessors = neighborDomains(transitionsInto(registry, domainId, options), "in");
        for (const predecessor of predecessors) {
          if (backwardVisited.has(predecessor)) continue;
          backwardVisited.set(predecessor, domainId);
          if (forwardVisited.has(predecessor)) {
            meeting = predecessor;
            break;
          }
          next.add(predecessor);
        }
        if (meeting) break;
      }
      if (meeting) break;
      backwardFrontier = next;
    }
  }

  if (!meeting) return null;

  const prefix = [];
  let cursor = meeting;
  while (cursor !== startDomainId) {
    prefix.push(cursor);
    cursor = forwardVisited.get(cursor);
    if (cursor == null) throw new Error("corrupt forward domain search state");
  }
  prefix.push(startDomainId);
  prefix.reverse();

  const suffix = [];
  cursor = meeting;
  while (cursor !== targetDomainId) {
    cursor = backwardVisited.get(cursor);
    if (cursor == null) throw new Error("corrupt backward domain search state");
    suffix.push(cursor);
  }

  const domains = [...prefix, ...suffix];
  const edges = [];
  for (let i = 0; i < domains.length - 1; i += 1) {
    const candidates = transitionsFrom(registry, domains[i], options)
      .filter((edge) => edge.to.domainId === domains[i + 1]);
    if (!candidates.length) throw new Error("domain path references missing portal transition");
    edges.push(candidates[0]);
  }
  Object.defineProperty(edges, "domains", { value: Object.freeze(domains), enumerable: false });
  return edges;
}
