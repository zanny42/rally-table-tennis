// Writes www/config.js from environment variables at build time.
// SUPABASE_URL and SUPABASE_ANON_KEY come from GitHub Actions secrets.
// The anon key is a publishable key; access is limited by the row-level security in supabase/schema.sql.
// With neither set, the app runs in "this phone only" mode.
import { writeFileSync } from "node:fs";

const url = (process.env.SUPABASE_URL || "").trim();
const key = (process.env.SUPABASE_ANON_KEY || "").trim();
if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
  console.error("SUPABASE_URL should look like https://<project>.supabase.co");
  process.exit(1);
}
const cfg = { supabaseUrl: url.replace(/\/$/, ""), supabaseAnonKey: key };
writeFileSync(new URL("../www/config.js", import.meta.url), "window.RALLY_CONFIG = " + JSON.stringify(cfg) + ";\n");
console.log(url && key ? "Config written: shared ladder enabled." : "Config written: no Supabase secrets, app keeps matches on each phone.");
