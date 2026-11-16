// Prepares www/ for a build:
// 1. writes www/config.js from SUPABASE_URL and SUPABASE_ANON_KEY (GitHub Actions secrets),
// 2. copies the Supabase browser client into www/vendor/ so the app works without a CDN.
// The anon key is a publishable key; row-level security in supabase/ limits what it can do.
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const url = (process.env.SUPABASE_URL || "").trim();
const key = (process.env.SUPABASE_ANON_KEY || "").trim();
if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
  console.error("SUPABASE_URL should look like https://<project>.supabase.co");
  process.exit(1);
}
const www = new URL("../www/", import.meta.url);
writeFileSync(new URL("config.js", www), "window.RALLY_CONFIG = " + JSON.stringify({ supabaseUrl: url.replace(/\/$/, ""), supabaseAnonKey: key }) + ";\n");

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("@supabase/supabase-js/package.json"));
const umd = join(pkgDir, "dist", "umd", "supabase.js");
if (!existsSync(umd)) { console.error("Supabase browser build not found at " + umd); process.exit(1); }
mkdirSync(new URL("vendor/", www), { recursive: true });
copyFileSync(umd, new URL("vendor/supabase.js", www));
// PDF export: jsPDF and its table plugin, as browser builds
const vendor = [["jspdf", "dist/jspdf.umd.min.js", "jspdf.js"], ["jspdf-autotable", "dist/jspdf.plugin.autotable.min.js", "jspdf-autotable.js"]];
for (const [pkg, file, out] of vendor) {
  const src = new URL("../node_modules/" + pkg + "/" + file, import.meta.url);
  if (!existsSync(src)) { console.error("Missing " + src); process.exit(1); }
  copyFileSync(src, new URL("vendor/" + out, www));
}

console.log(url && key ? "Config written: club server enabled." : "Config written: no Supabase secrets, guest mode only.");
