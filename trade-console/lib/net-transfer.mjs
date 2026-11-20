import {same} from './common.mjs';

// Some ERC20s emit a net transfer. Others credit the gross amount first and
// take the fee back from the recipient. Count only credits from this source.
export function netTransfer(events,asset,source,recipient,after=-1,before=Infinity){
 let credit=0n;
 for(const e of events){
  if(e.name!=='Transfer'||!same(e.asset,asset)||e.index<=after||e.index>=before)continue;
  if(same(e.args.from,source)&&same(e.args.to,recipient))credit+=e.args.value;
  else if(same(e.args.from,recipient)&&!same(e.args.to,recipient))credit-=e.args.value;
 }
 return credit;
}
