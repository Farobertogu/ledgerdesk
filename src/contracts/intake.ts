/** Experimental contracts only. No route in this inventory is mounted. */
export const INTAKE_PROFILE = 'intake/1' as const;
export const INTAKE_LIMITS = Object.freeze({
  commandBytes: 65536, originalBytes: 1048576, artifactBytes: 8388608,
  stderrBytes: 8192, wallMs: 10000, heapMiB: 128,
  memoryMiB: 512, pids: 64, fileDescriptors: 128, concurrency: 1,
});
export type Rule = (value: unknown) => boolean;
export const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
export const scalarText: Rule = v => typeof v === 'string' &&
  !/[\uD800-\uDFFF]/u.test(v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
export const text = (max: number): Rule => v => scalarText(v) && (v as string).length <= max;
export const identifier: Rule = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export const integer: Rule = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
export const revision: Rule = v => integer(v) && (v as number) > 0;
export const digest: Rule = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const choice = (...values: unknown[]): Rule => v => values.includes(v);
export const array = (item: Rule, max = 128): Rule => v => Array.isArray(v) && v.length <= max && Object.keys(v).length===v.length && v.every(item);
export const closed = (required: Record<string, Rule>, optional: Record<string, Rule> = {}): Rule => v =>
  record(v) && Object.keys(required).every(k => Object.hasOwn(v,k) && required[k](v[k])) &&
  Object.keys(v).every(k => Object.hasOwn(required,k) || Object.hasOwn(optional,k) && optional[k](v[k]));
export const exactReference = closed({ id: identifier, revision, sha256: digest });
export const artifactReference = closed({ id: identifier, generation: revision, bytes: v => integer(v) && (v as number) <= INTAKE_LIMITS.artifactBytes, sha256: digest });
const context = closed({ scope_id: identifier, purpose_id: identifier, treatment_revision: exactReference });
const profile = choice('text-utf8/1','markdown-inert/1','csv-utf8/1','xlsx-cells/1');
const selection = closed({ antecedent: exactReference, element_id: text(128), resource: artifactReference });
const intakeBody = (fields: Record<string, Rule>, optional: Record<string, Rule> = {}): Rule => closed({ profile: choice(INTAKE_PROFILE), ...fields }, optional);
const empty = intakeBody({});
const finalize = intakeBody({ expected_revision: revision, original: artifactReference, format_profile: profile });
const original = closed({ name: text(256), bytes: v => integer(v) && (v as number) <= INTAKE_LIMITS.originalBytes, sha256: digest, declared_media_type: text(128) });
const reception = intakeBody({ original, format_profile: profile, receiving_context: context });
const prep = intakeBody({ inputs: array(exactReference), base: v => v === null || exactReference(v), transformation: choice('exact_selection','correction','synthesis'), selection: array(selection,10000), payload: artifactReference, context });
const lookup: Rule = v => intakeBody({ by: choice('operation'), operation_id: identifier })(v) ||
  intakeBody({ by: choice('intention'), act: identifier, variant: identifier, client_key: identifier })(v);
type RouteDefinition = {
  method: 'GET'|'POST'; path: string; request: Rule; binding: string;
  consumer: 'T02'|'T03'|'T04'; media: 'application/json'|'application/octet-stream';
  effect: 'query'|'intention'|'continuation'; maxBytes: number;
};
const route = (method: 'GET'|'POST', path: string, request: Rule, binding: string, consumer: 'T02'|'T03'|'T04', effect: RouteDefinition['effect'] = 'query', binary = false): RouteDefinition =>
  ({ method, path:'/api/intake'+path, request, binding, consumer, effect,
    media: binary?'application/octet-stream':'application/json',
    maxBytes:binary?INTAKE_LIMITS.originalBytes:INTAKE_LIMITS.commandBytes });
export const INTAKE_ROUTES = Object.freeze({
  profiles: route('GET','/profiles',empty,'view_profile','T02'),
  reserve_reception: route('POST','/receptions',reception,'load','T02','intention'),
  upload_original: route('POST','/receptions/:id/attempts/:generation/original',v => v instanceof Uint8Array && v.byteLength <= INTAKE_LIMITS.originalBytes,'load_continuation','T02','continuation',true),
  finalize_reception: route('POST','/receptions/:id/finalize',finalize,'load_continuation','T02','intention'),
  lookup_operation: route('POST','/operations/lookup',lookup,'view_operation','T02'),
  resume_reception: route('POST','/receptions/:id/resume',intakeBody({ expected_revision:revision, expected_generation:revision, cause:choice('interrupted','known_failure'), original:artifactReference }),'resume_reception','T02','intention'),
  cancel_reception: route('POST','/receptions/:id/cancel',intakeBody({ expected_revision:revision }),'stop_reception','T02','intention'),
  reception: route('GET','/receptions/:id',empty,'view_receipt','T02'),
  original: route('GET','/receptions/:id/original',empty,'view_original','T02'),
  extraction: route('GET','/extractions/:id',empty,'view_extraction','T03'),
  reserve_preparation: route('POST','/preparation-attempts',prep,'prepare_material','T04','intention'),
  upload_preparation: { ...route('POST','/preparation-attempts/:id/content',v => v instanceof Uint8Array && v.byteLength <= INTAKE_LIMITS.artifactBytes,'prepare_continuation','T04','continuation'), maxBytes:INTAKE_LIMITS.artifactBytes },
  finalize_preparation: route('POST','/preparation-attempts/:id/finalize',intakeBody({ expected_revision:revision, payload:artifactReference, differences:array(exactReference) }),'prepare_material','T04','intention'),
  preparation: route('GET','/preparations/:id/revisions/:revision',empty,'view_preparation','T04'),
  resource: route('GET','/preparations/:id/revisions/:revision/resources/:resource_id',empty,'view_resource','T04'),
  difference: route('GET','/differences/:id',empty,'view_difference','T04'),
  propose: route('POST','/preparations/:id/revisions/:revision/proposals',intakeBody({ selection:array(identifier), intended_unit:identifier, disposition:choice('new','successor','relationship'), basis:array(exactReference) }),'prepare_proposal','T04','intention'),
  constitute: route('POST','/constitutions',intakeBody({ proposal:exactReference, intended_unit:identifier, disposition:choice('new','successor','relationship'), mode:choice('person','authorized_consequence') },{ prior_act:exactReference }),'constitute','T04','intention'),
} satisfies Record<string,RouteDefinition>);
export type IntakeRoute = keyof typeof INTAKE_ROUTES;
export function intakePath(key: IntakeRoute, parameters: Record<string,string>): string {
  const definition = INTAKE_ROUTES[key];
  if (!definition || !record(parameters)) throw Error('INTAKE_ROUTE');
  const names=[...definition.path.matchAll(/:([a-z_]+)/g)].map(m=>m[1]);
  if(Object.keys(parameters).length!==names.length || names.some(n=>!identifier(parameters[n]) ||
    ['generation','revision'].includes(n) && !/^[1-9][0-9]*$/.test(parameters[n]) ||
    ['generation','revision'].includes(n) && !revision(Number(parameters[n])))) throw Error('INTAKE_PARAMETERS');
  return definition.path.replace(/:([a-z_]+)/g,(_,n:string)=>parameters[n]);
}
export function validateIntake(key: IntakeRoute, value: unknown): boolean {
  const definition=INTAKE_ROUTES[key];
  if (!definition || !definition.request(value)) return false;
  if(key==='constitute' && record(value)) return value.mode==='authorized_consequence' ? exactReference(value.prior_act) : !Object.hasOwn(value,'prior_act');
  if(key==='reserve_preparation' && record(value)) return (value.inputs as unknown[]).length>0;
  return true;
}
/** Strict command decoder, including duplicate keys and lexical integer checks. */
function decodeStrict(bytes: Uint8Array, maxBytes:number): unknown {
  if (bytes.byteLength>maxBytes) throw Error('INTAKE_BODY_LIMIT');
  const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  let i=0;
  const whitespace=()=>{while(/[ \r\n\t]/.test(source[i]??'!')) i++;};
  const string=():string=>{
    const start=i++;
    while(i<source.length){const c=source[i++]; if(c==='\\'){i++;continue;} if(c==='"'){
      const value:unknown=JSON.parse(source.slice(start,i)); if(!scalarText(value)) throw Error('INTAKE_UNICODE'); return value as string;
    }}
    throw Error('INTAKE_STRING');
  };
  const value=(depth:number):unknown=>{
    if(depth>32) throw Error('INTAKE_DEPTH');
    whitespace();
    if(source[i]==='"') return string();
    if(source[i]==='{'){
      i++; whitespace(); const entries:[string,unknown][]=[]; const keys=new Set<string>();
      if(source[i]==='}'){i++;return {};}
      while(true){whitespace();if(source[i]!=='"') throw Error('INTAKE_KEY');const key=string();if(keys.has(key))throw Error('INTAKE_DUPLICATE_KEY');keys.add(key);
        whitespace();if(source[i++]!==':')throw Error('INTAKE_COLON');entries.push([key,value(depth+1)]);whitespace();const next=source[i++];if(next==='}')break;if(next!==',')throw Error('INTAKE_OBJECT');}
      return Object.fromEntries(entries);
    }
    if(source[i]==='['){i++;whitespace();const a:unknown[]=[];if(source[i]===']'){i++;return a;}while(true){a.push(value(depth+1));whitespace();const next=source[i++];if(next===']')break;if(next!==',')throw Error('INTAKE_ARRAY');}return a;}
    for(const [token,result] of [['true',true],['false',false],['null',null]] as const) if(source.startsWith(token,i)){i+=token.length;return result;}
    const token=/^[^,\]}\s]+/.exec(source.slice(i))?.[0]??'';
    if(!/^(0|[1-9][0-9]*)$/.test(token)||!integer(Number(token)))throw Error('INTAKE_INTEGER');
    i+=token.length;return Number(token);
  };
  const result=value(0);whitespace();if(i!==source.length)throw Error('INTAKE_TRAILING');
  return result;
}
export function decodeIntake(bytes:Uint8Array):unknown{return decodeStrict(bytes,INTAKE_LIMITS.commandBytes);}
export function decodePreparedJson(bytes:Uint8Array):unknown{return decodeStrict(bytes,INTAKE_LIMITS.artifactBytes);}
/** Uses the caller's existing scalar serializer; never imports an access dispatcher. */
export function canonicalIntake(key:IntakeRoute, parameters:Record<string,string>, body:unknown, serialize:(v:unknown)=>string):string {
  intakePath(key,parameters);
  if(!validateIntake(key,body)||INTAKE_ROUTES[key].media!=='application/json'||body instanceof Uint8Array)throw Error('INTAKE_INTENT');
  return serialize({profile:'canon_m09_1',contract:INTAKE_PROFILE,variant:key,path:{template:INTAKE_ROUTES[key].path,parameters},query:{},body});
}
export const WORKER_REQUEST = closed({
  profile:choice('intake-worker/1'), operation_id:identifier, generation:revision,
  original:artifactReference, format_profile:profile, limits_revision:exactReference,
});
const profileRegistryShape = closed({
 profile:choice('intake-profile/1'),revision,operational:choice(false),
 node:choice('22.16.0'),
 candidates:array(closed({format:profile,adapter:choice('text','csv','xlsx'),source:exactReference}),4),
 limits:closed({
  input_bytes:choice(1048576),expanded_bytes:choice(8388608),members:choice(128),sheets:choice(8),cells:choice(10000),
  csv_records:choice(1000),csv_columns:choice(64),csv_record_utf16_units:choice(65536),
  stdout_bytes:choice(8388608),stderr_bytes:choice(8192),wall_ms:choice(10000),heap_mib:choice(128),
  container_memory_mib:choice(512),container_swap_mib:choice(0),cpu_quota:choice(1),pids:choice(64),file_descriptors:choice(128),concurrency:choice(1),
 }),
});
export const PROFILE_REGISTRY:Rule=value=>{
 if(!profileRegistryShape(value)||!record(value))return false;
 const candidates=value.candidates as {format:string;adapter:string}[];
 const adapters:Record<string,string>={'text-utf8/1':'text','markdown-inert/1':'text','csv-utf8/1':'csv','xlsx-cells/1':'xlsx'};
 return new Set(candidates.map(c=>c.format)).size===candidates.length&&candidates.every(c=>adapters[c.format]===c.adapter);
};
export const WORKER_RESULT = closed({
  profile:choice('intake-worker/1'), operation_id:identifier, generation:revision,
  execution:choice('completed','failed','not_attempted','unknown'), output:v=>v===null||artifactReference(v),
  primary_cause:choice(null,'timeout','output_limit','invalid_output_utf8','process_failure','unreadable','route_unoffered'),
  diagnostics:closed({stdoutEncodingError:choice(true,false),stderrEncodingError:choice(true,false),stdoutTruncated:choice(true,false),stderrTruncated:choice(true,false)}),
});
export const INTAKE_RESPONSE = closed({
  profile:choice(INTAKE_PROFILE), state:choice('reserved','known_effect','uncertain','conflict','unavailable','not_completed'),
  operation_id:identifier, effect:v=>v===null||exactReference(v),
});
/** Does not authorize disclosure. The service separately admits the current query. */
export function reconcileDisposition(known:boolean,compatible:boolean):'known_effect'|'conflict'|'uncertain' {
  return !compatible?'conflict':known?'known_effect':'uncertain';
}
