// The official CLI has returned both arrays and structured risk objects.
// Treat populated unknown fields conservatively; empty containers are clear.
export function hasPreviewRisks(value){
 if(value==null||value===false||value==='')return false;
 if(Array.isArray(value))return value.length>0;
 if(typeof value!=='object')return value!==0;
 return Object.entries(value).some(([key,item])=>{
  if(key==='riskLevel')return item!=null&&item!==''&&item!==0&&item!=='0'&&item!=='NONE';
  return hasPreviewRisks(item);
 });
}
