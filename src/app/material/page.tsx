import { readTrialConfig } from '@/server/reading/config';
import MaterialReader from '@/components/reading/MaterialReader';
import { randomUUID } from 'node:crypto';
import { readLoopbackOrigin } from '@/contracts/reading_origin';

export const dynamic = 'force-dynamic';

export default function MaterialPage() {
  const enabled = readTrialConfig(process.env) !== null;
  const serviceOrigin = readLoopbackOrigin(process.env.LEDGERDESK_READING_SERVICE_ORIGIN);
  // A new server render resets ephemeral browser state without exposing server identity.
  if (enabled && serviceOrigin) return <MaterialReader key={randomUUID()} serviceOrigin={serviceOrigin} />;
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1>Material reading · INC-01 trial</h1>
      <p>{enabled ? 'Reading service origin is not configured safely.' : 'Trial is disabled.'}</p>
      <p>Technical setup only. This page contains no material and does not provide authentication.</p>
    </main>
  );
}
