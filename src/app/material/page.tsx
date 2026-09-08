import { readTrialConfig } from '@/server/reading/config';

export const dynamic = 'force-dynamic';

// Preparation surface, not the T03 viewer and never a source of synthetic material.
export default function MaterialPreparationPage() {
  const enabled = readTrialConfig(process.env) !== null;
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1>Material reading · INC-01 trial</h1>
      <p>{enabled ? 'Trial configured; the reading service is not yet available.' : 'Trial is disabled.'}</p>
      <p>Technical setup only. This page contains no material and does not provide authentication.</p>
    </main>
  );
}
