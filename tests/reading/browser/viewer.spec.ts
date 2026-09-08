import { test, expect, type Page } from '@playwright/test';

const reference = (id: string) => ({ unit_id: id, version_id: 'v1' });
const list = { contract: 'reading/1', items: ['A', 'B'].map(id => ({ kind: 'REFERENCE', reference: reference(id), metadata: { title: `Material ${id}` } })), existence_signal: false };
const original = 'Original  e\u0301\r\n  <img src="https://invalid.example/leak">\nNOT TRANSLATED';
const detail = (id: string) => ({ contract: 'reading/1', projection: { kind: 'CONTENT', reference: reference(id), metadata: { title: `Material ${id}`, reading_conditions: ['Only under the stated conditions.'] }, original_language: 'es', original_text: original } });
async function mock(page: Page, listBody: unknown = list, detailBody: unknown = detail('A')) {
  await page.route('**/api/v1/material**', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'private, no-store' }, body: JSON.stringify(new URL(route.request().url()).pathname === '/api/v1/material' ? listBody : detailBody) }));
}
test('unimplemented service is an error, never an empty library', async ({ page }) => {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/material');
  await page.goto('/material');
  expect((await response).status()).toBe(503);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('could not complete');
  await expect(page.getByText('No readable references were returned.')).toHaveCount(0);
});
test('literal original survives ES/EN, remains inert and is not preloaded', async ({ page }) => {
  const originalRequests: string[] = [];
  const errors: string[] = [];
  // Measure the injected original's destination, not unrelated host/browser instrumentation.
  page.on('request', request => { if (new URL(request.url()).hostname === 'invalid.example') originalRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await mock(page);
  await page.goto('/material');
  await expect(page.getByTestId('original')).toHaveCount(0);
  await page.getByRole('button', { name: 'Material A' }).click();
  await expect(page.getByTestId('original')).toBeVisible();
  expect(await page.getByTestId('original').textContent()).toBe(original);
  await expect(page.locator('article img')).toHaveCount(0);
  await page.getByRole('combobox').selectOption('es');
  expect(await page.getByTestId('original').textContent()).toBe(original);
  await page.getByRole('combobox').selectOption('en');
  expect(await page.getByTestId('original').textContent()).toBe(original);
  await expect(page.getByText('Only under the stated conditions.')).toBeVisible();
  await page.screenshot({ path: 'test-results/viewer-desktop.png', fullPage: true });
  expect(originalRequests).toEqual([]); expect(errors).toEqual([]);
});
test('rapid selection shows only the latest detail and no intermediate original', async ({ page }) => {
  await mock(page, list, detail('B'));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/material/A/versions/v1', async route => {
    await blocked;
    await route.fulfill({ status:200, contentType:'application/json', headers:{ 'cache-control':'private, no-store' }, body:JSON.stringify({ ...detail('A'), projection:{ ...detail('A').projection, original_text:'STALE A' } }) }).catch(() => {});
  });
  await page.goto('/material');
  const request = page.waitForRequest('**/api/v1/material/A/versions/v1');
  await page.getByRole('button', { name:'Material A' }).click(); await request;
  await expect(page.getByTestId('original')).toHaveCount(0);
  await page.getByRole('button', { name:'Material B' }).click();
  await expect(page.getByTestId('original')).toHaveText(original);
  release();
  await expect(page.getByRole('heading', { level:2 })).toHaveText('Material B');
  await expect(page.getByText('STALE A')).toHaveCount(0);
});
test('local filtering differs from legitimate empty results and performs no request', async ({ page }) => {
  let requests = 0; page.on('request', req => { if (req.url().includes('/api/v1/material')) requests++; });
  await mock(page); await page.goto('/material');
  await expect(page.getByRole('button', { name: 'Material A' })).toBeVisible();
  const before = requests;
  await page.getByRole('searchbox').fill('unmatched');
  await expect(page.getByRole('status')).toContainText('match this filter');
  expect(requests).toBe(before);
  await page.unrouteAll(); await mock(page, { ...list, items: [] });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No readable references');
});
test('mobile back restores focus to the selected reference', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mock(page); await page.goto('/material');
  const item = page.getByRole('button', { name: 'Material A' }); await item.focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('original')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
  await page.screenshot({ path: 'test-results/viewer-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(item).toBeVisible(); await expect(item).toBeFocused();
  await expect(page.getByTestId('original')).toHaveCount(0);
});
test('mismatched detail clears material and retry reads a fresh list', async ({ page }) => {
  await mock(page, list, detail('B')); await page.goto('/material');
  await page.getByRole('button', { name: 'Material A' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('safely');
  await expect(page.getByRole('button', { name: 'Material A' })).toHaveCount(0);
  await page.unrouteAll(); await mock(page);
  await page.getByRole('button', { name: 'Retry reading' }).click();
  await expect(page.getByRole('button', { name: 'Material A' })).toBeVisible();
});
test('reference-only and excerpt projections do not invent a complete body', async ({ page }) => {
  await mock(page, list, { contract: 'reading/1', projection: list.items[0] }); await page.goto('/material');
  await page.getByRole('button', { name: 'Material A' }).click();
  await expect(page.getByText('Reference only. No original text was returned.')).toBeVisible();
  await expect(page.getByTestId('original')).toHaveCount(0);
  await page.unrouteAll(); await mock(page, list, { contract: 'reading/1', projection: { kind: 'EXCERPT', reference: reference('A'), metadata: {}, original_language: 'en', fragments: [{ fragment_id: 'f1', text: 'First  fragment' }, { fragment_id: 'f2', text: '\nSecond fragment' }] } });
  await page.getByRole('button', { name: 'Material A' }).click();
  await expect(page.getByTestId('original')).toHaveCount(2);
  expect(await page.getByTestId('original').allTextContents()).toEqual(['First  fragment', '\nSecond fragment']);
});
test('leaving the page clears material before a new reading session', async ({ page }) => {
  await mock(page); await page.goto('/material'); await page.getByRole('button', { name: 'Material A' }).click();
  await expect(page.getByTestId('original')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.getByTestId('original')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  await expect(page.getByRole('button', { name: 'Material A' })).toBeVisible();
  await expect(page.getByTestId('original')).toHaveCount(0);
});
