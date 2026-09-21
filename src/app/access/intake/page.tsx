import IntakeWorkspace from '../../../components/intake/IntakeWorkspace';
import {sessionTransport} from '../../../contracts/access_transport';

export const dynamic = 'force-dynamic';
export default function Page() {
  try {
    if (process.env.LEDGERDESK_ACCESS_TRIAL !== 'synthetic') throw Error('Disabled');
    const transport = sessionTransport({profile: 'session/1', uiOrigin: process.env.LEDGERDESK_ACCESS_UI_ORIGIN,
      terminalOrigin: process.env.LEDGERDESK_ACCESS_API_ORIGIN});
    return <IntakeWorkspace transport={transport}/>;
  } catch {
    return <main><h1>Intake workspace</h1><p>The synthetic intake environment is not enabled.</p></main>;
  }
}
