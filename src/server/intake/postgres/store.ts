import { AccessStore } from '../../access/postgres/store.ts';
import { intakeConnection, type IntakeConfig, type IntakeRole } from '../config.ts';

/** Shares the existing admission domain, effective lock ordering and RR snapshot. */
export class IntakeStore extends AccessStore {
  readonly namespace: 'intake_trial' | 'intake_restore';
  private observation: ((event:Record<string,unknown>)=>void)|undefined;
  private observedPid:number|null=null;
  get backendPid(){return this.observedPid;}
  constructor(config: IntakeConfig, onLoss: () => void, role: IntakeRole = 'inc03_intake_runtime',observation?:(event:Record<string,unknown>)=>void) {
    const connectionString = role === 'inc03_intake_runtime' ? config.connectionString : config.readerConnectionString;
    intakeConnection(connectionString, role, config.expectedPort);
    super({ connectionString }, onLoss, role);
    this.namespace = config.namespace;
    this.observation=observation;
  }
  async admit(exclusive:boolean){
    await super.admit(exclusive);
    this.observedPid=(await this.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    this.observation?.({origin:'admission-boundary',kind:'acquired',backendPid:this.observedPid,atMs:Date.now()});
  }
  async releaseAdmission(){
    const pid=this.observedPid;
    if(pid!==null)this.observation?.({origin:'admission-boundary',kind:'release-requested',backendPid:pid,healthy:this.healthy,atMs:Date.now()});
    await super.releaseAdmission();
    if(pid!==null)this.observation?.({origin:'admission-boundary',kind:this.healthy?'released':'unreconciled',backendPid:pid,atMs:Date.now()});
    this.observedPid=null;
  }
  query(sql: string, values: unknown[] = []) {
    // The namespace is fixed by validated launch configuration, never request text.
    return this.client.query(sql.replaceAll('$INTAKE', this.namespace), values);
  }
}
