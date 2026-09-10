import {
  ACCESS_PROFILE,
  ACCESS_ROUTES,
  validateAccess,
  type AccessRoute,
} from './access.ts';

export const INTENT_CANONICAL_PROFILE = 'canon_m09_1' as const;
/** Unicode scalar order, never locale collation or UTF-16 code-unit order. */
export function scalarOrder(a: string, b: string): number {
  const x = [...a],
    y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
export function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    if (
      /[\uD800-\uDFFF]/u.test(
        value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''),
      )
    )
      throw new Error('CANONICAL_UNICODE');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
      throw new Error('CANONICAL_INTEGER');
    return String(value);
  }
  if (Array.isArray(value))
    return '[' + value.map(canonicalValue).join(',') + ']';
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      '{' +
      Object.keys(value)
        .sort(scalarOrder)
        .map(
          (k) =>
            canonicalValue(k) +
            ':' +
            canonicalValue((value as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  throw new Error('CANONICAL_VALUE');
}

export const routeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function accessPath(
  route: AccessRoute,
  parameters: Record<string, string> = {},
): string {
  const names = [...ACCESS_ROUTES[route].path.matchAll(/:([a-z_]+)/g)].map(
    (m) => m[1],
  );
  if (
    Object.keys(parameters).length !== names.length ||
    names.some((k) => !routeId.test(parameters[k] ?? ''))
  )
    throw new Error('INVALID_ROUTE_PARAMETERS');
  return ACCESS_ROUTES[route].path.replace(
    /:([a-z_]+)/g,
    (_, k) => parameters[k],
  );
}
export function resolveAccessPath(
  url: string,
): { route: AccessRoute; parameters: Record<string, string> } | null {
  if (/[?%#\\]/.test(url)) return null;
  for (const [route, definition] of Object.entries(ACCESS_ROUTES)) {
    if (definition.consumer !== 'T02' && definition.consumer !== 'T03')
      continue;
    const names: string[] = [];
    const pattern = definition.path.replace(/:([a-z_]+)/g, (_, k) => {
      names.push(k);
      return '([A-Za-z0-9][A-Za-z0-9._:-]{0,127})';
    });
    const match = new RegExp('^' + pattern + '$').exec(url);
    if (match)
      return {
        route: route as AccessRoute,
        parameters: Object.fromEntries(names.map((k, i) => [k, match[i + 1]])),
      };
  }
  return null;
}
export function canonicalIntent(
  route: AccessRoute,
  parameters: Record<string, string>,
  body: Record<string, unknown>,
): string {
  if (!validateAccess(route, 'request', body))
    throw new Error('INVALID_INTENT');
  accessPath(route, parameters);
  return canonicalValue({
    profile: INTENT_CANONICAL_PROFILE,
    contract: ACCESS_PROFILE,
    variant: route,
    path: { template: ACCESS_ROUTES[route].path, parameters },
    query: {},
    body,
  });
}
