import AccessPanel from '../../components/access/AccessPanel';
import { sessionTransport } from '../../contracts/access_transport';
export const dynamic = 'force-dynamic';
export default function AccessPage() {
  try {
    if (process.env.LEDGERDESK_ACCESS_TRIAL !== 'synthetic') throw new Error();
    const config = sessionTransport({
      profile: 'session/1',
      uiOrigin: process.env.LEDGERDESK_ACCESS_UI_ORIGIN,
      terminalOrigin: process.env.LEDGERDESK_ACCESS_API_ORIGIN,
    });
    return <AccessPanel apiOrigin={config.terminalOrigin} />;
  } catch {
    return (
      <main>
        <h1>Account access</h1>
        <p>The synthetic access environment is not enabled.</p>
      </main>
    );
  }
}
