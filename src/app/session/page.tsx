import { PageHeading, Notice, Panel } from '@/components/Panel';
import { currentIdentity, listIdentities } from '@/server/session';
import { IdentityPicker } from './IdentityPicker';

export const dynamic = 'force-dynamic';

export default async function SessionPage() {
  const [identities, identity] = await Promise.all([listIdentities(), currentIdentity()]);

  return (
    <>
      <PageHeading
        title="Session"
        lead="Choosing an identity here sets the claims — organisation, role and subject — that every query of this session runs under. They are read from the seeded users, so the application never invents a role the database does not hold."
      />

      {identities.length === 0 ? (
        <Notice>
          No identities are seeded. Apply <span className="font-mono">seed/orgs.sql</span> to the
          database this build points at.
        </Notice>
      ) : (
        <Panel
          title="Seeded identities"
          hint="Two organisations exist on purpose: tenant isolation is only demonstrable when there is a second tenant whose rows the first must not see."
        >
          <IdentityPicker identities={identities} activeUserId={identity?.user_id ?? null} />
        </Panel>
      )}

      <p className="mt-6 max-w-2xl text-xs text-muted">
        This selector is not authentication and is not offered as any. Platform sign-in arrives with
        the identity integration; until then the honest description of this screen is that it picks
        which seeded user the next request claims to be.
      </p>
    </>
  );
}
