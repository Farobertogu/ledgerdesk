import assert from 'node:assert/strict';
import {apiOrigin} from '../../access/journey_environment.mjs';

function latch() {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};}
export async function boundedResponse(promise, label, ms = 12000) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(label)), ms);})]);}
  finally {clearTimeout(timer);}
}
export async function installSession(context, client) {
  const separator = client.cookie.indexOf('=');
  await context.addCookies([{name: client.cookie.slice(0, separator), value: client.cookie.slice(separator + 1),
    url: apiOrigin, secure: true, httpOnly: true, sameSite: 'Strict'}]);
}

/** Hold one actual terminal response. No body, status, authority or response is
 * fabricated. Only sanitized route/status metadata leaves this helper. */
export async function holdResponse(context, page, match, {holdMs = 12000} = {}) {
  assert.ok(Number.isSafeInteger(holdMs) && holdMs > 0 && holdMs <= 12000, 'The response hold must remain within its existing bound.');
  const cdp = await context.newCDPSession(page), reached = latch(), release = latch(), finished = latch();
  let observation = null, failure = null, claimed = false, closed = false, networkId = null, aborted = false;
  await cdp.send('Network.enable');
  cdp.on('Network.loadingFailed', event => {
    if (event.requestId === networkId && event.canceled === true && event.errorText === 'net::ERR_ABORTED') aborted = true;
  });
  cdp.on('Fetch.requestPaused', async event => {
    let selected = false;
    try {
      if (claimed || !match(event.request)) {await cdp.send('Fetch.continueRequest', {requestId: event.requestId}); return;}
      claimed = true; selected = true; networkId = event.networkId;
      assert.ok([200, 202].includes(event.responseStatusCode), 'The held response must be a successful real control.');
      observation = {method: event.request.method, path: new URL(event.request.url).pathname, status: event.responseStatusCode};
      reached.resolve();
      await boundedResponse(release.promise, 'HELD_RESPONSE_NOT_RELEASED', holdMs);
      try {
        await cdp.send('Fetch.continueRequest', {requestId: event.requestId});
        observation.transport = 'continued';
      } catch (error) {
        // A local selection change aborts the real fetch. Do not treat the now
        // invalid interception as a successful continuation, or ignore other
        // protocol failures. Require Chrome's exact cancellation for this ID.
        if (!aborted || !String(error.message).includes('Invalid InterceptionId')) throw error;
        observation.transport = 'browser-cancelled';
      }
    } catch (error) {failure = error; reached.resolve();}
    finally {if (selected) finished.resolve();}
  });
  await cdp.send('Fetch.enable', {patterns: [{urlPattern: apiOrigin + '/api/*', requestStage: 'Response'}]});
  return {
    wait: async () => {await boundedResponse(reached.promise, 'ADOPTION_SITE_NOT_REACHED'); if (failure) throw failure; return observation;},
    release: async () => {release.resolve(); await boundedResponse(finished.promise, 'ADOPTION_RESPONSE_NOT_FINISHED'); if (failure) throw failure;},
    close: async () => {
      if (closed) return; closed = true; release.resolve();
      if (claimed) await boundedResponse(finished.promise, 'ADOPTION_CLEANUP_NOT_FINISHED');
      try {await cdp.send('Fetch.disable');} finally {await cdp.detach();}
      if (failure) throw failure;
    },
  };
}

export const sessionWarning = 'The session changed. Refresh and explicitly reconcile retained operations.';
export async function assertNoAdoption(page, downloads) {
  try {await page.getByText(sessionWarning, {exact: true}).waitFor({timeout: 5000});}
  catch (error) {if (error.name !== 'TimeoutError') throw error;}
  // Even a missing warning records the complete joint observation. A directed
  // guard mutation must expose the actual stale view, not only a wait timeout.
  assert.deepEqual({warning: await page.getByText(sessionWarning, {exact: true}).count(),
    rows: await page.locator('li[data-item-key]').count(), confirmationView: await page.getByRole('region', {name: 'Review the exact proposal', exact: true}).count(),
    preparation: await page.getByRole('region', {name: 'Human preparation', exact: true}).count(),
    original: await page.getByRole('region', {name: 'Original', exact: true}).count(),
    confirmation: await page.getByRole('button', {name: 'Confirm this proposal', exact: true}).count(), downloads: downloads.length},
  {warning: 1, rows: 0, confirmationView: 0, preparation: 0, original: 0, confirmation: 0, downloads: 0});
}
