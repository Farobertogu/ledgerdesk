export const hashA='a'.repeat(64),hashB='b'.repeat(64);
export const ref=(id='A-17',revision=1)=>({id,revision,sha256:hashA});
export const resource=(id='R-1',generation=7)=>({id,generation,bytes:9,sha256:hashA});
export function prepared(){return{
  profile:'prepared-material/1',preparation:ref('P-1',2),inputs:[ref()],
  elements:[
    {id:'rule',kind:'text',text:'AZ-17 requires Q.',antecedents:[{antecedent:ref(),kind:'bytes',coordinates:'line 1',byte_range:[0,17]}]},
    {id:'exception',kind:'text',text:'Under Z, R replaces Q.',antecedents:[{antecedent:ref(),kind:'bytes',coordinates:'line 2',byte_range:[17,38]}]},
    {id:'figure',kind:'resource',resource:resource(),antecedents:[{antecedent:ref(),kind:'bytes',coordinates:'figure 1'}]},
    {id:'values',kind:'table',cells:[{address:'A1',value:{kind:'text',lexical:'001'}},{address:'D2',value:{kind:'number_lexical',lexical:'24'},formula:'B2*C2',cached:{kind:'number_lexical',lexical:'24'},number_format:'0.00'}],antecedents:[]},
  ],
  relations:[{id:'dependency',from:'rule',to:'exception',role:'indispensable',scope:'AZ-17 under Z',origin:'observed'}],
  resources:[resource()],components:[{id:'body',execution:'completed',coverage:'partial',fidelity:'unchecked',limitations:['unsupported-picture'],incidents:['incident-1']}],
  incidents:[{id:'incident-1',component:'body',cause:'route_unoffered',detail:'Picture interpretation not offered.'}],
  differences:[{id:'change-1',before:ref(),after:ref('P-1',2),method:'correction',reason:'Corrected P to R against original.',affected:['exception']}],
  inventory:'known',current_use:'not_evaluated',
};}
export function commands(){
 const context={scope_id:'scope-1',purpose_id:'purpose-1',treatment_revision:ref('treatment')};
 const body=x=>({profile:'intake/1',...x});
 return {
 profiles:body({}),reserve_reception:body({original:{name:'synthetic.txt',bytes:9,sha256:hashA,declared_media_type:'text/plain'},format_profile:'text-utf8/1',receiving_context:context}),
 upload_original:new Uint8Array([1,2]),
 finalize_reception:body({expected_revision:1,original:resource(),format_profile:'text-utf8/1'}),
 lookup_operation:body({by:'operation',operation_id:'op-1'}),
 resume_reception:body({expected_revision:1,expected_generation:1,cause:'interrupted',original:resource()}),
 cancel_reception:body({expected_revision:1}),reception:body({}),original:body({}),extraction:body({}),
 reserve_preparation:body({inputs:[ref()],base:null,transformation:'exact_selection',selection:[{antecedent:ref(),element_id:'figure',resource:resource()}],payload:resource('payload'),context}),
 upload_preparation:new TextEncoder().encode(JSON.stringify(prepared())),
 finalize_preparation:body({expected_revision:1,payload:resource('payload'),differences:[ref('change-1')]}),
 preparation:body({}),resource:body({}),difference:body({}),
 propose:body({selection:['rule','exception'],intended_unit:'U-1',disposition:'new',basis:[ref()]}),
 constitute:body({proposal:ref('proposal'),intended_unit:'U-1',disposition:'new',mode:'person'}),
 };
}

