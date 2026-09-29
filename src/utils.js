import { createHash } from "node:crypto";

export function assertId(id, label = "id") {
  if ((typeof id !== "string" && typeof id !== "number") || String(id).length === 0) {
    throw new TypeError(`${label} must be a non-empty string or number`);
  }
  return id;
}

export function assertStringId(id, label = "id") {
  if (typeof id !== "string" || id.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return id;
}

export function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite number cannot be canonicalized");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([k, v]) => [k, canonicalize(v)]);
  }
  if (value instanceof Set) {
    return [...value.values()].sort((a, b) => String(a).localeCompare(String(b))).map(canonicalize);
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalStringify(value)).digest("hex");
}

export class BoundedEventQueue {
  #items = [];
  #limit;
  #overflowPolicy;
  #dropped = 0;

  constructor({ limit = 10_000, overflowPolicy = "drop-newest" } = {}) {
    this.configure({ limit, overflowPolicy });
  }

  configure({ limit = this.#limit, overflowPolicy = this.#overflowPolicy } = {}) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError("event queue limit must be a non-negative integer");
    if (!["drop-newest", "drop-oldest", "throw"].includes(overflowPolicy)) {
      throw new TypeError("invalid event overflow policy");
    }
    this.#limit = limit;
    this.#overflowPolicy = overflowPolicy;
    if (this.#items.length > limit) {
      const removed = this.#items.length - limit;
      if (overflowPolicy === "drop-newest") this.#items.length = limit;
      else this.#items.splice(0, removed);
      this.#dropped += removed;
    }
  }

  push(event) {
    if (this.#limit === 0 || this.#items.length >= this.#limit) {
      if (this.#overflowPolicy === "throw") throw new Error("place-core event queue overflow");
      if (this.#overflowPolicy === "drop-oldest" && this.#limit > 0) {
        this.#items.shift();
        this.#items.push(event);
      }
      this.#dropped += 1;
      return false;
    }
    this.#items.push(event);
    return true;
  }

  drain(target = []) {
    target.push(...this.#items);
    this.#items.length = 0;
    return target;
  }

  peek() { return [...this.#items]; }
  clear() { this.#items.length = 0; }
  resetDropped() { const v = this.#dropped; this.#dropped = 0; return v; }
  get size() { return this.#items.length; }
  get limit() { return this.#limit; }
  get overflowPolicy() { return this.#overflowPolicy; }
  get dropped() { return this.#dropped; }
}
