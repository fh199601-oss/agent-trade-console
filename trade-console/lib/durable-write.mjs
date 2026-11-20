import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {json} from './common.mjs';

// Publish a complete reservation synchronously so other wallet workflows and
// CLI processes can already see it. Keep its inode open and AWAIT fsync before
// permitting submission. Only the expensive flush leaves the JS thread; this
// is not a fire-and-forget journal and never batches away a commit boundary.
export async function saveDurable(file,value,{io=fs,publishImmediately=true,canPublish=null,closeBeforePublish=process.platform==='win32'}={}){
 // Reservations must be visible before yielding. Later state transitions can
 // leave that complete reservation visible until the replacement is durable.
 // Capture the snapshot NOW, before any asynchronous work can mutate value.
 if(!publishImmediately&&canPublish){
  // A coalesced shared snapshot needs one asynchronous fsync, not a queue
  // round-trip for mkdir/open/write/close while 100 wallet files are busy.
  io.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomUUID()+'.tmp';let fd,published=false;
  try{
   fd=io.openSync(tmp,'wx',0o600);io.writeFileSync(fd,json(value));
   await new Promise((resolve,reject)=>io.fsync(fd,e=>e?reject(e):resolve()));
   io.closeSync(fd);fd=undefined;
   if(!canPublish())return false;
   io.renameSync(tmp,file);published=true;
  }finally{if(fd!==undefined)io.closeSync(fd);if(!published)try{io.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return;
 }
 if(!publishImmediately){
  const content=json(value),tmp=file+'.'+randomUUID()+'.tmp';let handle,created=false,renamed=false;
  try{
   await io.promises.mkdir(path.dirname(file),{recursive:true,mode:0o700});
   handle=await io.promises.open(tmp,'wx',0o600);created=true;
   await handle.writeFile(content);await handle.sync();await handle.close();handle=null;
   await io.promises.rename(tmp,file);renamed=true;
  }finally{
   try{if(handle)await handle.close();}finally{if(created&&!renamed)try{await io.promises.unlink(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  return;
 }
 io.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=file+'.'+randomUUID()+'.tmp';let fd,renamed=false;
 try{
  fd=io.openSync(tmp,'wx',0o600);io.writeFileSync(fd,json(value));
  // Windows cannot atomically replace a destination with an open file handle.
  // Keep the prior journal visible until this critical reservation is flushed.
  if(closeBeforePublish){
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   io.renameSync(tmp,file);renamed=true;return;
  }
  io.renameSync(tmp,file);renamed=true;
  await new Promise((resolve,reject)=>io.fsync(fd,e=>e?reject(e):resolve()));
 }finally{
  if(fd!==undefined)io.closeSync(fd);
  if(!renamed)try{io.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
