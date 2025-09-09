Settings (/settings)

What was added
- Full-page Settings at /settings with slide-in transition and two-column layout.
- Sidebar sections: Profile, Billing & Subscription, Security, Accessibility.
- Design tokens are generated from JSON files in design/setting-page/ and applied as CSS variables.

Design tokens source
- Files read: 
  - design/setting-page/SETTING-PROFILE.design.json
  - design/setting-page/SETTINGS-BILLINGSUBSCRIBTION.design.json
  - design/setting-page/SETTING-SECURITY.design.json
  - design/setting-page/SETTING-ACCESIBILITY.design.json
  - design/setting-page/SETTING-BILLINGSUBSCRIBTION-UPDATEBILLINGDETAILS.design.json
- Endpoint: GET /api/settings/tokens aggregates palette, spacing, radii, typography.
- Applied to CSS variables in the browser: --bg, --card, --text, --muted, --border, --accent, --accent-weak, --fs.

Data wiring
- Profile
  - GET /api/profile returns id, email, tier (from public.profiles on Supabase).
  - PATCH /api/profile accepts display_name, locale, timezone, avatar_url.
    - Updates public.profiles.name (when provided) and Auth user_metadata.
- Billing & Subscription
  - Usage/plan from GET /api/usage/current.
  - "Upgrade/Cancel" buttons are disabled with title "Stripe pending".
  - "Update billing details" opens a glassy dialog and PATCHes /api/billing/profile with non-Stripe fields.
- Security
  - Password change via supabase.auth.updateUser({ password }).
  - 2FA placeholder text displayed (no backend yet).
- Accessibility
  - High-contrast, Reduce motion, Font scale, UI language apply instantly and persist via PATCH /api/profile/prefs.

Add a Settings entry
- Button id: settingsBtn injected next to Sign in in the top toolbar.
- Client navigation shows/hides the main app card and the settings page.
- Direct URL /settings is served by server-side catch (app.get(['/settings','/settings/*'])).

Styling
- Uses existing app variables for shadows, radius, etc.
- New classes prefixed with .settings- and a glassy dialog for billing details.

Notes
- No Stripe secrets or API calls added.
- If you change any design JSON tokens, /settings will pick them up on next load via /api/settings/tokens.

Next.js UI (web/)
- A Next.js App Router app lives in `web/` for the UI.
- Dev: Next runs on 3001; Express runs on 3000. Rewrites proxy `/api/*` to Express.
- Build: Next outputs standalone (`output: 'standalone'`). See `web/Dockerfile`.
- Env: set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to enable password changes via Supabase; otherwise that button is disabled.

Deploy / Routing
- NGINX routes UI to the Next container and `/api/*` to Express. See `nginx.conf`.
- Docker Compose defines `app` (Express) and `web` (Next). See `docker-compose.yml`.

Environment variables
- SECURE_LOCALIZATION: set to `on` to mark sensitive endpoints with `X-Secure-Mode:true` and prefer encrypted-at-rest storage for business history.
- REDIS_URL: optional Redis connection for feature counters and device lists; if absent, falls back to database tables.
- SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: if present, used for profile tier, phrasebook persistence, and other reads/writes.

Tiers
- Product tiers are `free`, `pro`, and `business` (formerly `team`). Admin helpers and defaults have been updated accordingly.
