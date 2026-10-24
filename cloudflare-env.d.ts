declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    GOOGLE_MAPS_BROWSER_KEY?: string;
    GOOGLE_MAPS_MAP_ID?: string;
    AMAZON_CLIENT_ID?: string;
    AMAZON_CLIENT_SECRET?: string;
    AMAZON_REDIRECT_URI?: string;
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_MODEL?: string;
    APIFY_TOKEN?: string;
    APIFY_ACTOR_ID?: string;
    BUCKET?: R2Bucket;
  }
}
