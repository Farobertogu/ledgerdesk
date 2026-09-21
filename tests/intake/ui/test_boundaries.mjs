import test from 'node:test';
import assert from 'node:assert/strict';
import {intakeViolations} from '../../../ci/intake_boundary_check.mjs';
import {accessSourceViolations} from '../../../ci/access_boundary_check.mjs';

test('BUI01 the named UI composition can use contracts, never server or legacy state', () => {
  const file = 'src/components/intake/controller.ts';
  for (const module of ['../../contracts/intake_workspace.ts', './client.ts', '../../contracts/access_canonical.ts'])
    assert.deepEqual(intakeViolations(file, `import '${module}';`), []);
  for (const module of ['../../server/intake/service.ts', '../../server/access/service.ts', '../demo/state.tsx', 'pg', 'next/server'])
    assert.ok(intakeViolations(file, `import '${module}';`).length, module);
  assert.ok(intakeViolations(file, 'import(moduleName);').length);
});

test('BUI02 legacy/API roots cannot acquire intake views or contracts indirectly', () => {
  for (const file of ['src/app/api/intake/route.ts', 'src/app/portal/page.tsx', 'src/components/legacy.tsx'])
    for (const module of ['@/contracts/intake_workspace.ts', '@/components/intake/IntakeWorkspace.tsx'])
      assert.ok(intakeViolations(file, `import '${module}';`).length, file + module);
  assert.ok(intakeViolations('src/server/intake/workspace/service.ts', "import '@/components/intake/controller.ts';").length);
  assert.ok(intakeViolations('src/contracts/intake_workspace.ts', "import '@/server/intake/workspace/service.ts';").length);
});

test('BUI03 the session boundary admits only the explicitly shared consumer links', () => {
  assert.deepEqual(accessSourceViolations('src/components/intake/client.ts', "import '../access/view_lifecycle.ts';"), []);
  assert.deepEqual(accessSourceViolations('src/server/intake/workspace/terminal.ts', "import '../../access/transport.ts';"), []);
  for (const file of ['src/components/intake/views/IntakeView.tsx', 'src/app/portal/page.tsx'])
    assert.ok(accessSourceViolations(file, "import '@/server/access/service.ts';").length);
  assert.ok(accessSourceViolations('src/components/intake/client.ts', "import '@/server/access/service.ts';").length);
});
