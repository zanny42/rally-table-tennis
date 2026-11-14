# Rally

A table tennis scorer for phones: live point-by-point scoring with serve, deuce and change-of-ends calls, saved score sheets, and a shared Elo ladder.

Built with [Capacitor](https://capacitorjs.com) from the plain web app in `www/`. GitHub Actions runs the tests and builds both phone apps on every push to `main`.

## Get the apps

Open the repo's **Releases** page, then the release called **latest**:

- **Rally.apk** (Android): download it on your phone and open it. Allow "install unknown apps" for your browser when Android asks.
- **Rally.ipa** (iPhone): it's unsigned. On a computer, install [Sideloadly](https://sideloadly.io) or [AltStore](https://altstore.io), connect your iPhone, and sideload the file with your Apple ID. With a free Apple ID the app has to be re-signed every 7 days.

The same files are attached to each run on the **Actions** tab.

## Turn on the shared ladder

Without these steps every phone keeps its own matches.

1. Create a free project at [supabase.com](https://supabase.com).
2. In the project, open **SQL Editor**, paste in `supabase/schema.sql` and run it.
3. In **Project Settings → API**, copy the **Project URL** and the **anon public** key. The anon key is meant to be public; the table's row-level security limits what it can do.
4. Add them as repository secrets named `SUPABASE_URL` and `SUPABASE_ANON_KEY`:
   ```
   gh secret set SUPABASE_URL
   gh secret set SUPABASE_ANON_KEY
   ```
5. Re-run the workflow (Actions → Test and build → Run workflow) and install the new build.

Anyone with the app can read and add matches. Only the phone that logged a match can delete it, and nobody can edit one.

## Develop

```
npm ci
npm test
```

`tests/rules.test.js` covers the scoring rules and Elo maths. `tests/app.test.js` loads the real page in jsdom, plays full matches by tapping, and checks saving offline and syncing to a mocked Supabase.
