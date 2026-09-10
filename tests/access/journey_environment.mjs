import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runtimeEnvironment } from './runtime_environment.mjs';
import { authorizedReadingMigration } from '../../ci/access_material_schema.mjs';
import { original, policy } from '../reading/T04_seed.mjs';

export const uiOrigin = 'https://ui.inc02.test:8443',
  apiOrigin = 'https://api.inc02.test:9443';
export const password = 'Synthetic whole journey password';
export const recipientEmail = 'reader@example.test';
export async function journeyEnvironment({
  facultiesTransform = (f) => f,
  omitDeclaration = false,
  installBootstrap = true,
} = {}) {
  const env = await runtimeEnvironment();
  try {
    await env.admin.query(authorizedReadingMigration());
    if (installBootstrap)
      await env.admin.query(
        readFileSync(
          new URL(
            '../../src/server/access/postgres/004_bootstrap.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    const until = env.root.termination.at - 1000;
    // External catalog/scope/support declarations, not generated invitations or permissions.
    await env.admin.query(`INSERT INTO access_trial.permission_definition VALUES
      ('invite','Invite','application',1,true,false),('read_material','Read material','application',1,true,false),
      ('read_people','Read scoped people','application',1,true,false),('approve','Approve','material_governance',1,true,true);
      INSERT INTO access_trial.scope_definition VALUES('organisation',NULL,'Organisation','synthetic-reading-trial',1,true),
      ('inc02-material','organisation','Material scope','synthetic-reading-trial',1,true);
      INSERT INTO access_trial.person_determination VALUES('reader@example.test','synthetic-recipient','declared-person-link')`);
    await env.admin.query(
      "INSERT INTO access_trial.support_definition VALUES('domain','domain',NULL,'Domain adoption','synthetic-adoption',$1,true,1)",
      [until],
    );
    const faculties = [
      ['invite', 'exercise'],
      ['read_material', 'grant'],
      ['read_people', 'exercise'],
    ].map(([permission_id, exercise_or_grant]) => ({
      permission_id,
      exercise_or_grant,
      scope_ref: 'organisation',
      support_ref: 'domain',
      permission_revision: 1,
      scope_revision: 1,
      support_revision: 1,
      expires_at: until,
    }));
    if (installBootstrap && !omitDeclaration)
      await env.admin.query(
        'INSERT INTO access_trial.bootstrap_declaration VALUES(true,$1,$2,$3,$4,$5)',
        [
          'initial-administration',
          'master@example.test',
          env.root.holderPersonRef,
          env.root,
          JSON.stringify(facultiesTransform(faculties)),
        ],
      );
    const readerPassword = randomBytes(24).toString('hex');
    await env.admin.query(
      `ALTER ROLE inc02_reader LOGIN PASSWORD '${readerPassword}'`,
    );
    const reading = {
      connectionString: `postgresql://inc02_reader:${readerPassword}@127.0.0.1:55432/inc02_synthetic`,
      expectedPort: 55432,
      generation: 'whole-journey-generation',
      cursorSeconds: 120,
      cursorLimit: 50,
      pageSize: 5,
    };
    await env.admin.query(
      'INSERT INTO material_trial.control VALUES(true,$1,1,true,true,true,true,true,true)',
      [reading.generation],
    );
    for (const [surface, permission] of [
      ['material-list', 'read_material'],
      ['material-exact', 'read_material'],
      ['people', 'read_people'],
    ])
      await env.admin.query(
        'INSERT INTO material_trial.surface VALUES($1,$2,$3,$4,true,true,true,1)',
        [surface, permission, 'inc02-material', 'synthetic-reading-trial'],
      );
    await env.admin.query(
      `INSERT INTO material_trial.material VALUES('inc02-synthetic','inc02-material','"content"','"v1"',$1,'en',$2,$3,$4)`,
      [
        JSON.stringify(original),
        JSON.stringify({
          title: 'Journey material',
          editorial_state: 'PUBLISHED',
          reading_conditions: ['Synthetic trial only.'],
        }),
        JSON.stringify([
          { fragment_id: 'rule', text: 'Regla.' },
          { fragment_id: 'exception', text: 'Excepto los domingos.' },
        ]),
        JSON.stringify({
          CONTENT: { metadata: ['title'] },
          REFERENCE: { metadata: ['title'] },
          EXCERPT: { metadata: ['title'], fragmentIds: ['rule', 'exception'] },
        }),
      ],
    );
    const config = {
      profile: 'access-runtime/1',
      synthetic: true,
      transport: { profile: 'session/1', uiOrigin, terminalOrigin: apiOrigin },
      security: {
        profile: 'access-trial/1',
        sessionSeconds: 1800,
        proofSeconds: 300,
        invitationSeconds: 86400,
        proofAttempts: 5,
        loginAttempts: 5,
        attemptWindowSeconds: 300,
        bodyBytes: 16384,
        resendSeconds: 1,
        resendLimit: 3,
        retryLimit: 2,
      },
      connectionString: env.runtimeConfig.connectionString,
      expectedPort: 55432,
      digestKey: randomBytes(32).toString('hex'),
    };
    // Instantiate the declared exact-reader policy once the real producer supplies the account ID.
    // Material publication/policy admission is an external fixture, not a T06 product operation.
    async function materialPolicy(
      accountId,
      maximum = 'CONTENT',
      expires = null,
    ) {
      const p = policy(maximum, expires);
      for (const row of p.unit) {
        const binding = {
          ...row.binding,
          deploymentId: 'inc02-synthetic',
          scopeId: 'inc02-material',
          subjectId: accountId,
          surface:
            row.binding.action === 'list' ? 'material-list' : 'material-exact',
          generation: reading.generation,
        };
        row.binding = binding;
        row.grant.binding = binding;
      }
      return p;
    }
    return { ...env, config, reading, faculties, materialPolicy };
  } catch (e) {
    await env.close();
    throw e;
  }
}
