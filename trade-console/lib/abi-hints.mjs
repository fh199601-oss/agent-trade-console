import {parse} from 'acorn';
import {FunctionFragment} from 'ethers';

// Untrusted frontend ABI is a decoding proposal, never verified Solidity.
// Only static literals are read. No eval, imports, getters, calls or shell text.
export function publishedAbiHints(rows){
 const found=new Map(),conflicts=new Set();let count=0;
 const add=value=>{try{const f=FunctionFragment.from(value);if(++count>1500||f.inputs.length>8||f.outputs.length>8)return;const json=JSON.parse(f.format('json')),key=f.selector,prior=found.get(key);if(prior&&JSON.stringify(prior)!==JSON.stringify(json))conflicts.add(key);else found.set(key,json);}catch{}};
 const literal=(n,d=0)=>{if(d>15||!n)return undefined;if(n.type==='Literal')return n.value;if(n.type==='ArrayExpression')return n.elements.map(v=>literal(v,d+1));if(n.type==='ObjectExpression'){const out=Object.create(null);for(const p of n.properties){if(p.type!=='Property'||p.kind!=='init'||p.method||p.computed)return undefined;out[p.key.name??p.key.value]=literal(p.value,d+1);}return out;}return undefined;};
 const jsonVisit=(v,d=0)=>{if(d>12||!v)return;if(typeof v==='string'){if(/^function\s+\w+\(/.test(v))add(v);return;}if(typeof v!=='object')return;if(Array.isArray(v)){for(const x of v.slice(0,500))jsonVisit(x,d+1);}else if(v.type==='function')add(v);else for(const x of Object.values(v).slice(0,100))jsonVisit(x,d+1);};
 for(const row of rows.slice(0,60)){const text=row.text||'';if(text.length>2_500_000)continue;
  try{jsonVisit(JSON.parse(text));continue;}catch{}
  const scripts=/\.m?js(?:\?|$)/i.test(row.url||'')?[text]:[...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].slice(0,32).map(m=>m[1]);
  for(const script of scripts)try{const pending=[parse(script,{ecmaVersion:'latest',sourceType:'module'})];let visited=0;while(pending.length&&visited++<500000){const n=pending.pop();if(!n||typeof n!=='object')continue;if(n.type==='Literal'&&typeof n.value==='string'&&/^function\s+\w+\(/.test(n.value))add(n.value);if(n.type==='ObjectExpression'){const value=literal(n);if(value?.type==='function'){add(value);continue;}}for(const v of Object.values(n))if(Array.isArray(v)){for(const x of v)pending.push(x);}else if(v&&typeof v==='object')pending.push(v);}}catch{}
  // Typed human-readable documentation: never accept a supplied transaction.
  for(const m of text.matchAll(/\b([A-Za-z_]\w*\([^()\n]{0,240}\))\s*(?:view\s*)?(?:returns\s*|->\s*|→\s*)\(([^()\n]{1,280})\)/g))try{add('function '+m[1]+' view returns('+m[2]+')');}catch{}
 }
 return [...found].filter(([key])=>!conflicts.has(key)).slice(0,500).map(([,v])=>v);
}

// One bounded documented arithmetic form. It is only a candidate answer;
// the deployed checkAnswer() and zero-payment NFT preview must both validate
// it. No downloaded formula is evaluated as JavaScript or shell code.
export function publishedMintPuzzle(rows){
 const proposals=[];for(const {text=''} of rows.slice(0,60)){
  const digits=text.match(/last\s+(\d{1,2})\s+hex\s+characters/i),factor=text.match(/\bcode\s*=\s*H\s*\+\s*(\d{1,12})\s*[×*]\s*\(\s*M\s*\+\s*Q\s*\)/i);
  if(!digits||!factor||!text.includes('mintedBy(')||!text.includes('checkAnswer(address,uint256,uint256)'))continue;
  const hexDigits=Number(digits[1]);if(hexDigits<1||hexDigits>40||BigInt(factor[1])<=0n)continue;
  proposals.push({kind:'wallet-counter-answer',hexDigits,factor:factor[1]});
 }
 const unique=[...new Map(proposals.map(p=>[JSON.stringify(p),p])).values()];return unique.length===1?unique[0]:null;
}
