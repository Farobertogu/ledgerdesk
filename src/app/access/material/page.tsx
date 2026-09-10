import AuthenticatedMaterial from '../../../components/access/AuthenticatedMaterial';
import { sessionTransport } from '../../../contracts/access_transport';
export const dynamic = 'force-dynamic';
export default function Page() {
  try {
    if (process.env.LEDGERDESK_ACCESS_TRIAL !== 'synthetic') throw new Error('Disabled');
    const transport = sessionTransport({ profile:'session/1',uiOrigin:process.env.LEDGERDESK_ACCESS_UI_ORIGIN,
      terminalOrigin:process.env.LEDGERDESK_ACCESS_API_ORIGIN });
    return <AuthenticatedMaterial transport={transport} />;
  } catch {
    return <main><h1>Material library</h1><p>The authenticated reading environment is not enabled.</p></main>;
  }
}
