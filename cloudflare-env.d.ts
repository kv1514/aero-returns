declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_MODEL?: string;
    APIFY_TOKEN?: string;
    APIFY_ACTOR_ID?: string;
    BUCKET?: R2Bucket;
  }
}
