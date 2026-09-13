import nodeAssert from 'node:assert/strict';

// Strict independent integer-only JSON reference reader. Preserve string code points;
// reject duplicate keys and invalid scalar encodings before canonical serialization.
export function canonicalReference(bytes, counter) {
  const assert = counter ? {ok:(v,m)=>counter.ok(v,m),equal:(a,b,m)=>counter.eq(a,b,m),fail:m=>counter.ok(false,m)} : nodeAssert;
  let text;
  try { text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); }
  catch { assert.fail('canonical.reference-utf8'); }
  let i=0;
  function ws() { while (/[\x20\t\r\n]/.test(text[i]??'') && i<text.length) i++; }
  function string() {
    const start=i++;
    while (i<text.length) {
      const x=text[i++];
      if (x==='\\') { i++; continue; }
      if (x==='"') {
        let value;
        try { value=JSON.parse(text.slice(start,i)); } catch { assert.fail('canonical.reference-string'); }
        for (let j=0;j<value.length;j++) {
          const u=value.charCodeAt(j);
          if (u>=0xd800 && u<=0xdbff) { const v=value.charCodeAt(++j); assert.ok(v>=0xdc00 && v<=0xdfff,'canonical.unpaired-surrogate'); }
          else assert.ok(u<0xdc00 || u>0xdfff,'canonical.unpaired-surrogate');
        }
        return value;
      }
    }
    assert.fail('canonical.unclosed-string');
  }
  function value(depth=0) {
    assert.ok(depth<=32,'canonical.depth'); ws();
    if (text[i]==='"') return JSON.stringify(string());
    if (text[i]==='[') {
      i++; ws(); const entries=[];
      if (text[i]===']') { i++; return '[]'; }
      while (true) { entries.push(value(depth+1)); ws(); if(text[i]===']') { i++; return `[${entries.join(',')}]`; } assert.equal(text[i++],',','canonical.array-delimiter'); }
    }
    if (text[i]==='{') {
      i++; ws(); const entries=new Map();
      if(text[i]==='}') { i++; return '{}'; }
      while (true) {
        ws(); assert.equal(text[i],'"','canonical.object-key'); const key=string();
        assert.ok(!entries.has(key),'canonical.duplicate-key'); ws(); assert.equal(text[i++],':','canonical.object-colon');
        entries.set(key,value(depth+1)); ws();
        if(text[i]==='}') { i++; break; } assert.equal(text[i++],',','canonical.object-delimiter');
      }
      const cmp=(a,b)=>{const x=Array.from(a, ch=>ch.codePointAt(0)),y=Array.from(b,ch=>ch.codePointAt(0));for(let k=0;k<Math.min(x.length,y.length);k++)if(x[k]!==y[k])return x[k]-y[k];return x.length-y.length;};
      return `{${[...entries.keys()].sort(cmp).map(k=>`${JSON.stringify(k)}:${entries.get(k)}`).join(',')}}`;
    }
    for (const literal of ['null','true','false']) if(text.startsWith(literal,i)){i+=literal.length;return literal;}
    const token=/^(?:0|[1-9]\d*)/.exec(text.slice(i));
    assert.ok(token,'canonical.integer-or-literal'); i+=token[0].length;
    assert.ok(Number.isSafeInteger(Number(token[0])),'canonical.safe-integer');
    return String(Number(token[0]));
  }
  const canonical=value(); ws(); assert.equal(i,text.length,'canonical.trailing-or-noninteger-input');
  return Buffer.from(canonical,'utf8');
}
