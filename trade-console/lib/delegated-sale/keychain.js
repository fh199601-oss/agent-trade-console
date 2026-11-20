// JavaScript for Automation, invoked only by the local signer worker on macOS.
ObjC.import('Foundation');
ObjC.import('Security');
function run(argv) {
 const [action,account]=argv;
 if(!['read','create'].includes(action)||!/^profile-[a-f0-9]{32}$/.test(account))throw Error('Invalid trigger slot');
 const key=r=>ObjC.castRefToObject(r);
 const query=$.NSMutableDictionary.alloc.init;
 query.setObjectForKey(key($.kSecClassGenericPassword),key($.kSecClass));
 query.setObjectForKey($('Agent Trade Console · BSC Fast Sale'),key($.kSecAttrService));
 query.setObjectForKey($(account),key($.kSecAttrAccount));
 if(action==='create'){
  const data=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if(Number(data.length)!==66)throw Error('Invalid credential length');
  query.setObjectForKey(data,key($.kSecValueData));
  const status=$.SecItemAdd(query,Ref());
  // Only add. A duplicate means another process has already created the identity.
  if(status!==0&&status!==-25299)throw Error('Keychain add failed');
  query.removeObjectForKey(key($.kSecValueData));
 }
 query.setObjectForKey($(true),key($.kSecReturnData));
 const result=Ref(),status=$.SecItemCopyMatching(query,result);
 if(status===-25300&&action==='read')return 'MISSING';
 if(status!==0)throw Error('Keychain access failed');
 return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(key(result[0]),$.NSUTF8StringEncoding));
}
