// Executed scenario inventory. The independent CI obligation fixture checks it.
export const normal = [
  ['units',['--group','units']],['runtime',['--group','runtime']],['boundaries',['--group','boundaries']],
  ['temporal-observation',['--group','temporal']],['integrity-restart',['--group','integrity']],
  ['browser',['--group','browser']],['phase-lifecycle',['--group','phase-prototype']],
];
export const recovery = [
  ['guarded-sql',['--group','fence-sql']],
  ...['sql','runtime','supervisor'].map(kind=>['lost-'+kind,['--group','fence-loss','--loss-kind',kind,'--without-worker-stop']]),
  ...['append','seal','read','close'].map(kind=>['lost-'+kind+'-ack',['--group','fence-ack','--ack-kind',kind]]),
  ...['rollback','reply-loss'].map(kind=>['commit-'+kind,['--group','fence-commit','--commit-kind',kind]]),
  ['fresh-continuation',['--group','fence-continuation']],['queued-old-channel',['--group','fence-ipc']],
  ['restore-during-phase',['--group','fence-restore']],
];
export const finite = [
  ...['authority','missing-catalog','transitions','neutrality','original-scope','fragment-permissions','privileges',
    'transactions','delivery-order','finite-stream','finite-quota','finite-attempts'].map(group=>[group,['--group',group]]),
  ['receipt-commit-reply-loss',['--group','transactions','--receipt-commit-loss']],
];
export const plans = {
  recovery,
  verification:[...normal,['coupled-access',['--group','fence-coupled']],...recovery],
  behavior:[...normal,...finite],
  'recovery-with-access':[...recovery,['coupled-access',['--group','fence-coupled']]],
};
