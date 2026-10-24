import {accountOwner} from './account-policy';
export async function verifyAccountUser<T extends {id:string}>(getUser:()=>Promise<{data:{user:T|null};error:unknown}>){
  const {data,error}=await getUser();
  if(error||!data.user)throw new Error('Account session expired or unavailable. Sign in again.');
  return {owner:accountOwner(data.user.id),user:data.user};
}
