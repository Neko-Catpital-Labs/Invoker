/**
 * Structural equality check for polling-hook payloads.
 *
 * Polling hooks in this package receive periodic responses from the main
 * process. When the response has not changed, calling `setState` with the
 * new object still churns identity, which invalidates downstream `useMemo`
 * dependencies and forces the App tree to re-render every poll tick. This
 * helper lets a hook skip the `setState` call when the incoming payload is
 * structurally equal to the previous one.
 *
 * The comparison is deliberately small and dependency-free. It covers:
 *   - primitives (Object.is semantics, so NaN === NaN)
 *   - null / undefined
 *   - Date instances (compared by getTime())
 *   - Arrays (elementwise)
 *   - Plain objects (own enumerable keys, recursive)
 *
 * Anything else falls back to reference identity. Callers should only pass
 * plain data shapes (the polling responses in this repo are plain JSON).
 */
export function areStructurallyEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    const arrA = a as unknown as unknown[];
    const arrB = b as unknown as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i += 1) {
      if (!areStructurallyEqual(arrA[i], arrB[i])) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!areStructurallyEqual(objA[key], objB[key])) return false;
  }
  return true;
}
