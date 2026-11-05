export function createUpdateDialog({api,document:doc=document}){
 const $=id=>doc.getElementById(id),make=(tag,text,cls)=>{const e=doc.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};let busy=false;
 async function check(){if(busy)return;busy=true;$('checkUpdates').disabled=true;$('updateBody').textContent='正在检查 GitHub 正式版本…';$('updateActions').replaceChildren();if(!$('updateDialog').open)$('updateDialog').showModal();
  try{const info=await api('updates'),body=$('updateBody');body.replaceChildren();const versions=make('p',undefined,'update-version');versions.append(make('span','当前 '+info.currentVersion),make('span','→'),make('strong','GitHub '+info.latestVersion));body.append(versions);
   body.append(make('p',info.state==='available'?'有新版本可以更新':info.state==='ahead'?'本地版本比最新正式发行版更新':'已是最新正式版本','update-progress'));
   if(info.state==='available'){const notes=make('div',info.notes,'update-notes');body.append(notes);body.append(make('p','下载后先停止看板，再更新原安装目录的程序文件，保留本机数据。不要覆盖钱包目录。','helper'));
    if(info.downloadUrl){const download=make('a','下载更新包 ↗','primary');download.href=info.downloadUrl;download.target='_blank';download.rel='noopener noreferrer';$('updateActions').append(download);const checksum=make('a','SHA256 校验文件','text-button');checksum.href=info.checksumUrl;checksum.target='_blank';checksum.rel='noopener noreferrer';body.append(checksum);}
    else body.append(make('p','此系统的便携包尚未就绪，请查看发行页面。','helper'));
   }
   const release=make('a','查看 GitHub 发行页面 ↗','text-button');release.href=info.releaseUrl;release.target='_blank';release.rel='noopener noreferrer';$('updateActions').append(release);
  }catch(e){$('updateBody').textContent='检查更新失败：'+e.message;const retry=make('button','重试','secondary');retry.addEventListener('click',check);$('updateActions').append(retry);}finally{busy=false;$('checkUpdates').disabled=false;}
 }
 $('checkUpdates').addEventListener('click',check);$('closeUpdate').addEventListener('click',()=>$('updateDialog').close());return {check};
}
