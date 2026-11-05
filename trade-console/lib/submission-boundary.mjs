// Only local admission guards can prove that execute was never accepted.
// A provider timeout/error or an existing dispatch marker is not such proof.
export function localAdmissionDeferred(error,order){
 return ['WALLET_BUSY','ORDER_UNRESOLVED'].includes(error?.code)&&error.details?.requestAccepted===false&&
  (!order||order.status==='PREPARED'&&!order.steps?.length&&!order.orderId&&!order.txHash&&!order.result&&!order.receipt);
}
