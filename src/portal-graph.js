import { isPortalTraversable } from "./registry.js";

const caches = new WeakMap();

function portalKey(portal) {
  return `${typeof portal.placeId}:${String(portal.placeId ?? "")}:${portal.id}`;
}

function transitionKey(transition) {
  return `${portalKey(transition.portal)}:${transition.side}`;
}

function rebuild(registry) {
  const byDomain = new Map();
  let portalCount = 0;
  let transitionCount = 0;

  for (const portal of registry.resolvedPortals()) {
    if (!portal?.a || !portal?.b) continue;
    portalCount += 1;

    add(byDomain, portal.a.domainId, {
      portal,
      from: portal.a,
      to: portal.b,
      side: "a"
    });
    transitionCount += 1;

    if (portal.bidirectional !== false) {
      add(byDomain, portal.b.domainId, {
        portal,
        from: portal.b,
        to: portal.a,
        side: "b"
      });
      transitionCount += 1;
    }
  }

  for (const transitions of byDomain.values()) {
    transitions.sort((a, b) => transitionKey(a).localeCompare(transitionKey(b)));
    Object.freeze(transitions);
  }

  const cache = {
    graphRevision: registry.graphRevision,
    byDomain,
    portalCount,
    transitionCount
  };
  caches.set(registry, cache);
  return cache;
}

function add(byDomain, domainId, transition) {
  if (typeof domainId !== "string" || !domainId) return;
  let list = byDomain.get(domainId);
  if (!list) byDomain.set(domainId, list = []);
  list.push(Object.freeze(transition));
}

export function getPortalGraph(registry) {
  const cache = caches.get(registry);
  if (!cache || cache.graphRevision !== registry.graphRevision) return rebuild(registry);
  return cache;
}

export function getPortalTransitions(registry, domainId, {
  traversableOnly = true
} = {}) {
  const transitions = getPortalGraph(registry).byDomain.get(domainId) ?? EMPTY;
  if (!traversableOnly) return transitions;
  let result = null;
  for (let i = 0; i < transitions.length; i += 1) {
    const transition = transitions[i];
    if (!isPortalTraversable(transition.portal)) {
      if (!result) result = transitions.slice(0, i);
      continue;
    }
    if (result) result.push(transition);
  }
  return result ?? transitions;
}

export function getPortalGraphDiagnostics(registry) {
  const graph = getPortalGraph(registry);
  return {
    graphRevision: graph.graphRevision,
    indexedDomainCount: graph.byDomain.size,
    portalCount: graph.portalCount,
    transitionCount: graph.transitionCount
  };
}

export function invalidatePortalGraph(registry) {
  return caches.delete(registry);
}

const EMPTY = Object.freeze([]);
