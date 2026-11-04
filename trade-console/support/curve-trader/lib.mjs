export function fail(code,message,details={}) {throw Object.assign(new Error(message),{code,details});}
