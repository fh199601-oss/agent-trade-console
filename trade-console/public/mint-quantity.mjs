export function normalizeMintQuantity(value){
 if(typeof value==='string')value=value.trim();
 return typeof value==='string'&&value.toLowerCase()==='max'?'max':value;
}
export function createMintQuantityControl({document:doc=document,onChange=()=>{}}={}){
 const input=doc.getElementById('quantity'),button=doc.getElementById('mintMax'),scope=doc.getElementById('scope');let paid='1';
 function value(){return scope.value!=='paid'?'max':normalizeMintQuantity(input.value||paid);}
 function render(){
  const automatic=scope.value!=='paid',full=automatic||paid==='max';input.disabled=automatic;input.value=full?'':paid;
  input.placeholder=full?'全部打满':'填写份数';button.disabled=automatic;button.setAttribute('aria-pressed',String(full));
  button.title=automatic?'当前额度选项默认全部打满':'按当前可用付费额度打满';
 }
 scope.addEventListener('change',()=>{render();onChange();});
 input.addEventListener('input',()=>{paid=normalizeMintQuantity(input.value);button.setAttribute('aria-pressed',String(paid==='max'));onChange();});
 input.addEventListener('blur',()=>{if(normalizeMintQuantity(input.value)==='max'){paid='max';render();}});
 button.addEventListener('click',()=>{paid='max';render();onChange();});render();return {value,usePaidCount(){scope.value='paid';paid='1';render();onChange();input.focus();input.select();}};
}
