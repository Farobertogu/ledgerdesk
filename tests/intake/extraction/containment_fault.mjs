/** Fixed probes in an identified worker copy, never a product input option. */
export function containmentProbeCopy(source){
  const anchor='    const observation = await extract(bytes, formats[request.binding.format_profile]);';
  if(source.split(anchor).length!==2)throw Error('CONTAINMENT_PROBE_ANCHOR');
  return source.replace(anchor,`
    if(bytes.equals(Buffer.from('T03 bounded nontermination\\n')))await new Promise(()=>{setInterval(()=>{},1000);});
    let containment;
    if(bytes.equals(Buffer.from('T03 containment probes\\n'))){
      const caught=async action=>{try{await action();return 'ALLOWED';}catch(error){return error.code;}};
      const file=await caught(()=>fs.readFile('/etc/hostname'));
      const write=await caught(()=>fs.writeFile('/work/unauthorized-probe','x'));
      const {spawn}=await import('node:child_process');
      const subprocess=await caught(()=>new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['-e','process.exit(0)']);child.once('error',reject);child.once('close',resolve);
      }));
      const {createConnection}=await import('node:net');
      const network=await caught(()=>new Promise((resolve,reject)=>{
        const socket=createConnection({host:'198.18.0.1',port:9});
        const timer=setTimeout(()=>socket.destroy(Object.assign(Error('Probe timeout'),{code:'PROBE_TIMEOUT'})),1000);
        socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve();});
        socket.once('error',error=>{clearTimeout(timer);reject(error);});
      }));
      containment={file,write,subprocess,network,positiveOriginalBytes:bytes.length};
    }
${anchor}
    if(containment)observation.raw={adapterRaw:observation.raw,containment};`);
}
