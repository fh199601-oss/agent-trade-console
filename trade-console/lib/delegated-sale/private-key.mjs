import {getAddress,Wallet} from 'ethers';
import {openManagedSigner,profileDirectory} from './managed-trigger.mjs';
import {walletDialog} from './native-dialog.mjs';

export async function importTriggerKey({root,expectedAddress},dialog=walletDialog,vault){
 const choice=await dialog('import',expectedAddress);
 if(choice.cancelled)return {cancelled:true};
 const text=typeof choice.key==='string'?choice.key.trim():'';
 const hex=text.replace(/^0x/i,'');
 if(!/^[a-f0-9]{64}$/i.test(hex))throw Error('触发钱包私钥应为 64 位十六进制字符，可带 0x 前缀');
 let wallet,address;
 try{wallet=new Wallet('0x'+hex);address=wallet.address;}catch{throw Error('触发钱包私钥无效');}
 if(expectedAddress&&address!==getAddress(expectedAddress))throw Error('触发钱包私钥与填写的地址不一致');
 const dir=profileDirectory(root,address);
 await openManagedSigner({dir,expectedAddress:address},vault,wallet);
 return {address};
}

export async function revealTriggerKey({dir,address},dialog=walletDialog,vault){
 address=getAddress(address);
 const consent=await dialog('confirm-export',address);
 if(consent.confirmed!==true)return {cancelled:true};
 const wallet=await openManagedSigner({dir,expectedAddress:address},vault);
 // OKX Wallet imports a 32-byte EVM secret as 64 hex characters. Keep any
 // leading zero bytes, and leave the optional 0x marker off the copied text.
 const result=await dialog('show',address,wallet.privateKey.slice(2));
 return result.shown===true?{shown:true,address}:{cancelled:true};
}
