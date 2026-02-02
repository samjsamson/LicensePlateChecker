# Deploy PlateChecker

## 1) Push code to GitHub
From `LicensePlateChecker/`:

```bash
git add .
git commit -m "Prepare PlateChecker for deployment"
git remote add origin <your-github-repo-url> # if needed
git push -u origin main
```

## 2) Deploy on Render
1. Sign in to Render.
2. Click **New +** -> **Blueprint**.
3. Connect your GitHub repo.
4. Render detects `render.yaml` and creates the web service.
5. Wait for deploy and open the generated `onrender.com` URL.

## 3) Add custom domain
1. Render service -> **Settings** -> **Custom Domains**.
2. Add your domain (ex: `platechecker.com`, `www.platechecker.com`).
3. In your DNS provider, add the records Render requests.
4. Wait for DNS verification + SSL issuance.

## 4) Smoke test
- Open your domain.
- Search a test plate.
- Confirm UI and `/api/check-plate` both work.
