'use client';
import { useEffect, useState } from 'react';
import { sessionTransport, type SessionTransport } from '../../contracts/access_transport';
import MaterialReader from '../reading/MaterialReader';

/** The page supplies only transport coordinates, never identity or material. */
export default function AuthenticatedMaterial({ transport }: { transport: SessionTransport }) {
  const [ready,setReady] = useState(false);
  useEffect(() => {
    const config = sessionTransport(transport);
    setReady(window.location.origin === config.uiOrigin);
  },[transport]);
  return <>
    <nav aria-label="Account navigation" style={{padding:'16px 24px',background:'#f6f8fc',color:'#182d49'}}>
      <a href="/access">Account access</a>
    </nav>
    {ready ? <MaterialReader serviceOrigin={transport.terminalOrigin} transport={transport} /> :
      <main><h1>Material library</h1><p>Checking the reading connection…</p></main>}
  </>;
}
