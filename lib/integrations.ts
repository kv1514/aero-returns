import { z } from 'zod';
export const reviewSchema=z.object({matchesProduct:z.boolean(),condition:z.enum(['new','like_new','used','damaged']),confidence:z.number().min(0).max(1),issues:z.array(z.string().max(500)).max(15),fraudFlags:z.array(z.string().max(500)).max(15),recommendation:z.enum(['approve','manual_review','reject']),explanation:z.string().max(2000)});
export type Review=z.infer<typeof reviewSchema>;
export function gateReview(raw:unknown): Review {
  const review=reviewSchema.parse(raw);
  if(review.confidence<.85||review.fraudFlags.length||!review.matchesProduct) return {...review,recommendation:'manual_review',explanation:`Human review required. ${review.explanation}`};
  return review;
}
export const SAMPLE_REVIEW:Review={matchesProduct:true,condition:'like_new',confidence:.92,issues:['Original packaging should be included.'],fraudFlags:[],recommendation:'approve',explanation:'Sample only: example output for a fictional like-new item. Your photos and description were not reviewed. Package measurements still need to pass the drone limits. This is not a retailer approval.'};
export const ALLOWED_RETAILERS=['amazon.com','nike.com','zara.com','walmart.com','target.com','bestbuy.com','rei.com'];
const RETAILER_URL_HINT='Use a public HTTPS product page from Amazon, Nike, Zara, Walmart, Target, Best Buy, or REI.';
export function validProductURL(value:string){let u:URL;try{u=new URL(value);}catch{throw new Error(`${RETAILER_URL_HINT} Paste the full https:// link.`);}if(u.protocol!=='https:'||u.username||u.password||u.port||!ALLOWED_RETAILERS.some(host=>u.hostname===host||u.hostname.endsWith('.'+host)))throw new Error(RETAILER_URL_HINT);return u.toString();}
