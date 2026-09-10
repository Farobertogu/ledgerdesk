import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Test-only observations. Never record bodies, headers, cookies or input values.
export function observeBrowser(page, directory) {
  let events = [],
    dropped = 0,
    active = false,
    step = 'not-started';
  const started = performance.now();
  const add = (event) => {
    if (!active) return;
    if (events.length === 1000) {
      dropped++;
      return;
    }
    events.push({ elapsedMs: performance.now() - started, step, ...event });
  };
  const location = (url) => {
    try {
      const path = new URL(url).pathname;
      return /^(?:\/$|\/material$|\/_next\/|\/favicon\.ico$|\/api\/(?:access\/v1|v1\/material)(?:\/|$))/.test(
        path,
      )
        ? path.slice(0, 256)
        : '[non-application-path]';
    } catch {
      return '[invalid-url]';
    }
  };
  const handlers = {
    request: (r) =>
      add({ event: 'request', method: r.method(), path: location(r.url()) }),
    response: (r) =>
      add({
        event: 'response',
        method: r.request().method(),
        path: location(r.url()),
        status: r.status(),
      }),
    requestfinished: (r) =>
      add({ event: 'finished', method: r.method(), path: location(r.url()) }),
    requestfailed: (r) =>
      add({
        event: 'failed',
        method: r.method(),
        path: location(r.url()),
        reason: /^net::[A-Z0-9_]+$/.test(r.failure()?.errorText ?? '')
          ? r.failure().errorText
          : '[network-failure]',
      }),
    pageerror: (e) => add({ event: 'page-error', name: e.name }),
    console: (m) => {
      if (m.type() === 'error') add({ event: 'console-error' });
    },
  };
  for (const [name, handler] of Object.entries(handlers))
    page.on(name, handler);
  return {
    mark(value) {
      step = value;
      add({ event: 'step' });
    },
    async run(name, action) {
      if (!/^[A-Z][0-9]{2}(?:-[a-z0-9-]+)?$/.test(name))
        throw Error('Invalid diagnostic case');
      events = [];
      dropped = 0;
      active = true;
      step = 'start';
      let passed = false;
      try {
        const result = await action();
        passed = true;
        return result;
      } finally {
        let timer;
        const state = await Promise.race([
          page
            .evaluate(() => ({
              ready: document.readyState,
              visibility: document.visibilityState,
              focusTag: document.activeElement?.tagName ?? null,
              originals: document.querySelectorAll('[data-testid="original"]')
                .length,
              alerts: document.querySelectorAll('[role="alert"]').length,
              statusElements:
                document.querySelectorAll('[role="status"]').length,
              sessionActive: [...document.querySelectorAll('h2')].some(
                (e) => e.textContent === 'Session active',
              ),
              pressedButtons: [...document.querySelectorAll('button')].flatMap(
                (e, i) =>
                  e.getAttribute('aria-pressed') === 'true' ? [i] : [],
              ),
              disabledButtons: [...document.querySelectorAll('button')].filter(
                (e) => e.disabled,
              ).length,
            }))
            .catch(() => ({ unavailable: true })),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), 3000);
          }),
        ]);
        clearTimeout(timer);
        active = false;
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `${name}-${randomUUID()}.json`),
          JSON.stringify(
            {
              profile: 'synthetic-browser-observation/1',
              case: name,
              passed,
              step,
              capturedAt: new Date().toISOString(),
              node: process.version,
              dropped,
              state,
              events,
            },
            null,
            2,
          ),
        );
      }
    },
    close() {
      for (const [name, handler] of Object.entries(handlers))
        page.off(name, handler);
    },
  };
}
