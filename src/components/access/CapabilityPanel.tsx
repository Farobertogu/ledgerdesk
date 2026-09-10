'use client';
import {
  CAPABILITY_COPY,
  CAPABILITY_STATE_COPY,
  type Capability,
} from '../../contracts/access_presentation';
const labels: Record<string, string> = {
  logout: 'Sign out',
  session_status: 'Check session status',
  'material-list': 'List authorized material',
  'material-exact': 'Read authorized material',
  people: 'Authorized administration census',
};
export default function CapabilityPanel({
  capabilities,
}: {
  capabilities: Capability[];
}) {
  return (
    <section aria-label="Effective capabilities" className="capability-panel">
      <h2>What this session can do</h2>
      <p>
        Only disclosed capabilities are listed. These states describe the last
        server response, not a permanent permission.
      </p>
      <ul className="capability-list">
        {capabilities.map((c) => (
          <li key={c.capability_id} data-capability={c.capability_id}>
            <h3>{labels[c.capability_id] ?? c.capability_id}</h3>
            <dl className="capability-axes">
              <div>
                <dt>Implemented</dt>
                <dd>{c.implemented ? 'Yes' : 'No'}</dd>
              </div>
              <div>
                <dt>Enabled</dt>
                <dd>{c.enabled ? 'Yes' : 'No'}</dd>
              </div>
              <div>
                <dt>Authorized</dt>
                <dd>{CAPABILITY_STATE_COPY[c.authorized]}</dd>
              </div>
              <div>
                <dt>Executable</dt>
                <dd>{CAPABILITY_STATE_COPY[c.executable]}</dd>
              </div>
            </dl>
            <p>{CAPABILITY_COPY[c.explanation]}</p>
          </li>
        ))}
      </ul>
      {!capabilities.length && (
        <p>
          No capability view is currently confirmed. Refresh the session to
          check again.
        </p>
      )}
    </section>
  );
}
