# Deploying to GitHub Pages

The game builds to static files (no server, no database), so GitHub Pages
hosts it for free. `.github/workflows/deploy.yml` does everything
automatically on every push to `master`.

## One-time setup (once a GitHub repo exists)

1. Create the repo and push:
   ```
   git remote add origin git@github.com:<you>/<repo>.git
   git push -u origin master
   ```
2. On GitHub: **Settings → Pages → Build and deployment → Source =
   "GitHub Actions"** (not "Deploy from a branch").
3. Push again (or run the workflow from the **Actions** tab →
   "Deploy to GitHub Pages" → **Run workflow**).

The site appears at `https://<you>.github.io/<repo>/` after the first
green run (typically ~1 minute).

## What the workflow does

`push to master` → checkout → `npm ci` → `tsc --noEmit && vite build
--base=./` → upload `dist/` → deploy.

- **`--base=./`** makes all asset URLs relative, so the site works at any
  repo name / sub-path without configuration.
- **Everything ships in `dist/` automatically**: the game, both
  path-tracer pages, `assets/map/` (glb + manifest), the Draco decoders
  and the OIDN denoiser weights — they all live under `assets/`, which is
  the Vite `publicDir`.
- Only `master` deploys; in-flight deploys are cancelled by newer pushes
  (concurrency group).
- No secrets or tokens are needed: the workflow uses GitHub's own
  Pages token (permissions are already declared in the YAML).

## Notes

- Pull requests do **not** deploy (only pushes to `master`) — the build
  step still runs on those pushes, so a red Actions tab = broken build.
- Local preview stays `npm run preview` (port 4173); deploying never
  affects it.
- If you later add a custom domain, replace `--base=./` with `--base=/`
  in the workflow and add a `CNAME` file to `assets/`.
