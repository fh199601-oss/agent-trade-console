// Local macOS dialog. Its private pipe goes only to the backup worker.
function run(argv){
 const [action,address]=argv;
 if(!['backup','import','confirm-export','show'].includes(action)||!(action==='import'&&!address)&&!/^0x[0-9a-fA-F]{40}$/.test(address))throw Error('Invalid wallet dialog');
 const app=Application.currentApplication();
 app.includeStandardAdditions=true;
 const ask=message=>app.displayDialog(message,{withTitle:'交易台 · 导出加密密钥',defaultAnswer:'',hiddenAnswer:true,buttons:['取消','继续'],defaultButton:'继续',cancelButton:'取消'}).textReturned;
 try{
  if(action==='import'){
   const r=app.displayDialog('粘贴要用作触发端的钱包私钥。系统会推导地址并在本机保存。'+(address?'\n需要匹配 '+address:''),
    {withTitle:'交易台 · 导入私钥',defaultAnswer:'',hiddenAnswer:true,buttons:['取消','导入'],defaultButton:'导入',cancelButton:'取消',givingUpAfter:75});
   return r.gaveUp?'{"cancelled":true}':JSON.stringify({key:r.textReturned});
  }
  if(action==='confirm-export'){
   const r=app.displayDialog(address+'\n\n即将在本机显示这个触发钱包的明文私钥。持有私钥的人可以转走其中的资产。',
    {withTitle:'交易台 · 导出私钥',buttons:['取消','显示私钥'],defaultButton:'取消',cancelButton:'取消',givingUpAfter:60});
   return JSON.stringify({confirmed:!r.gaveUp&&r.buttonReturned==='显示私钥'});
  }
  if(action==='show'){
   ObjC.import('Foundation');
   const data=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
   const key=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding));
   if(!/^[0-9a-f]{64}$/i.test(key))throw Error('Invalid private input');
   app.displayDialog(address+'\n\n这是通用 EVM 私钥。按 ⌘A、⌘C 复制下方 64 位字符，在 OKX Wallet 等钱包中选择「私钥导入」。窗口将在 60 秒后关闭。',
    {withTitle:'交易台 · 触发钱包私钥',defaultAnswer:key,buttons:['关闭'],defaultButton:'关闭',givingUpAfter:60});
   return '{"shown":true}';
  }
  const password=ask('触发钱包 '+address+'\n设置备份密码（至少 12 个字符），恢复钱包时需要此密码。');
  if(password.length<12||password.length>1024)return '{"error":"length"}';
  if(ask('请再次输入备份密码。')!==password)return '{"error":"mismatch"}';
  const file=app.chooseFileName({withPrompt:'保存触发钱包的加密 Keystore，请选择新文件',defaultName:'trigger-'+address+'.json'});
  return JSON.stringify({file:file.toString(),password});
 }catch(e){if(e.errorNumber===-128||String(e).includes('(-128)'))return '{"cancelled":true}';throw e;}
}
