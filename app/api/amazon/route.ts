import {amazonAccount} from '@/lib/amazon-server';
import {unsupported} from '@/lib/http';
export const dynamic='force-dynamic';
export const GET=amazonAccount;
export const POST=amazonAccount;
export const DELETE=amazonAccount;
const no=unsupported('GET','POST','DELETE');
export const PUT=no,PATCH=no,OPTIONS=no;
