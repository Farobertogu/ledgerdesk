import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {uiOrigin, apiOrigin, recipientEmail, password} from '../../access/journey_environment.mjs';
import {SESSION_COOKIE} from '../../../src/contracts/access_transport.ts';

// Use the existing accepted identity and ordinary UI login. No cookie injection,
// database-written effect or second observer substitutes for this journey.
export async function startWholeJourney(t, {env, page, context, client, controlled, observations, observer}) {
  let established = false;
  await t.test('JOURNEY-START empty corpus and visible login retain actual invitation ancestry', async () => {
    await observer.run('V01-whole-journey-login', async () => {
      const counts = (await env.admin.query(`SELECT
        (SELECT count(*)::int FROM material_trial.material) AS material,
        (SELECT count(*)::int FROM intake_trial.reception) AS receptions,
        (SELECT count(*)::int FROM intake_trial.extraction_result) AS extractions,
        (SELECT count(*)::int FROM intake_trial.preparation) AS preparations,
        (SELECT count(*)::int FROM intake_trial.candidate) AS candidates`)).rows[0];
      assert.deepEqual(counts, {material: 0, receptions: 0, extractions: 0, preparations: 0, candidates: 0});
      const ancestry = (await env.admin.query(`SELECT g.id, g.permission_id, g.acceptance_id, a.invitation_id
        FROM access_trial.grant_record g JOIN access_trial.acceptance a ON a.id=g.acceptance_id
        WHERE g.account_id=$1 ORDER BY g.permission_id`, [controlled.account.id])).rows;
      assert.ok(ancestry.some(row => row.permission_id === 'intake_constitute'));
      assert.ok(ancestry.every(row => row.acceptance_id && row.invitation_id));
      assert.deepEqual(await context.cookies(apiOrigin), []);
      const document = await page.goto(uiOrigin + '/access');
      assert.equal(document.status(), 200);
      await page.getByLabel('Email address', {exact: true}).fill(recipientEmail);
      await page.getByLabel('Password', {exact: true}).fill(password);
      const reply = page.waitForResponse(response => response.request().method() === 'POST' &&
        response.url() === apiOrigin + '/api/access/v1/sessions');
      await page.locator('form').getByRole('button', {name: 'Sign in', exact: true}).click();
      const response = await reply;
      assert.equal(response.status(), 200);
      // The login response stays in this document. Sensitive preparation bodies
      // later use the existing consumed-response observer, never a duplicate fetch.
      const body = await response.json();
      assert.equal(typeof body.csrf_token, 'string');
      await page.getByRole('heading', {name: 'Session active', exact: true}).waitFor();
      const cookie = (await context.cookies(apiOrigin)).find(row => row.name === SESSION_COOKIE);
      assert.ok(cookie && cookie.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
      const currentCookie = cookie.name + '=' + cookie.value;
      assert.notEqual(currentCookie, client.cookie, 'The browser must establish its own session through visible login.');
      client.cookie = currentCookie;
      client.csrf = body.csrf_token;
      observations.push({case: 'JOURNEY-START', emptyCorpus: counts, invitationAncestry: ancestry,
        login: 'ordinary-visible-form', plantedSessionCookies: 0,
        buildId: readFileSync('tests/access/final-ui/.next/BUILD_ID', 'utf8').trim()});
      await page.screenshot({path: '/work/output/whole-journey-login.png', fullPage: true});
      established = true;
    });
  });
  assert.equal(established, true, 'Do not start intake after the visible login prerequisite failed.');
}

export async function finishWholeJourney(t, {env, receipt, original, firstPrepared, firstCandidate, observations, errors}) {
  await t.test('JOURNEY-END the first produced candidate retains lineage without publishing material', async () => {
    const counts = (await env.admin.query(`SELECT
      (SELECT count(*)::int FROM material_trial.material) AS material,
      (SELECT count(*)::int FROM intake_trial.receipt) AS receipts,
      (SELECT count(*)::int FROM intake_trial.extraction_result) AS extractions,
      (SELECT count(*)::int FROM intake_trial.preparation) AS preparations,
      (SELECT count(*)::int FROM intake_trial.candidate) AS candidates`)).rows[0];
    assert.deepEqual(counts, {material: 0, receipts: 1, extractions: 1, preparations: 1, candidates: 1});
    assert.equal(firstPrepared.payload.inputs[0].original.sha256, receipt.sha256);
    const candidate = (await env.admin.query('SELECT * FROM intake_trial.candidate WHERE unit_id=$1', [firstCandidate.id])).rows[0];
    assert.equal(candidate.editorial_state, 'candidate');
    assert.deepEqual(candidate.provenance.preparation, firstPrepared.reference);
    const preparation = (await env.admin.query('SELECT * FROM intake_trial.preparation WHERE id=$1 AND revision=$2',
      [firstPrepared.reference.id,firstPrepared.reference.revision])).rows[0];
    assert.deepEqual(JSON.parse(preparation.payload.toString('utf8')),firstPrepared.payload);
    assert.equal(createHash('sha256').update(preparation.payload).digest('hex'),preparation.payload_sha256);
    assert.equal(createHash('sha256').update(original).digest('hex'),receipt.sha256);
    assert.equal(original.length,receipt.bytes);
    const differences=(await env.admin.query('SELECT * FROM intake_trial.preparation_difference WHERE preparation_id=$1 AND preparation_revision=$2 ORDER BY id',
      [preparation.id,preparation.revision])).rows;
    assert.deepEqual(differences.map(d=>({reference:{id:d.id,revision:d.revision,sha256:d.sha256},body:d.body})),firstPrepared.differences);
    const outcome=(await env.admin.query('SELECT * FROM intake_trial.constitution_outcome WHERE id=$1',[candidate.outcome_id])).rows[0];
    const proposal=(await env.admin.query('SELECT * FROM intake_trial.preparation_proposal WHERE id=$1',[outcome.proposal_id])).rows[0];
    assert.deepEqual(proposal.body.preparation,firstPrepared.reference);
    assert.deepEqual(errors, []);
    const result = {profile: 'intake-whole-journey/1', counts, receipt: receipt.id,
      original: {sha256: receipt.sha256, bytes: receipt.bytes}, preparation: firstPrepared.reference,
      differences: firstPrepared.differences.map(row => row.reference), candidate: firstCandidate,
      editorialState: candidate.editorial_state, observations,
      retainedHandoff:{originalBase64:original.toString('base64'),preparation:{...preparation,payload:undefined,
        payloadBase64:preparation.payload.toString('base64')},differences,candidate,proposal,outcome},
      limits: ['Synthetic declarations only.', 'No approval, publication or temporal conformity.']};
    writeFileSync('/work/output/whole-journey.json', JSON.stringify(result, null, 2), {flag: 'wx'});
  });
}
