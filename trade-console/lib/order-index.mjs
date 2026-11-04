import fs from 'node:fs';
import path from 'node:path';

// Read-only index: atomic order files remain the source of truth. Check every
// file's inode/ctime/mtime/size so another CLI process cannot hide a pending
// order behind a cached directory listing. No balance or quote is cached here.
export class OrderIndex {
 constructor(dir){this.dir=dir;this.rows=new Map();}
 invalidate(file){this.rows.delete(path.basename(file));}
 sync(){
  const names=fs.readdirSync(this.dir).filter(n=>n.endsWith('.json')),seen=new Set(names);
  for(const name of this.rows.keys())if(!seen.has(name))this.rows.delete(name);
  const signature=s=>[s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
  for(const name of names){const file=path.join(this.dir,name);let done=false;
   for(let attempt=0;attempt<3&&!done;attempt++)try{
    const before=signature(fs.statSync(file,{bigint:true}));if(this.rows.get(name)?.signature===before){done=true;break;}
    const row=JSON.parse(fs.readFileSync(file,'utf8')),after=signature(fs.statSync(file,{bigint:true}));
    if(before!==after)continue;this.rows.set(name,{signature:after,row});done=true;
   }catch(e){if(e.code!=='ENOENT')throw e;this.rows.delete(name);done=true;}
   if(!done)throw Error('订单文件正在变化，请稍后核对原单');
  }
 }
 list(limit=Infinity,project=x=>x){this.sync();return [...this.rows.values()].map(x=>x.row).sort((a,b)=>b.createdAt-a.createdAt).slice(0,limit).map(x=>structuredClone(project(x)));}
 find(predicate){this.sync();for(const {row} of this.rows.values())if(predicate(row))return structuredClone(row);return undefined;}
}
