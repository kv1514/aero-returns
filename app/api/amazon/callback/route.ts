import {amazonCallback} from '@/lib/amazon-server';
import {unsupported} from '@/lib/http';
export const dynamic='force-dynamic';
export const GET=amazonCallback;
const no=unsupported('GET');
export const POST=no,PUT=no,DELETE=no,PATCH=no,OPTIONS=no;
