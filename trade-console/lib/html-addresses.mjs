// Associate a visible label with its adjacent address, not every address in
// the enclosing section. Script/style contents and distant sections are excluded.
export function htmlAddressPairs(html){
 const root={children:[]},stack=[root];let count=0;
 for(const m of html.matchAll(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g)){
  if(++count>50000||stack.length>128)return [];const s=m[0];if(s.startsWith('<!--'))continue;
  if(s.startsWith('</')){const tag=s.match(/^<\/([\w-]+)/)?.[1].toLowerCase();for(let i=stack.length-1;i>0;i--)if(stack[i].tag===tag){stack.length=i;break;}continue;}
  if(s.startsWith('<')){const tag=s.match(/^<([\w-]+)/)?.[1].toLowerCase(),node={tag,children:[],html:s};stack.at(-1).children.push(node);if(!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)&&!s.endsWith('/>'))stack.push(node);continue;}
  stack.at(-1).children.push({text:s});
 }
 const plain=n=>n.text??(['script','style','template'].includes(n.tag)?'':n.children.map(plain).join(' '));
 const raw=n=>n.text??(['script','style','template'].includes(n.tag)?'':(n.html||'')+n.children.map(raw).join(' '));
 const pairs=[];
 const visit=n=>{if(!n.children||['script','style','template'].includes(n.tag))return;
  const children=n.children.filter(c=>c.tag||c.text?.trim());
  for(let i=0;i<children.length-1;i++){
   const label=plain(children[i]).replace(/&nbsp;|&#160;/gi,' ').replace(/\s+/g,' ').trim();
   if(!label||label.length>180||/0x[\da-f]{6}/i.test(label))continue;
   // Only the immediately following element is associated. Repeated copy /
   // explorer links need no extra hint, and cannot bleed into the next label.
   const body=raw(children[i+1]),addresses=[...new Set((body.match(/0x[\da-f]{40}(?![\da-f])/gi)||[]).map(a=>a.toLowerCase()))];
   if(addresses.length===1)pairs.push({label,address:addresses[0]});
  }
  n.children.forEach(visit);
 };visit(root);return pairs;
}
