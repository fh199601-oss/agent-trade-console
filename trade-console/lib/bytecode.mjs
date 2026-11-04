// Solidity appends a CBOR map after an INVALID opcode and a two-byte length.
// Decode the trailer before scanning instructions: hashes are data, not opcodes.
export function executableBytes(code='0x'){
 const bytes=Buffer.from(code.slice(2),'hex');
 if(bytes.length<6)return bytes;
 const length=bytes.readUInt16BE(bytes.length-2),start=bytes.length-length-2;
 if(length<8||length>1024||start<1)return bytes;
 const data=bytes.subarray(start,bytes.length-2);let offset=0,nodes=0;
 // solc can append constant data (e.g. a Base64 alphabet) between INVALID
 // and CBOR. Find an actual instruction boundary, not a byte inside PUSH data.
 // Remove a suffix only if INVALID blocks fall-through and the entire suffix
 // contains no EVM-valid JUMPDEST. A hash byte inside PUSH data is not a target.
 let cut=null;
 for(let p=0;p<bytes.length;p++){
  const op=bytes[p];if(op===0x5b)cut=null;
  if(op===0xfe&&p<start)cut=p+1;
  if(op>=0x60&&op<=0x7f)p+=op-0x5f;
 }
 if(cut===null||start-cut>4096)return bytes;
 const decode=()=>{
  if(++nodes>40||offset>=data.length)throw Error('CBOR bounds');
  const head=data[offset++],major=head>>5,info=head&31;
  let n=info;if(info===24){if(offset>=data.length)throw Error('CBOR bounds');n=data[offset++];}
  else if(info===25){if(offset+2>data.length)throw Error('CBOR bounds');n=data.readUInt16BE(offset);offset+=2;}
  else if(info>=26)throw Error('Unsupported CBOR');
  if(major===0)return n;
  if(major===2||major===3){if(offset+n>data.length)throw Error('CBOR bounds');const v=data.subarray(offset,offset+n);offset+=n;return major===3?v.toString('utf8'):v;}
  if(major===5){const map=new Map();for(let i=0;i<n;i++){const key=decode();if(typeof key!=='string'||map.has(key))throw Error('CBOR keys');map.set(key,decode());}return map;}
  if(major===7&&info<=23)return info;
  throw Error('Unsupported CBOR');
 };
 try{
  const meta=decode(),compiler=meta instanceof Map&&meta.get('solc');
  if(offset!==data.length||!Buffer.isBuffer(compiler)||compiler.length!==3)return bytes;
  const ipfs=meta.get('ipfs');
  if(ipfs&&(!Buffer.isBuffer(ipfs)||ipfs.length!==34||ipfs[0]!==0x12||ipfs[1]!==0x20))return bytes;
  if([...meta.keys()].some(k=>!['ipfs','bzzr0','bzzr1','solc','experimental'].includes(k)))return bytes;
  return bytes.subarray(0,cut);
 }catch{return bytes;}
}
export function runtimeShape(code='0x'){
 const bytes=executableBytes(code),ops=[];
 for(let p=0;p<bytes.length;p++){const op=bytes[p],size=op>=0x60&&op<=0x7f?op-0x5f:0;ops.push({op,data:bytes.subarray(p+1,p+1+size).toString('hex')});p+=size;}
 // Leading-zero selectors may use PUSH3; the final dispatcher branch may
 // reject non-matches with SUB/XOR + JUMPI instead of EQ + JUMPI.
 const selectors=new Set();for(let i=0;i<ops.length;i++)if(ops[i].op>=0x60&&ops[i].op<=0x63&&[0x14,0x03,0x18].includes(ops[i+1]?.op)&&ops.slice(i+2,i+5).some(o=>o.op===0x57))selectors.add('0x'+ops[i].data.padStart(8,'0'));
 return {selectors,delegate:ops.some(o=>o.op===0xf4),executableBytes:bytes.length};
}
