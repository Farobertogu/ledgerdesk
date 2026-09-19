/** Instrument only a preserved worker copy; no product or public fault switch. */
export function supervisedBudgetCopy(source) {
  const anchor='    const bytes = await originalBytes(request.binding);';
  if(source.split(anchor).length!==2)throw Error('EXTRACTION_BUDGET_FAULT_ANCHOR');
  return source.replace(anchor,anchor+`
    // Deliberately faulty producer after the real, bound original read.
    // The caller's trusted supervisor must retain exactly its byte cap.
    if(bytes.equals(Buffer.from('T03 supervised output reserve\\n'))){
      const write=chunk=>new Promise((resolve,reject)=>process.stdout.write(chunk,error=>error?reject(error):resolve()));
      const chunk=Buffer.alloc(65536,65);let left=EXTRACTION_BOUNDS.stdoutBytes-1;
      while(left){const n=Math.min(left,chunk.length);await write(chunk.subarray(0,n));left-=n;}
      await write(Buffer.from([0xc3,0xa9]));
      return;
    }`);
}
