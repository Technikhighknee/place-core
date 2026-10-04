export const PLACE_CORE_SNAPSHOT_VERSION = 1;

export function idKey(id) {
  return `${typeof id}:${String(id)}`;
}
