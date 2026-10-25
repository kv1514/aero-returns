declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    SUPABASE_URL?: string;
    SUPABASE_PUBLISHABLE_KEY?: string;
    SUPABASE_GOOGLE_ENABLED?: string;
    SUPABASE_AMAZON_ENABLED?: string;
    SUPABASE_EMAIL_ENABLED?: string;
    SUPABASE_COOKIE_SECURE?: string;
    GOOGLE_MAPS_BROWSER_KEY?: string;
    GOOGLE_MAPS_MAP_ID?: string;
    AMAZON_CLIENT_ID?: string;
    AMAZON_CLIENT_SECRET?: string;
    AMAZON_REDIRECT_URI?: string;
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_MODEL?: string;
    APIFY_TOKEN?: string;
    APIFY_ACTOR_ID?: string;
    DRONE_LINK_SECRET?: string;
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_FROM_NUMBER?: string;
    AERO_TRUST_SITES_IDENTITY?: string;
    /** Optional SpacetimeDB live sync (docs/SPACETIMEDB.md); on only with SPACETIMEDB_DATABASE, SPACETIMEDB_TOKEN and DRONE_LINK_SECRET. */
    SPACETIMEDB_URI?: string;
    SPACETIMEDB_DATABASE?: string;
    SPACETIMEDB_TOKEN?: string;
    BUCKET?: R2Bucket;
  }
}
