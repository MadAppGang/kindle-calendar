# Kindle Calendar Display - Detailed Architecture

**Project**: Kindle E-ink Calendar Display Server
**Date**: 2026-03-12
**Session**: dev-arch-20260311-172353-6805ef5b
**Selected Alternative**: A — Firebase Cloud Functions Gen 2 + GCS Cache
**Status**: Approved for Implementation

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Project Structure](#2-project-structure)
3. [Cloud Function Specifications](#3-cloud-function-specifications)
4. [Google Calendar Multi-Account OAuth2 Design](#4-google-calendar-multi-account-oauth2-design)
5. [Data Provider Architecture](#5-data-provider-architecture)
6. [Template System Design](#6-template-system-design)
7. [Image Pipeline](#7-image-pipeline)
8. [GCS Cache Layer](#8-gcs-cache-layer)
9. [Configuration](#9-configuration)
10. [Security Design](#10-security-design)
11. [Local Development](#11-local-development)
12. [Deployment](#12-deployment)
13. [Implementation Plan](#13-implementation-plan)
14. [Testing Strategy](#14-testing-strategy)
15. [Monitoring and Observability](#15-monitoring-and-observability)

---

## 1. System Overview

### Purpose

A cloud-hosted image generation service that produces 1072x1448 grayscale PNG/JPEG images
optimized for the Kindle Paperwhite 3 e-ink display. The system merges calendar events from
3+ Google accounts, fetches weather for Valencia Spain, and renders a daily dashboard on a
15-minute schedule. Images are pre-rendered and cached in GCS; the Kindle fetches from a
lightweight serve endpoint.

### Architecture Pattern

**Pre-render on schedule + serve from cache.** Two separate Cloud Functions handle
distinct concerns:

- `render`: Scheduled, heavy — orchestrates all data fetching and image generation
- `serve`: HTTP, lightweight — streams pre-rendered images from GCS to the Kindle

This pattern ensures the Kindle (which may have a short wget timeout) always receives a fast
response, while the expensive Puppeteer rendering runs invisibly on a cron schedule.

### High-Level Architecture Diagram

```
  +-----------------------+
  |   Cloud Scheduler     |   every 15 minutes
  |   "kindle-render"     |   (europe-west1)
  +-----------+-----------+
              |  HTTPS POST
              |  (Cloud Run internal URL)
              v
  +-----------------------------+        +---------------------------+
  |  Cloud Function Gen 2       |        |   Secret Manager          |
  |  "render"                   |        |                           |
  |  Node.js 22, 1GB, 60s      | reads  |  kindle-cal/oauth/acct-1  |
  |                             +------> |  kindle-cal/oauth/acct-2  |
  |  RenderOrchestrator         |        |  kindle-cal/oauth/acct-3  |
  |  |- CalendarProvider(s)     |        |  kindle-cal/svc-account   |
  |  |- WeatherProvider         |        +---------------------------+
  |  |- DateTimeProvider        |
  |  |- TemplateEngine          |        +---------------------------+
  |  |- PuppeteerRenderer       | writes |   GCS Bucket              |
  |  |- SharpProcessor          +------> |   "kindle-screens"        |
  |  |- GCSUploader             |        |                           |
  +-----------------------------+        |   screen.png (public)     |
              |                          |   screen.jpg (public)     |
              | fetches                  |   screen-{name}.png       |
              v                          |   _meta/last-render.json  |
  +---------------------------+          +-------------+-------------+
  |  External APIs            |                        |
  |  Google Calendar API v3   |                        | HTTPS GET
  |  OpenMeteo API            |                        | (--no-check-cert)
  +---------------------------+                        v
                                          +---------------------------+
  +-----------------------------+         |   Kindle Paperwhite 3     |
  |  Cloud Function Gen 2       |         |   BusyBox wget            |
  |  "serve"                    |         |   FBInk display           |
  |  Node.js 22, 256MB, 10s    |         +---------------------------+
  |                             |
  |  GET /screen.png            |
  |  GET /screen.jpg            | <-- Kindle requests terminate here
  |  GET /screen/:name.png      |     Function streams from GCS
  |  GET /preview               |
  |  GET /health                |
  +-----------------------------+

  +-----------------------------+
  |  Local Development          |
  |  npm run dev                |
  |  Express + nodemon          |
  |  Mock providers             |
  |  Template hot-reload        |
  +-----------------------------+
```

### Component Descriptions

| Component | Type | Responsibility |
|-----------|------|----------------|
| `render` Cloud Function | GCF Gen 2, scheduled | Full render pipeline; writes PNG/JPEG to GCS |
| `serve` Cloud Function | GCF Gen 2, HTTP | Lightweight; reads GCS; streams image to Kindle |
| Cloud Scheduler job | GCP managed | Triggers `render` every 15 minutes via HTTPS POST |
| GCS bucket `kindle-screens` | GCP managed | Stores pre-rendered images; public read access |
| Secret Manager | GCP managed | Stores OAuth2 refresh tokens and service account keys |
| CalendarProvider | TypeScript module | Fetches events from N Google accounts + ICS feeds |
| WeatherProvider | TypeScript module | Fetches current conditions from OpenMeteo |
| DateTimeProvider | TypeScript module | Timezone-aware date/time formatting via luxon |
| TemplateEngine | TypeScript module | Renders Nunjucks HTML templates with data context |
| PuppeteerRenderer | TypeScript module | Headless Chromium; renders HTML to full-res PNG |
| SharpProcessor | TypeScript module | Converts RGB PNG to 8-bit grayscale; encodes output |
| GCSUploader | TypeScript module | Writes rendered images + metadata to GCS bucket |
| OAuth2SetupCLI | TypeScript script | One-time per-account OAuth2 consent flow tool |

### Data Flows

#### Render Pipeline (runs every 15 minutes, invisible to Kindle)

```
Cloud Scheduler fires cron
  -> HTTPS POST to render function URL
     -> RenderOrchestrator.run()
        -> [load config from config.yaml]
        -> [fetch secrets from Secret Manager, cached in memory]
        -> Promise.all([
             CalendarProvider.fetchAll(accounts, dateRange),
             WeatherProvider.fetch(lat, lon),
             DateTimeProvider.now(timezone)
           ])
        -> CalendarMerger.merge(allEvents)
           -> sort by start time
           -> deduplicate across sources
        -> DataContext = { date, time, events, allDayEvents, weather, location }
        -> TemplateEngine.render("default", DataContext)
           -> Nunjucks.compile(template)(DataContext) -> HTML string
        -> PuppeteerRenderer.renderHTML(html, { width: 1072, height: 1448 })
           -> browser.newPage()
           -> page.setViewport({ width: 1072, height: 1448 })
           -> page.setContent(html, { waitUntil: "networkidle0" })
           -> page.screenshot({ type: "png" }) -> Buffer (RGB)
           -> page.close()
        -> SharpProcessor.toGrayscalePNG(rgbBuffer)
           -> sharp(buffer).grayscale().png({ compressionLevel: 9 }).toBuffer()
        -> SharpProcessor.toGrayscaleJPEG(rgbBuffer)
           -> sharp(buffer).grayscale().jpeg({ quality: 85 }).toBuffer()
        -> GCSUploader.upload("screen.png", pngBuffer, { contentType: "image/png" })
        -> GCSUploader.upload("screen.jpg", jpgBuffer, { contentType: "image/jpeg" })
        -> GCSUploader.uploadMeta({ renderDurationMs, imageSizePng, imageSizeJpg, ts })
        -> log({ level: "info", event: "render_complete", durationMs, sizePng, sizeJpg })
```

#### Serve Pipeline (runs on each Kindle GET, ~every 15 minutes)

```
Kindle wget GET https://<serve-function-url>/screen.png --no-check-certificate
  -> Cloud Function "serve" (256MB, fast cold start, no Puppeteer)
     -> parseRoute(request.path) -> objectKey = "screen.png"
     -> GCS.file("screen.png").createReadStream()
     -> response.setHeader("Content-Type", "image/png")
     -> response.setHeader("Cache-Control", "no-store")
     -> gcsStream.pipe(response)
     -> log({ event: "serve_image", key: "screen.png", latencyMs })

  [fallback: GCS object does not exist (first deploy)]
     -> log({ level: "warn", event: "gcs_miss" })
     -> response.status(503).json({ error: "image not yet rendered", retryAfter: 60 })
```

#### /preview Flow (browser-based debugging)

```
Developer GET https://<serve-function-url>/preview
  -> serve function
     -> TemplateEngine.render("default", mockDataContext)
     -> response.setHeader("Content-Type", "text/html")
     -> response.send(renderedHtml)
```

---

## 2. Project Structure

### Top-Level Directory Layout

```
kindle-calendar/
├── functions/                    # Firebase Cloud Functions (TypeScript)
│   ├── src/
│   │   ├── index.ts              # Entry point: exports render and serve functions
│   │   ├── config/
│   │   │   ├── loader.ts         # Reads and validates config.yaml
│   │   │   └── types.ts          # TypeScript interfaces for config schema
│   │   ├── providers/
│   │   │   ├── provider.interface.ts   # DataProvider<T> contract
│   │   │   ├── calendar/
│   │   │   │   ├── calendar.provider.ts   # Orchestrates all calendar sources
│   │   │   │   ├── google.source.ts       # Google Calendar API adapter
│   │   │   │   ├── ics.source.ts          # ICS/iCal URL adapter
│   │   │   │   ├── merger.ts              # Event merge + dedup + sort
│   │   │   │   └── types.ts               # CalendarEvent, CalendarSource types
│   │   │   ├── weather/
│   │   │   │   ├── weather.provider.ts    # Orchestrates weather fetching
│   │   │   │   ├── openmeteo.source.ts    # OpenMeteo API adapter
│   │   │   │   └── types.ts               # WeatherData type
│   │   │   └── datetime/
│   │   │       ├── datetime.provider.ts   # Timezone-aware date/time
│   │   │       └── types.ts               # DateTimeContext type
│   │   ├── renderer/
│   │   │   ├── orchestrator.ts     # RenderOrchestrator: coordinates all steps
│   │   │   ├── template.engine.ts  # Nunjucks template loader + renderer
│   │   │   ├── puppeteer.ts        # Headless Chromium render
│   │   │   └── sharp.processor.ts  # Grayscale conversion + PNG/JPEG encode
│   │   ├── storage/
│   │   │   └── gcs.uploader.ts     # GCS upload + metadata write
│   │   ├── secrets/
│   │   │   └── secret.manager.ts   # Secret Manager client with in-memory cache
│   │   ├── handlers/
│   │   │   ├── render.handler.ts   # Cloud Scheduler -> render pipeline
│   │   │   └── serve.handler.ts    # HTTP endpoints (screen, preview, health)
│   │   └── dev/
│   │       ├── server.ts           # Local Express dev server
│   │       └── mock.providers.ts   # Mock data for offline development
│   ├── templates/
│   │   ├── default/
│   │   │   ├── index.html          # Main template (Nunjucks)
│   │   │   └── style.css           # E-ink CSS (embedded in HTML at render time)
│   │   └── fonts/
│   │       ├── IBMPlexSans-Regular.woff2
│   │       ├── IBMPlexSans-SemiBold.woff2
│   │       └── IBMPlexSans-Bold.woff2
│   ├── config.yaml                 # Primary configuration file
│   ├── config.example.yaml         # Example config (committed; no secrets)
│   ├── package.json
│   ├── tsconfig.json
│   └── .eslintrc.json
├── scripts/
│   ├── oauth-setup.ts              # One-time OAuth2 consent flow per Google account
│   ├── deploy-secrets.ts           # Helper: write secrets to Secret Manager
│   └── create-bucket.sh            # One-time GCS bucket creation + ACL setup
├── ai-docs/                        # Architecture documentation (this file's directory)
├── firebase.json                   # Firebase project config
├── .firebaserc                     # Firebase project ID binding
└── .gitignore                      # Excludes config.yaml (if it contains secret refs), .env
```

### Key Organizational Decisions

- `functions/src/` contains all TypeScript source; Firebase CLI compiles to `functions/lib/`
- `functions/templates/` is bundled with the function deployment (not a separate service)
- `config.yaml` contains secret references (not values); safe to commit if no actual secrets inline
- `scripts/` contains one-time setup tools that run locally, not in the cloud
- `functions/src/dev/` contains development-only code excluded from production bundles via
  conditional imports guarded by `process.env.NODE_ENV`

### Firebase Project Structure

```
firebase.json:
  functions:
    source: "functions"
    runtime: "nodejs22"
    region: "europe-west1"
  hosting: (not used; all serving via Cloud Functions)

.firebaserc:
  default: "<your-gcp-project-id>"
```

### TypeScript Build Output

```
functions/
├── src/          # TypeScript source
├── lib/          # Compiled JavaScript (gitignored; generated by tsc)
├── package.json  # Runtime dependencies
└── tsconfig.json # strict: true, target: ES2022, module: CommonJS
```

---

## 3. Cloud Function Specifications

### 3.1 Render Function

**Purpose**: Full render pipeline. Fetches all data, renders HTML template via Puppeteer,
converts to grayscale, uploads PNG and JPEG to GCS. Heavy and slow by design; the Kindle
never waits for this function.

**Trigger**: Cloud Scheduler HTTPS POST to `https://<function-url>/internal/render`

**Configuration**:

```
Name:        kindle-render
Runtime:     Node.js 22
Region:      europe-west1
Memory:      1GiB  (Puppeteer requires >= 512MB; 1GB provides headroom)
Timeout:     60s   (data fetch + Puppeteer render + GCS upload; typical: 10-20s)
Min instances: 0   (scale to zero; cold start only affects scheduled renders, not Kindle)
Max instances: 1   (single-tenant; no concurrent renders needed)
Concurrency:  1    (one render at a time; Cloud Scheduler idempotency guard)
```

**Responsibilities**:

1. Validate that the caller is Cloud Scheduler (check `X-CloudScheduler-JobName` header)
2. Load configuration from bundled `config.yaml`
3. Fetch OAuth2 secrets from Secret Manager (cached per function instance lifetime)
4. Fetch data in parallel: calendar events (all accounts), weather, current datetime
5. Merge, sort, and deduplicate calendar events
6. Build `DataContext` object
7. Render HTML template with Nunjucks
8. Launch Puppeteer; render HTML to PNG at 1072x1448
9. Convert RGB PNG to 8-bit grayscale PNG via sharp
10. Encode JPEG variant via sharp
11. Upload both images to GCS with correct content-type headers
12. Upload render metadata JSON to GCS
13. Log structured JSON with render duration and output sizes
14. Return HTTP 200 `{ "status": "ok", "durationMs": <n> }`

**Error Handling**:

- If any single calendar account fails to fetch: log warning, continue with remaining accounts
- If weather fetch fails: use a `WeatherUnavailable` sentinel object; template renders "Weather unavailable"
- If Puppeteer render fails: log error, do NOT overwrite GCS cache (stale image is better than no image)
- If GCS upload fails: log error, retry once; if retry fails, alert via Cloud Logging error log
- Cloud Scheduler will retry on non-2xx response (configurable retry count: 3)

**Security**:

- The function URL is not publicly advertised; Cloud Scheduler uses the direct Cloud Run URL
- The function validates the `X-CloudScheduler-JobName` header to reject unauthorized invocations
- Alternatively: deploy render function with `--no-allow-unauthenticated` (IAM-protected); grant
  Cloud Scheduler service account the `roles/cloudfunctions.invoker` role

### 3.2 Serve Function

**Purpose**: Lightweight HTTP handler. Streams pre-rendered images from GCS to the Kindle.
Contains no data fetching logic and no Puppeteer dependency.

**Trigger**: HTTP GET from Kindle (and browser for /preview)

**Configuration**:

```
Name:        kindle-serve
Runtime:     Node.js 22
Region:      europe-west1
Memory:      256MiB  (no Puppeteer; just GCS streaming)
Timeout:     10s     (GCS stream should complete in <2s for <500KB images)
Min instances: 0     (scale to zero; cold start is ~500ms for this lightweight function)
Max instances: 10    (more than enough for personal use; safety cap)
Concurrency:  80     (Cloud Run default; handles concurrent requests efficiently)
```

**Routes**:

| Path | Method | Description |
|------|--------|-------------|
| `/screen.png` | GET | Stream `screen.png` from GCS; Content-Type: image/png |
| `/screen.jpg` | GET | Stream `screen.jpg` from GCS; Content-Type: image/jpeg |
| `/screen/:name.png` | GET | Stream named variant `screen-:name.png` from GCS |
| `/preview` | GET | Render default template with mock data; return HTML |
| `/health` | GET | JSON health check with last render metadata |

**Serve Implementation Notes**:

- Use `@google-cloud/storage` file stream API; do not buffer entire image in memory
- Set `Cache-Control: no-store` on all image responses (Kindle should always get the latest)
- Set `Content-Length` header from GCS object metadata (enables Kindle progress tracking)
- On GCS 404 (no image rendered yet): return HTTP 503 with `Retry-After: 60`
- The `/preview` route requires the template files to be bundled with this function OR it
  can proxy a POST to the render function. Recommended: bundle templates with serve function
  as well, use a shared `templates/` directory in the deployment package.

**Health Endpoint Response Shape**:

```json
{
  "status": "ok",
  "lastRender": {
    "timestamp": "2026-03-12T14:32:00+01:00",
    "durationMs": 18420,
    "sizePng": 412680,
    "sizeJpg": 183240
  },
  "gcsObjects": {
    "png": true,
    "jpg": true
  }
}
```

### 3.3 Shared Dependencies

Both functions share the following bundled code (compiled into each function's deployment):

- `config/loader.ts` and `config/types.ts`
- `providers/datetime/` (used in serve function for /preview and /health timestamps)
- `renderer/template.engine.ts` (used in serve function for /preview)

The render function has additional dependencies not present in the serve function:
- `puppeteer` (~130MB binary — this is what makes the render function large)
- `@google-cloud/secret-manager`
- All data providers

The serve function's smaller bundle and lack of Puppeteer is what makes its cold start fast
(~200-500ms vs. 5-10s for the render function).

---

## 4. Google Calendar Multi-Account OAuth2 Design

### 4.1 Authentication Strategy

Two credential types are supported, used in combination:

**Type 1: OAuth2 User Credentials** (for personal Gmail accounts)
- Requires user consent via browser-based OAuth flow
- Provides a `refresh_token` that lasts indefinitely (until revoked or unused for 6 months)
- The `googleapis` client automatically exchanges the refresh token for short-lived access tokens
- Required for calendars owned by a standard Gmail account

**Type 2: Service Account** (for Google Workspace / GSuite calendars)
- No user consent needed; JSON key file issued from GCP Console
- Individual calendars must be explicitly shared to the service account email
- Access token is derived from the service account key (JWT assertion); no expiry management needed
- Preferred when the user controls a Google Workspace organization

### 4.2 One-Time OAuth2 Setup Flow

The `scripts/oauth-setup.ts` CLI tool performs the initial consent flow per Google account.
This runs once locally, never in the cloud function.

```
Flow steps:
1. Developer runs: npx ts-node scripts/oauth-setup.ts --account personal
2. Script reads OAuth2 client_id and client_secret from local .env or prompts for input
3. Script generates the Google OAuth2 authorization URL with scope:
   https://www.googleapis.com/auth/calendar.readonly
4. Script prints the URL; developer opens it in a browser
5. Developer completes Google sign-in and grants calendar read access
6. Google redirects to a local redirect URI (localhost:3000/oauth/callback)
7. Script captures the authorization code from the redirect
8. Script exchanges authorization code for tokens (access_token + refresh_token)
9. Script writes the refresh_token + client credentials to Secret Manager:
   gcloud secrets create kindle-cal/oauth/personal \
     --data-file=- <<< '{"client_id":"...","client_secret":"...","refresh_token":"..."}'
10. Script confirms: "Account 'personal' configured. Refresh token stored in Secret Manager."

Repeat for each Google account (work, shared, etc.)
```

### 4.3 Secret Manager Storage Structure

Each credential set is stored as a single JSON secret. Secret names use a consistent path
convention understood by the config loader:

```
Secret name format:  kindle-cal-oauth-{accountId}
Secret value format: JSON string

{
  "client_id": "xxx.apps.googleusercontent.com",
  "client_secret": "GOCSPX-...",
  "refresh_token": "1//0gABC..."
}

Examples:
  kindle-cal-oauth-personal     -> OAuth credentials for personal Gmail
  kindle-cal-oauth-work         -> OAuth credentials for work Gmail
  kindle-cal-oauth-shared       -> OAuth credentials for shared family account
  kindle-cal-svcaccount         -> Service account JSON key (full GCP key file)
```

Secret Manager access pattern in the render function:
- Secrets are fetched ONCE at function cold start and cached in a module-level Map
- On warm invocations, secrets are served from the in-process cache (no Secret Manager API call)
- This eliminates Secret Manager latency from the render hot path and reduces API costs
- Cache is valid for the lifetime of the function instance (automatically invalidated on restart)

### 4.4 Token Refresh Logic

Token refresh is handled automatically by the `googleapis` npm client. The design:

```
CalendarProvider initialization:
  for each account in config.calendars:
    secret = SecretManager.get(account.credentialRef)
    auth = new google.auth.OAuth2(secret.client_id, secret.client_secret)
    auth.setCredentials({ refresh_token: secret.refresh_token })
    googleCalendarClient = google.calendar({ version: "v3", auth })
    store as calendarClients[account.id] = googleCalendarClient

On each calendar fetch:
  googleCalendarClient.events.list(...)
  // googleapis library handles:
  //   - If access token is valid: use it
  //   - If access token expired (401): call auth.refreshAccessToken()
  //     -> POST https://oauth2.googleapis.com/token
  //     -> receives new access_token (valid 1 hour)
  //     -> stores new access_token in-memory
  //   - The refresh_token itself is never changed (remains in Secret Manager unchanged)
```

Important: The refresh token in Secret Manager never needs to be updated during normal operation.
It only needs to be replaced if:
1. The user revokes app access in Google Account settings
2. The refresh token has been unused for 6 months (Google policy for unverified apps)
3. The Google Cloud project OAuth consent screen configuration changes

If a token refresh fails with a 400 or 401 error, the system:
1. Logs a structured error: `{ event: "oauth_refresh_failed", account: "personal", error: "..." }`
2. Skips that calendar account for this render
3. Renders the image with a visible "Calendar unavailable" indicator for that source
4. Does NOT crash the render pipeline

### 4.5 Calendar Merge Logic

The `CalendarMerger` module combines events from all sources into a single unified list.

```
CalendarMerger.merge(events: CalendarEvent[][]): CalendarEvent[]

Steps:
1. Flatten: combine all arrays into one flat list
2. Filter to today: keep events where startTime is within [todayMidnight, tomorrowMidnight)
   in the Europe/Madrid timezone
3. Separate: split into allDayEvents[] and timedEvents[]
4. Deduplicate:
   - Use a composite key: normalize(title) + startTime.toISO() + endTime.toISO()
   - If two events share the same key (same event on two synced calendars): keep the one
     from the "primary" source (as defined by order in config.calendars)
5. Sort timedEvents: ascending by startTime
6. Sort allDayEvents: ascending by title (alphabetical)
7. Annotate: for each timedEvent, compute isInProgress = (now >= startTime && now < endTime)
8. Return: { allDayEvents, timedEvents }
```

---

## 5. Data Provider Architecture

### 5.1 Provider Interface

All data providers implement a common TypeScript interface. This ensures the orchestrator
can call any provider uniformly and apply consistent error handling.

```typescript
interface DataProvider<T> {
  readonly name: string;
  fetch(context: ProviderContext): Promise<T>;
}

interface ProviderContext {
  config: KindleCalendarConfig;
  secrets: SecretCache;
  now: DateTime;  // luxon DateTime in Europe/Madrid
}

// Provider registration in RenderOrchestrator:
// Providers are instantiated once per function cold start.
// fetch() is called on every render invocation with the current context.
```

### 5.2 CalendarProvider

Orchestrates fetching from all configured calendar sources (Google Calendar API + ICS).

```typescript
class CalendarProvider implements DataProvider<CalendarData> {
  name = "calendar";

  async fetch(ctx: ProviderContext): Promise<CalendarData> {
    const sources = ctx.config.calendars;
    const results = await Promise.allSettled(
      sources.map(source => this.fetchSource(source, ctx))
    );
    // allSettled: one source failure does not block others
    const events = results
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value);
    const failed = results
      .filter(r => r.status === "rejected")
      .map((r, i) => ({ source: sources[i].id, error: r.reason }));

    return {
      events: CalendarMerger.merge(events),
      failedSources: failed
    };
  }
}
```

**GoogleCalendarSource** (`google.source.ts`):
- Accepts a `CalendarSourceConfig` with `credentialRef` or `serviceAccountRef`
- Calls `calendar.events.list()` with `timeMin`/`timeMax` spanning the current day in Europe/Madrid
- Fetches `singleEvents: true` to expand recurring events
- Maps Google API response fields to the internal `CalendarEvent` type
- Includes: `id`, `title`, `startTime`, `endTime`, `isAllDay`, `calendarId`, `attendeeCount`,
  `location`, `sourceLabel`, `displayStyle`

**IcsSource** (`ics.source.ts`):
- Accepts a `CalendarSourceConfig` with `icsUrl`
- Fetches the ICS file via HTTP GET
- Parses with `ical.js`
- Filters to today's events
- Maps to `CalendarEvent` type

### 5.3 WeatherProvider

Fetches current and forecast weather from OpenMeteo.

```typescript
class WeatherProvider implements DataProvider<WeatherData> {
  name = "weather";

  async fetch(ctx: ProviderContext): Promise<WeatherData> {
    const { latitude, longitude } = ctx.config.location;
    // GET https://api.open-meteo.com/v1/forecast
    //   ?latitude=39.4699
    //   &longitude=-0.3763
    //   &current=temperature_2m,weathercode,windspeed_10m
    //   &daily=temperature_2m_max,temperature_2m_min,weathercode
    //   &timezone=Europe/Madrid
    //   &forecast_days=1
  }
}
```

**WeatherData type**:
```typescript
interface WeatherData {
  temperature: number;        // Current temp in Celsius
  temperatureHigh: number;    // Day high
  temperatureLow: number;     // Day low
  conditionCode: number;      // WMO weather interpretation code
  conditionLabel: string;     // Human-readable: "Partly Cloudy"
  conditionIcon: string;      // ASCII/Unicode icon: "⛅" or text fallback for e-ink
  windSpeed: number;          // km/h
  isAvailable: boolean;       // false if fetch failed
}
```

**WMO Code Mapping**: A static lookup table maps WMO weather interpretation codes (0-99) to
condition labels and icon strings. The icon strings use simple ASCII glyphs that render clearly
on e-ink (e.g., "SUNNY", "CLOUDY", "RAIN", or single Unicode symbols embedded in the font).

**Caching**: The WeatherProvider caches the last successful response in module-level state with
a timestamp. If the last fetch was within `config.cache.weatherTTLSeconds` (default: 900s),
the cached response is returned without an API call. Since the render function is scheduled
every 15 minutes, the cache TTL is effectively managed by the schedule itself.

### 5.4 DateTimeProvider

Provides timezone-aware date and time context for template rendering.

```typescript
class DateTimeProvider {
  now(timezone: string): DateTimeContext {
    const dt = DateTime.now().setZone(timezone);
    return {
      iso: dt.toISO(),
      date: dt.toFormat("cccc, d MMMM yyyy"),     // "Wednesday, 11 March 2026"
      time: dt.toFormat("HH:mm"),                  // "14:32"
      dayOfWeek: dt.toFormat("cccc"),              // "Wednesday"
      dayOfMonth: dt.day,
      month: dt.toFormat("MMMM"),                  // "March"
      year: dt.year,
      timezone: timezone,
      utcOffset: dt.toFormat("ZZ"),               // "+01:00"
      startOfDay: dt.startOf("day").toISO(),
      endOfDay: dt.endOf("day").toISO()
    };
  }
}
```

Uses `luxon` for all timezone arithmetic. No manual UTC offset handling.

### 5.5 Provider Parallelism

The RenderOrchestrator calls all providers in parallel using `Promise.all`:

```typescript
const [calendarData, weatherData] = await Promise.all([
  calendarProvider.fetch(ctx),
  weatherProvider.fetch(ctx)
]);
const dateTime = dateTimeProvider.now(config.display.timezone);
```

Calendar and weather fetches are independent and have no ordering requirement. The
DateTimeProvider is synchronous and does not need to be awaited.

### 5.6 Per-Provider Timeouts

Each provider enforces its own timeout using `AbortController` (Node.js 18+ native):

```typescript
// Each source fetch wraps its HTTP calls with:
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout
try {
  const response = await fetch(url, { signal: controller.signal });
} finally {
  clearTimeout(timeout);
}
```

The Google Calendar API client (`googleapis`) accepts a `timeout` option in its constructor.
Calendar fetches use a 5-second timeout per account. If a single account times out, the
`Promise.allSettled` in CalendarProvider catches the rejection and continues.

---

## 6. Template System Design

### 6.1 Template Engine Selection: Nunjucks

Nunjucks is chosen for the following reasons:
- Full-featured: supports includes, macros, filters, conditionals, loops
- Good TypeScript support via `@types/nunjucks`
- Template files are standard HTML with `{{ variable }}` syntax
- Can precompile templates for performance (optional)
- Well-maintained; widely used in Node.js server-side rendering

### 6.2 Template Directory Structure

```
functions/templates/
├── default/
│   ├── index.html          # Main layout template
│   ├── partials/
│   │   ├── header.html     # Date, time, location, weather bar
│   │   ├── all-day.html    # All-day events section
│   │   ├── timeline.html   # Timed events timeline
│   │   └── footer.html     # Last-updated timestamp
│   └── style.css           # Inline via <style> tag at render time
└── fonts/
    ├── IBMPlexSans-Regular.woff2
    ├── IBMPlexSans-SemiBold.woff2
    └── IBMPlexSans-Bold.woff2
```

### 6.3 Template Data Context Object

The `DataContext` object is passed to Nunjucks and made available as template variables:

```typescript
interface DataContext {
  datetime: {
    date: string;           // "Wednesday, 11 March 2026"
    time: string;           // "14:32"
    dayOfWeek: string;      // "Wednesday"
    month: string;          // "March"
    year: number;
  };
  weather: {
    temperature: number;
    temperatureHigh: number;
    temperatureLow: number;
    conditionLabel: string;
    conditionIcon: string;  // ASCII or Unicode icon
    windSpeed: number;
    isAvailable: boolean;
  };
  location: {
    name: string;           // "Valencia, Spain"
  };
  allDayEvents: CalendarEvent[];
  timedEvents: CalendarEvent[];
  failedCalendarSources: string[];  // source IDs that failed; shown as warning in template
  meta: {
    renderTimestamp: string;  // ISO timestamp for footer
    version: string;          // App version from package.json
  };
}

interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;        // ISO string; template formats with Nunjucks filter
  endTime: string;
  startFormatted: string;   // Pre-formatted: "09:30"
  endFormatted: string;     // Pre-formatted: "10:00"
  isAllDay: boolean;
  isInProgress: boolean;
  calendarId: string;
  sourceId: string;
  sourceLabel: string;      // "Personal" or "Work" - from config
  displayStyle: "solid" | "dashed" | "dotted";
  attendeeCount: number | null;
  location: string | null;
}
```

### 6.4 HTML Template Structure

The main template (`index.html`) is a self-contained HTML document with inlined CSS and fonts.
This is required because Puppeteer cannot load external resources (no filesystem access to
relative paths during headless rendering without an explicit base URL).

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1072">
  <title>Kindle Calendar</title>
  <style>
    /* Fonts embedded as base64 data URIs */
    @font-face {
      font-family: 'IBMPlexSans';
      src: url('data:font/woff2;base64,{{ fonts.regular }}') format('woff2');
      font-weight: 400;
    }
    @font-face {
      font-family: 'IBMPlexSans';
      src: url('data:font/woff2;base64,{{ fonts.semibold }}') format('woff2');
      font-weight: 600;
    }
    @font-face {
      font-family: 'IBMPlexSans';
      src: url('data:font/woff2;base64,{{ fonts.bold }}') format('woff2');
      font-weight: 700;
    }
    /* E-ink optimized CSS (see section 6.5) */
    {{ css }}
  </style>
</head>
<body>
  {% include "partials/header.html" %}
  {% if allDayEvents.length > 0 %}
    {% include "partials/all-day.html" %}
  {% endif %}
  {% include "partials/timeline.html" %}
  {% include "partials/footer.html" %}
</body>
</html>
```

The TemplateEngine reads font files and CSS from disk at template load time and injects them
as template variables (`{{ fonts.regular }}`, `{{ css }}`). This avoids Puppeteer needing
to resolve external file references.

### 6.5 CSS Design for E-ink

Key CSS principles for the Kindle Paperwhite 3 (16-level grayscale, 300 DPI, 1072x1448px):

```
Layout:
  - Fixed pixel dimensions: body { width: 1072px; height: 1448px; overflow: hidden; }
  - No flexbox gaps or calc() with viewport units (not supported in older Chromium)
  - Use explicit pixel heights for all major zones to prevent overflow

Typography:
  - Font family: IBMPlexSans, system-ui, sans-serif (system-ui fallback only)
  - Minimum font size: 14px (renders ~4.4pt at 300 DPI; readable)
  - Body text: 16-18px, weight 400
  - Event titles: 18px, weight 600
  - Headers: 28-32px, weight 700
  - Section labels: 13px, weight 700, letter-spacing: 0.1em, text-transform: uppercase
  - Disable subpixel antialiasing: -webkit-font-smoothing: grayscale

Color palette (grayscale only):
  - Background: #ffffff (white)
  - Primary text: #000000 (black)
  - Secondary text: #444444 (dark gray)
  - Subtle text (footer, metadata): #888888
  - Section dividers: #000000 (1px solid black lines)
  - Event card border: 1px solid #000000 (solid, dashed, or dotted per displayStyle)
  - Current event (isInProgress): background: #000000; color: #ffffff (inverted)
  - Warning/stale indicator: background: #dddddd; border: 1px solid #888888

E-ink specific:
  - No box-shadow (renders as blobs on e-ink)
  - No gradients (renders poorly on 16 gray levels)
  - No border-radius > 2px (subtle rounding acceptable)
  - No opacity < 1 (transparency renders inconsistently)
  - No CSS animations or transitions
  - High-contrast borders (solid black 1px) for all cards

Layout zones (pixel heights at 1448px total):
  - Header (date + time): 80px
  - Context bar (weather + location): 60px
  - All-day events (conditional): 0px or 80px
  - Timeline: remaining height (1228px or 1308px)
  - Footer: 40px
  Total: 1448px (no overflow)
```

### 6.6 Layout Zones Detail

```
+-----------------------------------------------+  y=0
|  HEADER ZONE                          80px     |
|  Date: Wednesday, 11 March 2026   14:32        |
+-----------------------------------------------+  y=80
|  CONTEXT BAR                          60px     |
|  Valencia, Spain    ⛅ 18°C (H:22 L:13)        |
+-----------------------------------------------+  y=140
|  ALL-DAY EVENTS (conditional)         80px     |
|  [ALL DAY] Team Holiday                        |
+-----------------------------------------------+  y=220 (or y=140 if no all-day)
|                                               |
|  TIMELINE                          ~1188px    |
|                                               |
|  09:00 +-[Team Standup - Personal      ]--+   |
|  09:30 |                                  |   |
|  10:00 +---------------------------------++   |
|  10:00 +--[Design Review - Work  +8  ]---+   |
|        |                                 |   |
|  12:00 +---------------------------------+   |
|  12:00  (free)                               |
|  13:00 +--[LUNCH - Personal           ]--+   |  <- inverted if in progress
|        |                                 |   |
|  14:00 +---------------------------------+   |
|        ...                                   |
+-----------------------------------------------+  y=1408
|  FOOTER                               40px    |
|  Last updated: 14:32  v1.0.0                  |
+-----------------------------------------------+  y=1448
```

### 6.7 Local Template Preview

The `/preview` endpoint of the serve function (also available locally via `npm run dev`)
renders the default template with a mock `DataContext` and returns HTML directly in the
browser. This allows iterating on the template and CSS without deploying.

The TemplateEngine watches template files for changes in development mode (using Node.js
`fs.watch`) and reloads them without restarting the server.

```
Preview URL (local):  http://localhost:3000/preview
Preview URL (serve):  https://<serve-function-url>/preview
```

The preview renders a full HTML page at the designed dimensions using browser CSS transforms
(browser viewport is typically narrower than 1072px; the preview page includes a `transform: scale()`
wrapper to fit the design in the developer's browser window).

---

## 7. Image Pipeline

### 7.1 Pipeline Steps

```
Input:  DataContext object
Output: { png: Buffer, jpg: Buffer, meta: RenderMeta }

Step 1: HTML Generation
  TemplateEngine.render(templateName, dataContext)
  -> Nunjucks compiles template
  -> Inlines CSS and base64-encoded fonts
  -> Returns: HTML string (typically 300-800KB due to embedded fonts)

Step 2: Puppeteer Render
  PuppeteerRenderer.render(html)
  -> browser = puppeteer.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] })
       Note: --no-sandbox required in Cloud Run environment
             --disable-dev-shm-usage prevents /dev/shm overflow (Cloud Run has limited /dev/shm)
  -> page = browser.newPage()
  -> page.setViewport({ width: 1072, height: 1448, deviceScaleFactor: 1 })
  -> page.setContent(html, { waitUntil: "networkidle0" })
       waitUntil: "networkidle0" ensures all resources (base64 fonts) are loaded
  -> buffer = page.screenshot({ type: "png", clip: { x:0, y:0, width:1072, height:1448 } })
  -> page.close()
  -> browser.close()
  Returns: RGB PNG Buffer (~2-5MB before grayscale conversion)
  Typical duration: 3-8 seconds (cold browser), 2-4 seconds (subsequent renders in same instance)

  Puppeteer lifetime:
  - The render function runs in a serverless environment; browser is launched fresh per invocation
  - With min-instances=0, cold start adds browser launch time (~3-5s)
  - With min-instances=1, the function instance stays warm; subsequent invocations reuse the
    Node.js process but still re-launch the browser per render (safer memory management)
  - A more advanced optimization (not in v1): keep the browser instance alive between invocations
    using module-level state with a keepalive ping; reduces per-render time to ~1-2s

Step 3: Grayscale PNG Conversion
  SharpProcessor.toGrayscalePNG(rgbBuffer)
  -> sharp(rgbBuffer)
       .grayscale()                    // Convert to single-channel 8-bit grayscale
       .png({
         compressionLevel: 9,          // Maximum compression (slower but smaller file)
         adaptiveFiltering: true       // Better compression for line art / text
       })
       .toBuffer()
  Returns: Grayscale PNG Buffer
  Target: < 500KB
  Typical: 300-450KB for text-heavy e-ink layouts

Step 4: Grayscale JPEG Conversion
  SharpProcessor.toGrayscaleJPEG(rgbBuffer)
  -> sharp(rgbBuffer)
       .grayscale()
       .jpeg({
         quality: 85,                  // Balance of quality and size
         mozjpeg: true                 // Use mozjpeg encoder for better compression
       })
       .toBuffer()
  Returns: Grayscale JPEG Buffer
  Target: < 200KB
  Typical: 120-180KB at quality 85

Step 5: Size Verification
  if (pngBuffer.length > 500 * 1024) {
    log({ level: "warn", event: "png_oversized", sizeBytes: pngBuffer.length });
    // Retry with higher compression:
    pngBuffer = await sharp(rgbBuffer).grayscale().png({ compressionLevel: 9, quality: 80 }).toBuffer();
  }
  if (jpgBuffer.length > 200 * 1024) {
    log({ level: "warn", event: "jpg_oversized", sizeBytes: jpgBuffer.length });
    // Retry with lower quality:
    jpgBuffer = await sharp(rgbBuffer).grayscale().jpeg({ quality: 70 }).toBuffer();
  }
```

### 7.2 Dimension Guarantee

The viewport is set to exactly 1072x1448 in `page.setViewport()`. The `clip` parameter in
`page.screenshot()` ensures only those exact dimensions are captured, preventing any browser
chrome or scrollbars from bleeding into the screenshot.

The CSS ensures `body { width: 1072px; height: 1448px; overflow: hidden; }` so content is
bounded to the exact Kindle screen dimensions.

After Sharp processing, the output is verified:
```typescript
const meta = await sharp(pngBuffer).metadata();
assert(meta.width === 1072, "Width must be 1072px");
assert(meta.height === 1448, "Height must be 1448px");
assert(meta.channels === 1, "Must be single-channel grayscale");
assert(meta.depth === "uchar", "Must be 8-bit");
```

### 7.3 Error Handling

- **Puppeteer launch fails** (e.g., Chromium binary missing): Throw fatal error; Cloud Scheduler
  will retry. Do not upload to GCS (preserve last good image).
- **page.setContent times out** (template has infinite loop or blocking resource): `waitUntil`
  respects a page-level timeout (default: 30s). If exceeded, log error and abort render.
- **Screenshot fails** (rare): Log error; abort; Cloud Scheduler retries.
- **Sharp processing fails** (corrupted PNG from Puppeteer): Log error; abort; do not upload.
- **Size exceeds limit after retry**: Upload anyway with a warning log. The Kindle may reject
  the image if too large, but this is preferable to serving a blank screen.

---

## 8. GCS Cache Layer

### 8.1 Bucket Configuration

```
Bucket name:    kindle-screens-{project-id}  (globally unique; use project ID as suffix)
Location type:  Region
Region:         europe-west1  (same region as Cloud Functions; eliminates egress costs)
Storage class:  Standard
Public access:  Uniform bucket-level access with allUsers objectViewer role
                (Or: use a random UUID token in the object name for obscurity)
```

**Object naming strategy for privacy**:

Option A (simpler): Public bucket, meaningful names (`screen.png`, `screen.jpg`)
  - Anyone who discovers the GCS URL can view your calendar layout
  - Acceptable for personal use with no sensitive meeting titles

Option B (obscured): Public bucket, UUID-prefixed names (`{secret-uuid}/screen.png`)
  - URL is unguessable; effectively private without IAM
  - Serve function reads the UUID from config; Kindle URL includes the UUID
  - Recommended if meeting titles are sensitive

The config field `endpoints.secret` (optional UUID) controls this behavior.

### 8.2 Object Structure

```
GCS bucket: kindle-screens-{project-id}/
├── screen.png                        # Default grayscale PNG (< 500KB)
├── screen.jpg                        # Default grayscale JPEG (< 200KB)
├── screen-night.png                  # Named variant (if configured)
├── _meta/
│   └── last-render.json              # Render metadata for /health endpoint
└── _archive/
    └── 2026-03-12T14-30-00.png       # (Optional) Historical renders for debugging
```

**last-render.json structure**:

```json
{
  "timestamp": "2026-03-12T14:32:00.000+01:00",
  "durationMs": 18420,
  "sizePng": 412680,
  "sizeJpg": 183240,
  "calendarSources": ["personal", "work"],
  "failedSources": [],
  "weatherAvailable": true,
  "version": "1.0.0"
}
```

### 8.3 Upload from Render Function

The `GCSUploader` module wraps `@google-cloud/storage`:

```typescript
class GCSUploader {
  async upload(objectName: string, buffer: Buffer, contentType: string): Promise<void> {
    const file = this.bucket.file(objectName);
    await file.save(buffer, {
      contentType,
      metadata: {
        cacheControl: "no-cache, no-store, must-revalidate",
        "x-render-timestamp": new Date().toISOString()
      }
    });
  }
}
```

**Upload order**: PNG is uploaded first, then JPEG, then metadata JSON. The Kindle request
always returns the latest complete image because:
1. The serve function reads from GCS synchronously on each request
2. The Cloud Scheduler does not overlap (max-concurrency=1 on render function)
3. GCS uploads are atomic per object

### 8.4 Download / Stream from Serve Function

The serve function does not buffer the image in memory. It streams directly from GCS to the
HTTP response:

```typescript
const file = bucket.file(objectKey);
const [exists] = await file.exists();
if (!exists) {
  res.status(503).json({ error: "not_rendered_yet", retryAfter: 60 });
  return;
}
const [metadata] = await file.getMetadata();
res.setHeader("Content-Type", metadata.contentType);
res.setHeader("Content-Length", metadata.size);
res.setHeader("Cache-Control", "no-store");
file.createReadStream().pipe(res);
```

This streaming approach:
- Does not require loading the full 500KB image into the 256MB function's memory
- Allows the Kindle to start receiving bytes immediately
- Propagates GCS backpressure correctly via Node.js stream piping

### 8.5 GCS IAM Configuration

| Principal | Role | Purpose |
|-----------|------|---------|
| render function service account | `roles/storage.objectAdmin` | Upload + delete images |
| serve function service account | `roles/storage.objectViewer` | Download images |
| `allUsers` | `roles/storage.objectViewer` | Public read for Kindle direct URL option |

If using the UUID-in-path privacy approach, `allUsers` objectViewer is still needed (the
bucket is public but URLs are unguessable).

---

## 9. Configuration

### 9.1 config.yaml Structure

The canonical configuration file. Lives at `functions/config.yaml`. Contains no secret values;
only references to Secret Manager secret names.

```yaml
# functions/config.yaml

display:
  width: 1072
  height: 1448
  dpi: 300
  colorMode: grayscale
  timezone: "Europe/Madrid"

location:
  name: "Valencia, Spain"
  latitude: 39.4699
  longitude: -0.3763

calendars:
  - id: personal
    type: google
    label: "Personal"
    credentialRef: "kindle-cal-oauth-personal"   # Secret Manager secret name
    calendarId: "primary"
    displayStyle: solid

  - id: work
    type: google
    label: "Work"
    credentialRef: "kindle-cal-oauth-work"
    calendarId: "work@example.com"
    displayStyle: dashed

  - id: shared
    type: google
    label: "Family"
    serviceAccountRef: "kindle-cal-svcaccount"
    calendarId: "family-calendar-id@group.calendar.google.com"
    displayStyle: dotted

weather:
  provider: openmeteo
  units: metric

screens:
  - name: default
    template: "default/index.html"
    schedule: "*/15 * * * *"
    dataProviders:
      - calendar
      - weather
      - datetime

cache:
  renderTTLSeconds: 300
  weatherTTLSeconds: 900
  calendarTTLSeconds: 300

endpoints:
  secret: ""   # Optional: set to a UUID for obscured GCS URL path prefix

storage:
  bucketName: "kindle-screens-{project-id}"   # Replace with actual GCS bucket name
  region: "europe-west1"
```

### 9.2 TypeScript Config Schema

The config schema is defined in `config/types.ts` using TypeScript interfaces. The config
loader in `config/loader.ts` reads and validates `config.yaml` at startup using a JSON
Schema validator (e.g., `ajv`).

```typescript
// Excerpt from config/types.ts (see requirements.md section 9 for full schema)

interface KindleCalendarConfig {
  display: DisplayConfig;
  location: LocationConfig;
  calendars: CalendarSourceConfig[];
  weather: WeatherConfig;
  screens: ScreenConfig[];
  cache: CacheConfig;
  endpoints: EndpointsConfig;
  storage: StorageConfig;
}
```

Validation errors at startup produce a fatal log and prevent the function from serving
requests, ensuring misconfiguration is caught immediately.

### 9.3 Environment Variables

A small set of environment variables complement the config file:

| Variable | Default | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `production` | Enables mock providers in development |
| `GCP_PROJECT_ID` | (auto-detected in GCF) | GCP project for Secret Manager client |
| `FUNCTION_REGION` | `europe-west1` | Used in Secret Manager client path construction |
| `LOG_LEVEL` | `info` | pino log level: trace/debug/info/warn/error |
| `CONFIG_PATH` | `./config.yaml` | Override config file path for testing |

In Cloud Functions Gen 2, `GCP_PROJECT_ID` is automatically populated from the runtime
environment. `APPLICATION_DEFAULT_CREDENTIALS` is automatically configured by the Cloud Run
execution environment.

### 9.4 Dev vs. Prod Configuration

```
Development (NODE_ENV=development):
  - config.yaml is loaded normally
  - SECRET_MANAGER_MOCK=true: secrets loaded from local .env file instead of Secret Manager
  - MOCK_PROVIDERS=true: CalendarProvider and WeatherProvider return fixture data
  - Puppeteer uses locally installed Chromium (via puppeteer auto-download)

Production (NODE_ENV=production):
  - config.yaml is bundled with function deployment
  - Secrets fetched from GCP Secret Manager via Application Default Credentials
  - Real providers call live APIs
  - Puppeteer uses the bundled Chromium binary
```

---

## 10. Security Design

### 10.1 OAuth2 Token Security

- **At rest**: All OAuth2 refresh tokens and service account keys are stored exclusively in
  GCP Secret Manager. They are never written to source code, environment variables, config files,
  or logs.
- **In transit**: Secrets are fetched over TLS from the Secret Manager API. The Cloud Function
  uses Application Default Credentials (the function's service account) to authenticate.
- **In memory**: Secrets are cached in module-level state (a `Map<string, string>`) for the
  lifetime of the function instance. They are never written to disk (`/tmp`) or logged.
- **Access log**: All Secret Manager access is logged by GCP audit logs. If a refresh token is
  accessed unexpectedly, this is auditable.
- **Principle of least privilege**: The render function service account has only
  `roles/secretmanager.secretAccessor` for the specific secrets it needs, not project-wide access.

### 10.2 Render Function Security

- The render function is deployed with `--no-allow-unauthenticated` (IAM-protected)
- Cloud Scheduler is granted `roles/cloudfunctions.invoker` on the render function
- Direct external access to the render function URL is blocked at the IAM layer
- Additionally, the render handler validates the `X-CloudScheduler-JobName` request header

### 10.3 Serve Function Security

- The serve function is deployed with `--allow-unauthenticated` (public HTTP access)
- Image content: the rendered PNG contains calendar event titles and weather data.
  These are considered non-sensitive for personal use (no financial data, medical data, etc.)
- Optional URL token: if `config.endpoints.secret` is set, the serve function requires
  the URL path to include the token: `/screen.png` becomes `/{secret}/screen.png`
  (or the GCS object is stored at `{secret}/screen.png`). This provides obscurity-based
  access control without authentication overhead.
- The `/preview` endpoint is intentionally public (same as the image endpoints); it renders
  mock data in production, not live calendar data. Real-data preview is only in dev mode.

### 10.4 GCS Bucket Security

- Bucket is in the same GCP project as the functions; no cross-project access complexity
- Objects are publicly readable (required for Kindle direct-URL access)
- Objects are only writable by the render function service account
- The bucket is NOT configured for public listing (`storage.buckets.get` is not granted to
  `allUsers`); the URL must be known to access an object
- With `endpoints.secret` set: the Kindle URL contains the UUID prefix; URL is effectively
  private through obscurity

### 10.5 Firebase IAM Roles Required

| Service Account | Role | Scope | Purpose |
|----------------|------|-------|---------|
| render function SA | `roles/secretmanager.secretAccessor` | Per-secret | Read OAuth tokens |
| render function SA | `roles/storage.objectAdmin` | Bucket | Upload rendered images |
| serve function SA | `roles/storage.objectViewer` | Bucket | Download images to stream |
| Cloud Scheduler SA | `roles/cloudfunctions.invoker` | render function | Trigger scheduled renders |
| Developer | `roles/firebase.admin` | Project | Deploy functions, manage config |

### 10.6 No PII in Rendered Images

The rendered image contains:
- Calendar event titles (user-controlled; may contain names)
- Time ranges
- Weather data (public data)
- Location name (static config value: "Valencia, Spain")

It does NOT contain:
- Email addresses
- Phone numbers
- OAuth tokens or credentials
- Meeting join links or video URLs (v1 scope exclusion)

Meeting attendee names from Google Calendar API metadata are excluded in v1. The attendee
count (integer) may be displayed but not individual names.

---

## 11. Local Development

### 11.1 Dev Server Architecture

The dev server (`functions/src/dev/server.ts`) is a standalone Express application that
mirrors the serve and render function behaviors:

```
npm run dev
  -> ts-node functions/src/dev/server.ts
  -> Express listens on http://localhost:3000
  -> nodemon watches functions/src/ and functions/templates/ for changes
  -> Template hot-reload: TemplateEngine.clearCache() on file change events

Routes available locally:
  GET  /screen.png     -> runs full render pipeline (mock providers) -> returns PNG
  GET  /screen.jpg     -> runs full render pipeline -> returns JPEG
  GET  /preview        -> runs template render with mock data -> returns HTML
  GET  /health         -> returns mock health JSON
  POST /render         -> runs full render pipeline -> returns JSON with render stats
```

### 11.2 Mock Data Providers

`functions/src/dev/mock.providers.ts` exports mock implementations of all data providers.
These are used when `NODE_ENV=development` or `MOCK_PROVIDERS=true`.

```typescript
// Mock CalendarProvider returns fixture events
const mockEvents: CalendarEvent[] = [
  {
    id: "evt-1",
    title: "Team Standup",
    startFormatted: "09:00",
    endFormatted: "09:30",
    sourceLabel: "Work",
    displayStyle: "dashed",
    isInProgress: false,
    isAllDay: false,
    attendeeCount: 5
  },
  {
    id: "evt-2",
    title: "Design Review",
    startFormatted: "10:00",
    endFormatted: "12:00",
    sourceLabel: "Work",
    displayStyle: "dashed",
    isInProgress: true,   // Simulate "in progress" state
    isAllDay: false,
    attendeeCount: 12
  },
  // ... more fixtures
];

// Mock WeatherProvider returns fixed Valencia weather
const mockWeather: WeatherData = {
  temperature: 18,
  temperatureHigh: 22,
  temperatureLow: 13,
  conditionLabel: "Partly Cloudy",
  conditionIcon: "PCLOUD",
  windSpeed: 15,
  isAvailable: true
};
```

### 11.3 Testing Against Real Google Calendar API Locally

For local testing with real credentials:

```bash
# 1. Set up Application Default Credentials for local use
gcloud auth application-default login

# 2. Create a local .env file with test secret overrides
# .env (never commit this file)
SECRET_MANAGER_MOCK=true
OAUTH_PERSONAL_REFRESH_TOKEN=1//0gABC...
OAUTH_PERSONAL_CLIENT_ID=xxx.apps.googleusercontent.com
OAUTH_PERSONAL_CLIENT_SECRET=GOCSPX-...

# 3. Run dev server with real providers
MOCK_PROVIDERS=false npm run dev

# The secret loader checks SECRET_MANAGER_MOCK=true first and reads from
# the matching env vars instead of Secret Manager
```

This allows full end-to-end testing locally without deploying to Firebase.

### 11.4 Local Preview Workflow

```bash
# Start dev server with mock data
npm run dev

# Open in browser (auto-refreshes when templates change)
open http://localhost:3000/preview

# Generate PNG locally for visual inspection
npm run render:local
# -> outputs to ./tmp/screen-preview.png
# -> opens in default image viewer (macOS: open; Linux: xdg-open)

# Run full render with real APIs
MOCK_PROVIDERS=false npm run render:local
```

### 11.5 npm Scripts

```json
{
  "scripts": {
    "dev": "nodemon --watch src --watch templates --ext ts,html,css --exec ts-node src/dev/server.ts",
    "build": "tsc --project tsconfig.json",
    "lint": "eslint src --ext .ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "render:local": "ts-node scripts/render-local.ts",
    "preview": "open http://localhost:3000/preview",
    "deploy": "firebase deploy --only functions",
    "deploy:render": "firebase deploy --only functions:kindleRender",
    "deploy:serve": "firebase deploy --only functions:kindleServe",
    "setup:oauth": "ts-node scripts/oauth-setup.ts",
    "setup:bucket": "bash scripts/create-bucket.sh",
    "emulate": "firebase emulators:start --only functions"
  }
}
```

---

## 12. Deployment

### 12.1 Prerequisites

1. GCP project created with billing enabled (Blaze plan required for outbound HTTP)
2. Firebase CLI installed: `npm install -g firebase-tools`
3. Firebase project initialized: `firebase init`
4. `gcloud` CLI installed and authenticated

### 12.2 GCS Bucket Setup

```bash
# scripts/create-bucket.sh

PROJECT_ID=$(gcloud config get-value project)
BUCKET_NAME="kindle-screens-${PROJECT_ID}"
REGION="europe-west1"

# Create bucket
gcloud storage buckets create "gs://${BUCKET_NAME}" \
  --location="${REGION}" \
  --uniform-bucket-level-access

# Grant public read access for objects
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="allUsers" \
  --role="roles/storage.objectViewer"

echo "Bucket created: gs://${BUCKET_NAME}"
echo "Update config.yaml: storage.bucketName: ${BUCKET_NAME}"
```

### 12.3 Secret Manager Setup

```bash
# For each Google account (run once per account)
npx ts-node scripts/oauth-setup.ts --account personal

# Verify secrets were created
gcloud secrets list --filter="name:kindle-cal"

# Grant render function service account access to secrets
RENDER_SA="kindle-render@${PROJECT_ID}.iam.gserviceaccount.com"
for SECRET in kindle-cal-oauth-personal kindle-cal-oauth-work kindle-cal-svcaccount; do
  gcloud secrets add-iam-policy-binding ${SECRET} \
    --member="serviceAccount:${RENDER_SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

### 12.4 Firebase Functions Deployment

```bash
# Build TypeScript
cd functions && npm run build

# Deploy both functions
firebase deploy --only functions

# Or deploy individually
firebase deploy --only functions:kindleRender
firebase deploy --only functions:kindleServe

# Verify deployment
firebase functions:list
```

**functions/index.ts exports**:

```typescript
export const kindleRender = onSchedule({
  schedule: "every 15 minutes",
  timeZone: "Europe/Madrid",
  region: "europe-west1",
  memory: "1GiB",
  timeoutSeconds: 60,
  maxInstances: 1,
  minInstances: 0
}, renderHandler);

export const kindleServe = onRequest({
  region: "europe-west1",
  memory: "256MiB",
  timeoutSeconds: 10,
  maxInstances: 10,
  minInstances: 0
}, serveHandler);
```

Note: The Cloud Scheduler job is created automatically by the `onSchedule` Firebase function
declaration. No separate `gcloud scheduler jobs create` command is needed.

### 12.5 Cloud Scheduler Configuration

The Cloud Scheduler job is implicitly created by the `onSchedule` function definition above.
If manual configuration is needed:

```bash
gcloud scheduler jobs create http kindle-render-trigger \
  --location="europe-west1" \
  --schedule="*/15 * * * *" \
  --uri="https://europe-west1-${PROJECT_ID}.cloudfunctions.net/kindleRender" \
  --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA}" \
  --oidc-token-audience="https://europe-west1-${PROJECT_ID}.cloudfunctions.net/kindleRender"
```

### 12.6 IAM Configuration

```bash
PROJECT_ID=$(gcloud config get-value project)

# Get the service accounts created for each function
RENDER_SA="kindle-render@${PROJECT_ID}.iam.gserviceaccount.com"
SERVE_SA="kindle-serve@${PROJECT_ID}.iam.gserviceaccount.com"

# Render function: object admin on GCS bucket
gcloud storage buckets add-iam-policy-binding "gs://kindle-screens-${PROJECT_ID}" \
  --member="serviceAccount:${RENDER_SA}" \
  --role="roles/storage.objectAdmin"

# Serve function: object viewer on GCS bucket
gcloud storage buckets add-iam-policy-binding "gs://kindle-screens-${PROJECT_ID}" \
  --member="serviceAccount:${SERVE_SA}" \
  --role="roles/storage.objectViewer"
```

Note: Firebase Cloud Functions Gen 2 automatically creates a dedicated service account per
function. Check the Firebase Console or `gcloud functions list` for the exact service account
email addresses.

### 12.7 Kindle Setup

```bash
# On Kindle, via SSH (koreader or KUAL terminal):

# Test HTTPS workaround first:
wget --no-check-certificate https://europe-west1-PROJECT_ID.cloudfunctions.net/kindleServe/health \
  -O /tmp/health.json && cat /tmp/health.json

# If successful, create the refresh script at /mnt/us/calendar-refresh.sh:
cat > /mnt/us/calendar-refresh.sh << 'EOF'
#!/bin/sh
URL="https://europe-west1-PROJECT_ID.cloudfunctions.net/kindleServe/screen.png"
OUTPUT="/tmp/kindle-calendar.png"

wget --no-check-certificate "$URL" -O "$OUTPUT" -q
if [ $? -eq 0 ] && [ -s "$OUTPUT" ]; then
    fbink -g file="$OUTPUT",w=1072,h=1448 --clear
fi
EOF
chmod +x /mnt/us/calendar-refresh.sh

# Add to crontab (refresh every 15 minutes):
# */15 * * * * /mnt/us/calendar-refresh.sh
```

If `--no-check-certificate` fails on the specific BusyBox wget version, create an nginx proxy:

```nginx
# On a VPS (e.g., Hetzner CX11, €4.90/month), nginx.conf:
server {
  listen 80;
  server_name kindle.example.com;

  location / {
    proxy_pass https://europe-west1-PROJECT_ID.cloudfunctions.net/kindleServe/;
    proxy_ssl_verify off;
    proxy_set_header Host europe-west1-PROJECT_ID.cloudfunctions.net;
  }
}
# Kindle URL becomes: http://kindle.example.com/screen.png (plain HTTP)
```

### 12.8 Optional CI/CD (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy to Firebase
on:
  push:
    branches: [main]
    paths:
      - "functions/**"
      - "firebase.json"

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: cd functions && npm ci
      - run: cd functions && npm run lint
      - run: cd functions && npm test
      - run: cd functions && npm run build
      - uses: w9jds/firebase-action@master
        with:
          args: deploy --only functions
        env:
          FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}
```

---

## 13. Implementation Plan

### Phase 1: Project Scaffold + Config + Local Dev Server

**Goal**: A working local dev server that serves a placeholder HTML page.

**Tasks**:
- Initialize Firebase project and TypeScript setup (`firebase init functions`)
- Configure `tsconfig.json` with `strict: true`, `target: ES2022`
- Set up ESLint + Prettier
- Implement `config/loader.ts` and `config/types.ts` (all TypeScript interfaces)
- Create `config.yaml` with placeholder values
- Implement `dev/server.ts` (Express, basic routes: /health, /preview placeholder)
- Implement `npm run dev` with nodemon hot-reload
- Add vitest configuration

**Deliverables**: `npm run dev` starts a server at localhost:3000; `/health` returns JSON.
**Test criteria**: `curl http://localhost:3000/health` returns `{ "status": "ok" }`.

---

### Phase 2: Template System + E-ink CSS + Mock Data Preview

**Goal**: A visually complete e-ink layout rendered in the browser using mock data.

**Tasks**:
- Implement `renderer/template.engine.ts` (Nunjucks setup, file loading, CSS inlining, font embedding)
- Create `templates/default/index.html` and partials (header, all-day, timeline, footer)
- Create `templates/default/style.css` with e-ink optimized CSS (see section 6.5)
- Embed IBM Plex Sans font files as base64 in the TemplateEngine
- Implement `dev/mock.providers.ts` (mock calendar events, mock weather, mock datetime)
- Wire up `/preview` route to render template with mock data
- Implement template file watching for hot-reload

**Deliverables**: `GET http://localhost:3000/preview` returns a fully styled HTML page at
1072x1448px resembling the layout diagram in section 6.6.
**Test criteria**: HTML renders in browser; visual inspection confirms typography, layout
zones, and all-caps section headers match design spec; no color used in CSS.

---

### Phase 3: Google Calendar Provider (Single Account)

**Goal**: Fetch real calendar events from one Google account in local dev mode.

**Tasks**:
- Implement `secrets/secret.manager.ts` with local `.env` fallback for development
- Implement `providers/calendar/google.source.ts` (Google Calendar API v3 client)
  - OAuth2 client setup using `googleapis` npm package
  - `calendar.events.list()` with correct time range (today in Europe/Madrid)
  - Map API response to `CalendarEvent` type
  - 5-second timeout on API calls
- Implement `providers/datetime/datetime.provider.ts` using luxon
- Run `scripts/oauth-setup.ts` for one Google account; write refresh token to local `.env`
- Wire `CalendarProvider` into dev server (use real provider when `MOCK_PROVIDERS=false`)

**Deliverables**: `MOCK_PROVIDERS=false npm run dev` fetches and displays today's real calendar
events from one Google account in the preview page.
**Test criteria**: Today's events from Google Calendar appear in the browser preview; events
are sorted by start time; timezone is correctly shown as Europe/Madrid.

---

### Phase 4: Multi-Account Calendar + Merge Logic

**Goal**: Support 3+ Google accounts with correct merge, dedup, and sort.

**Tasks**:
- Implement `providers/calendar/merger.ts` (merge, sort, dedup, allDay separation)
- Implement `providers/calendar/calendar.provider.ts` (orchestrates all sources with
  `Promise.allSettled` for fault tolerance)
- Implement `providers/calendar/ics.source.ts` (ICS URL fetch + `ical.js` parsing)
- Update `config.yaml` with all 3 calendar sources
- Run `scripts/oauth-setup.ts` for remaining Google accounts
- Update mock data to simulate multi-account merge (events from different sources)
- Test graceful degradation: disable one account's credentials and verify others still render

**Deliverables**: Preview shows merged events from 3 calendar sources; events from different
sources are visually differentiated by border style (solid/dashed/dotted).
**Test criteria**:
- Events from all 3 accounts appear in sorted order
- Duplicate events (same event on two synced calendars) appear only once
- Disabling one account's credentials produces a "Calendar unavailable" indicator without
  crashing the render
- All-day events appear in the separate all-day section

---

### Phase 5: Weather Provider (OpenMeteo)

**Goal**: Display real weather data for Valencia in the context bar.

**Tasks**:
- Implement `providers/weather/openmeteo.source.ts`
  - GET `https://api.open-meteo.com/v1/forecast` with Valencia coordinates
  - Parse WMO weather code to condition label and icon
  - 5-second timeout
- Implement `providers/weather/weather.provider.ts` with in-memory TTL caching
- Create WMO code lookup table (all codes 0-99 mapped to labels and ASCII icons)
- Wire weather provider into dev server and preview template
- Update header partial to display condition icon

**Deliverables**: Preview page context bar shows real temperature, condition, and high/low.
**Test criteria**:
- Weather data from OpenMeteo appears in preview
- Condition label matches the WMO code (verify against OpenMeteo docs)
- Temperature is displayed in Celsius
- If OpenMeteo is unreachable (simulate with offline mode): "Weather unavailable" displayed

---

### Phase 6: Puppeteer Render Pipeline + Grayscale Conversion

**Goal**: Generate a 1072x1448 grayscale PNG from the HTML template.

**Tasks**:
- Implement `renderer/puppeteer.ts` (browser launch, setViewport, setContent, screenshot)
  - Configure `--no-sandbox` and `--disable-dev-shm-usage` args for Cloud Run
  - Set 30s page load timeout
  - Implement browser close on error (prevent leaked browser processes)
- Implement `renderer/sharp.processor.ts` (grayscale PNG, grayscale JPEG, size verification)
- Add `npm run render:local` script that runs full render and saves `./tmp/screen-preview.png`
- Verify output dimensions (1072x1448), channels (1), bit depth (8-bit uchar)
- Verify PNG < 500KB and JPEG < 200KB

**Deliverables**: `npm run render:local` produces `./tmp/screen-preview.png` (grayscale PNG)
and `./tmp/screen-preview.jpg`.
**Test criteria**:
- `sharp` metadata on output: `{ width: 1072, height: 1448, channels: 1, format: 'png' }`
- PNG file size < 500KB
- JPEG file size < 200KB
- Visual inspection: text is sharp, no color artifacts, e-ink-safe layout

---

### Phase 7: Firebase Deployment (Render + Serve Functions)

**Goal**: Both Cloud Functions deployed and callable via their Firebase URLs.

**Tasks**:
- Implement `handlers/render.handler.ts` (Cloud Scheduler entry point, wraps RenderOrchestrator)
- Implement `handlers/serve.handler.ts` (HTTP entry point for all serve routes)
- Implement `renderer/orchestrator.ts` (wires all providers + renderer + uploader)
- Implement `storage/gcs.uploader.ts` (GCS upload with metadata)
- Configure `functions/index.ts` with `onSchedule` and `onRequest` exports
- Set function memory, timeout, region, and instance settings
- Run `firebase deploy --only functions`
- Configure IAM roles (see section 12.6)
- Test serve function: `curl https://<serve-url>/health`

**Deliverables**: Both functions deployed; `/health` returns JSON; `/screen.png` returns
HTTP 503 (not yet rendered).
**Test criteria**:
- Firebase Console shows both functions with green status
- `GET /health` returns 200 with metadata JSON
- `GET /screen.png` returns 503 (before first render)
- CloudWatch logs show function invocations

---

### Phase 8: Cloud Scheduler + GCS Cache

**Goal**: Automated 15-minute renders; Kindle can fetch pre-rendered image.

**Tasks**:
- Verify Cloud Scheduler job was created by `onSchedule` declaration (check Firebase Console)
- If needed, create manually (see section 12.5)
- Run `scripts/create-bucket.sh` to create GCS bucket with correct IAM
- Update `config.yaml` with actual GCS bucket name
- Redeploy functions with updated config
- Manually trigger a render: `POST <render-function-url>` (or wait for first scheduled trigger)
- Verify GCS objects appear: `gcloud storage ls gs://kindle-screens-{project-id}/`
- Test serve function: `GET /screen.png` now returns 200 with image bytes
- Test JPEG: `GET /screen.jpg` returns 200 with image bytes
- Test health: `GET /health` returns metadata with `lastRender` timestamp

**Deliverables**: System completes a full automated render cycle; serve function returns
pre-rendered image.
**Test criteria**:
- Cloud Scheduler fires every 15 minutes (verify in GCP Scheduler console)
- GCS contains `screen.png` and `screen.jpg` after first render
- `GET /screen.png` returns a valid 1072x1448 grayscale PNG
- Cloud Logging shows structured render logs with duration and size fields

---

### Phase 9: Kindle Integration Testing

**Goal**: Kindle successfully fetches and displays the rendered image.

**Tasks**:
- SSH into Kindle; test `wget --no-check-certificate` against serve function URL
- If successful: create `/mnt/us/calendar-refresh.sh` (see section 12.7)
- Set up Kindle crontab to run script every 15 minutes
- Verify FBInk displays the image at full resolution
- If `--no-check-certificate` fails: set up nginx proxy on VPS (section 12.7)
- Monitor Cloud Logging for Kindle requests appearing in serve function logs
- Verify image is visually correct on e-ink display (font rendering, contrast, layout)
- Run for 24 hours; verify no render failures in Cloud Logging

**Deliverables**: Kindle displays the calendar automatically, refreshing every 15 minutes.
**Test criteria**:
- Kindle wget exits with code 0 (success)
- FBInk displays image without error
- Image is visible and legible on e-ink display
- After 24 hours: 96 scheduled renders completed; serve function logs show Kindle requests
- No token refresh failures in Cloud Logging

---

## 14. Testing Strategy

### 14.1 Unit Tests

**Framework**: vitest

**Coverage targets**:

| Module | What to test |
|--------|-------------|
| `config/loader.ts` | Valid config parses correctly; missing required fields throw; invalid values fail validation |
| `providers/calendar/merger.ts` | Sort order; dedup with composite key; all-day separation; isInProgress annotation; empty input; single source |
| `providers/datetime/datetime.provider.ts` | Europe/Madrid timezone; DST transitions (last Sunday March, last Sunday October); date formatting strings |
| `providers/weather/openmeteo.source.ts` | WMO code mapping (all 0-99 codes); unit conversion; `isAvailable: false` on network error |
| `providers/calendar/google.source.ts` | API response mapping to CalendarEvent; recurring event expansion; all-day event detection |
| `providers/calendar/ics.source.ts` | ICS parse; timezone handling in ICS files; event filter to today |
| `renderer/sharp.processor.ts` | Output dimensions are 1072x1448; channels = 1; file size < limits |

**Mock strategy**: All external HTTP calls (Google Calendar API, OpenMeteo) are mocked using
`vitest.mock` or `msw` (Mock Service Worker). No network calls in unit tests.

**Fixture data**: JSON fixture files in `functions/src/__fixtures__/` for:
- Google Calendar API responses (real API response shapes with test data)
- OpenMeteo API responses
- ICS file content

### 14.2 Integration Tests

Integration tests run against real API responses (mocked at the HTTP layer with `msw`) and
test the full provider-to-DataContext pipeline.

```
Integration test scenarios:
1. "Happy path": all three calendar accounts return events; weather returns data
   -> DataContext has correct structure; merged event list is sorted; weather is populated

2. "One account fails": account-2 returns 401 (token expired)
   -> DataContext.failedSources = ["work"]; events from personal and shared still present

3. "Weather unavailable": OpenMeteo times out
   -> DataContext.weather.isAvailable = false; template renders "Weather unavailable"

4. "Empty calendar day": all calendars return 0 events
   -> DataContext.timedEvents = []; DataContext.allDayEvents = []; template renders gracefully

5. "DST boundary": test rendering at 01:59 on DST change day
   -> All event times displayed correctly in new offset
```

### 14.3 Render Tests (Visual Regression)

Render tests generate PNG fixtures and compare them to reference snapshots.

```
Test setup:
  - Run Puppeteer render with fixed mock DataContext and fixed datetime (no real-time)
  - Save output to functions/src/__fixtures__/snapshots/screen-{scenario}.png

Snapshot scenarios:
  - screen-default.png: typical weekday with 4 events
  - screen-busy.png: 8 events, 2 concurrent blocks
  - screen-empty.png: no events
  - screen-all-day.png: 2 all-day events + timed events
  - screen-in-progress.png: one event marked isInProgress (inverted colors)
  - screen-weather-unavailable.png: weather.isAvailable = false

Comparison:
  - On CI: pixel-diff against reference snapshots (threshold: 0 pixels for layout,
    small tolerance for font rendering anti-aliasing)
  - On template change: update snapshots with npm run test:update-snapshots
  - Snapshots are committed to the repository (only updated intentionally)
```

### 14.4 Image Validation Tests

Post-render assertions run on every test invocation:

```typescript
async function validateImageOutput(pngBuffer: Buffer, jpgBuffer: Buffer) {
  const pngMeta = await sharp(pngBuffer).metadata();
  expect(pngMeta.width).toBe(1072);
  expect(pngMeta.height).toBe(1448);
  expect(pngMeta.channels).toBe(1);       // Single channel grayscale
  expect(pngMeta.depth).toBe("uchar");    // 8-bit

  expect(pngBuffer.length).toBeLessThan(500 * 1024);   // < 500KB
  expect(jpgBuffer.length).toBeLessThan(200 * 1024);   // < 200KB
}
```

### 14.5 End-to-End Test

One manual E2E scenario run after each deployment:

```
1. Deploy functions (npm run deploy)
2. Wait for next Cloud Scheduler trigger (or manually POST to render function)
3. Verify GCS objects exist: gcloud storage ls gs://kindle-screens-{project-id}/
4. GET https://<serve-url>/screen.png -> download locally
5. Validate with sharp: width=1072, height=1448, channels=1
6. GET https://<serve-url>/health -> verify lastRender.timestamp is recent (< 20 minutes)
7. (On Kindle) wget the URL; verify FBInk renders correctly
```

Automated E2E is not included in v1 scope. The manual checklist in Phase 9 covers this.

---

## 15. Monitoring and Observability

### 15.1 Structured Logging with pino

All function code uses `pino` for structured JSON logging. Logs are automatically collected
by GCP Cloud Logging when running in Cloud Functions.

**Logger setup**:

```typescript
// functions/src/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level(label) {
      return { severity: label.toUpperCase() };  // Map pino levels to GCP severity
    }
  },
  base: {
    function: process.env.FUNCTION_NAME,
    revision: process.env.K_REVISION
  }
});
```

The `severity` field mapping ensures logs appear with correct severity levels in Cloud Logging
(INFO, WARNING, ERROR, CRITICAL) rather than pino's default level strings.

### 15.2 Log Events

Every significant event is logged as a structured JSON object with consistent field names:

| Event name | Level | Fields |
|------------|-------|--------|
| `render_start` | info | `{ event, screen, triggeredBy }` |
| `provider_fetch_start` | debug | `{ event, provider, account? }` |
| `provider_fetch_complete` | debug | `{ event, provider, durationMs, resultCount? }` |
| `provider_fetch_failed` | warn | `{ event, provider, account?, error, willDegrade: true }` |
| `render_complete` | info | `{ event, durationMs, sizePng, sizeJpg, calendarSources, failedSources, weatherAvailable }` |
| `render_failed` | error | `{ event, error, stack, gcsUpdated: false }` |
| `oauth_refresh_failed` | error | `{ event, account, statusCode, error }` |
| `gcs_upload_complete` | debug | `{ event, objectName, sizeBytes, durationMs }` |
| `gcs_upload_failed` | error | `{ event, objectName, error, retryAttempt }` |
| `serve_request` | info | `{ event, path, objectKey, latencyMs, statusCode }` |
| `gcs_miss` | warn | `{ event, objectKey, statusCode: 503 }` |

### 15.3 Cloud Logging Dashboards

Create a Cloud Logging dashboard with the following widgets:

**Widget 1: Render Success Rate (last 24h)**
```
Filter: jsonPayload.event = "render_complete" OR "render_failed"
Group by: event, 1 hour buckets
Visualization: Stacked bar (green = complete, red = failed)
```

**Widget 2: Render Duration (last 24h)**
```
Filter: jsonPayload.event = "render_complete"
Metric: jsonPayload.durationMs
Visualization: Line chart, P50/P95/P99 percentiles
```

**Widget 3: Image Sizes**
```
Filter: jsonPayload.event = "render_complete"
Metrics: jsonPayload.sizePng, jsonPayload.sizeJpg
Visualization: Line chart with 500KB and 200KB reference lines
```

**Widget 4: OAuth Refresh Failures**
```
Filter: jsonPayload.event = "oauth_refresh_failed"
Visualization: Count per 1h bucket; any value > 0 is notable
```

**Widget 5: Serve Request Latency**
```
Filter: jsonPayload.event = "serve_request"
Metric: jsonPayload.latencyMs
Visualization: Histogram
```

### 15.4 Alerts

Configure Cloud Monitoring alerting policies:

**Alert 1: Render pipeline failure**
```
Condition: render_failed log event count > 2 in 30-minute window
Notification: Email to project owner
Rationale: Occasional failures are tolerable (Kindle shows stale image);
           persistent failures indicate a systemic problem
```

**Alert 2: OAuth token refresh failure**
```
Condition: oauth_refresh_failed log event count >= 1 in 1-hour window
Notification: Email (high priority) — requires manual token refresh
Rationale: A single OAuth failure may indicate token revocation; requires immediate attention
```

**Alert 3: No renders in 2 hours (Cloud Scheduler health)**
```
Condition: render_complete log event count = 0 in last 2-hour window
Notification: Email
Rationale: Cloud Scheduler may have stopped; 8 consecutive missed renders
```

**Alert 4: GCS upload failure**
```
Condition: gcs_upload_failed log event count >= 3 in 1-hour window
Notification: Email
Rationale: Multiple upload failures suggest a GCS permissions or connectivity issue
```

### 15.5 /health Endpoint as Canary

The `/health` endpoint of the serve function provides a lightweight operational overview:

```json
{
  "status": "ok",
  "lastRender": {
    "timestamp": "2026-03-12T14:32:00+01:00",
    "durationMs": 18420,
    "sizePng": 412680,
    "sizeJpg": 183240,
    "calendarSources": ["personal", "work", "shared"],
    "failedSources": [],
    "weatherAvailable": true
  },
  "gcsObjects": {
    "png": true,
    "jpg": true
  },
  "age": {
    "seconds": 420,
    "stale": false
  }
}
```

The `age.stale` field is `true` if the last render was more than 30 minutes ago, indicating
the Cloud Scheduler may have stopped or the render function is repeatedly failing.

A simple external health check (e.g., UptimeRobot free tier) can poll `/health` every 5 minutes
and alert if `age.stale` is `true` or if the endpoint returns non-200.

### 15.6 Cost Monitoring

GCP Billing alerts:
- Set a billing alert at $5/month (well above expected ~$0.50/month) to catch unexpected cost spikes
- Enable the Cost Breakdown view in GCP Billing to identify if any component is unexpectedly billed

---

## Appendix A: Key Technical Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Template engine | Nunjucks | Full-featured; HTML-native; good TypeScript support |
| Font | IBM Plex Sans | Open source; excellent small-size legibility; woff2 compression |
| Calendar API | Google Calendar v3 via `googleapis` npm | Auto token refresh; type-safe |
| ICS parsing | `ical.js` | Maintained; handles recurring events |
| Timezone | `luxon` | Immutable API; best-in-class DST handling |
| Grayscale conversion | `sharp` | WASM-based; fast; no native build issues in Cloud Run |
| Logging | `pino` | Structured JSON; Cloud Logging compatible severity mapping |
| Testing | vitest | Fast; native ESM; vitest.mock for unit tests |
| HTTP client | Native `fetch` (Node.js 18+) | No external dependency; supports AbortController |
| Secret caching | Module-level Map | One fetch per cold start; zero latency on warm invocations |

## Appendix B: File Size Budget

| File | Budget | Notes |
|------|--------|-------|
| PNG output | < 500KB | Strictly enforced; Kindle memory constraint |
| JPEG output | < 200KB | Strictly enforced |
| HTML template (rendered) | ~500KB-1MB | Large due to embedded fonts; not sent to Kindle |
| Font woff2 (per face) | ~60-100KB | 3 faces = ~250KB embedded in template |
| Render function bundle | ~150MB | Puppeteer Chromium binary dominates |
| Serve function bundle | ~15MB | No Puppeteer; lightweight Node.js dependencies |

---

*Document generated: 2026-03-12 | Session: dev-arch-20260311-172353-6805ef5b*
*Architecture: Alternative A — Firebase Cloud Functions Gen 2 + GCS Cache*
