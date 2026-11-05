export function createRpcDialog({api,document:doc=document}){
 const $=id=>doc.getElementById(id);let busy=false,version=0;
 const show=s=>{$('rpcCurrent').textContent=s.configured?`优先：${s.host} · ${s.fallback?'当前已切换公共备用节点':'故障时自动切换备用节点'}`:'当前使用公共 BNB 链节点';};
 const lock=value=>{busy=value;for(const id of ['saveRpc','resetRpc','rpcUrl'])$(id).disabled=value;};
 const close=()=>{version++;$('rpcUrl').value='';$('rpcDialog').close();};
 $('configureRpc').addEventListener('click',async()=>{const v=++version;$('rpcUrl').value='';$('rpcMessage').textContent='';$('rpcCurrent').textContent='正在读取设置…';$('rpcDialog').showModal();try{const s=await api('rpc');if(v===version)show(s);}catch(e){if(v===version)$('rpcCurrent').textContent=e.message;}});
 $('closeRpc').addEventListener('click',close);$('rpcDialog').addEventListener('close',()=>{$('rpcUrl').value='';});
 async function save(url){if(busy)return;lock(true);$('rpcMessage').classList.remove('error');$('rpcMessage').textContent=url?'正在验证 BNB 链连接…':'正在切换公共节点…';
  try{const s=await api('rpc',{url});show(s);$('rpcUrl').value='';$('rpcMessage').textContent='已保存，新查询立即生效。';}
  catch(e){$('rpcMessage').textContent=e.message;$('rpcMessage').classList.add('error');}
  finally{lock(false);}
 }
 $('rpcForm').addEventListener('submit',event=>{event.preventDefault();const url=$('rpcUrl').value.trim();if(!url){$('rpcMessage').textContent='请输入 RPC 地址；恢复默认请点“使用公共 RPC”。';return;}void save(url);});
 $('resetRpc').addEventListener('click',()=>void save(''));
 return {save};
}
