# Kindle Calendar Display - Requirements Document

**Project**: Kindle E-ink Calendar Display Server
**Date**: 2026-03-11
**Session**: dev-arch-20260311-172353-6805ef5b
**Status**: Greenfield - Requirements Analysis

---

## 1. Project Overview

A cloud-hosted HTTP server (Firebase Cloud Functions or AWS Lambda) that generates on-the-fly grayscale PNG/JPEG images optimized for display on a Kindle Paperwhite 3. The Kindle fetches the image via a simple HTTP GET request on a schedule, then displays it full-screen using FBInk. The image shows a daily dashboard: current date/time, weather for Valencia Spain, today's calendar events merged from multiple Google Calendars, and a task overview.

### System Context Diagram

```
  +------------------+        HTTP GET /screen.png        +----------------------+
  |  Kindle PW3      | ---------------------------------> |  Cloud Function      |
  |  BusyBox wget    |                                    |  (Node.js/TS)        |
  |  FBInk display   | <--------------------------------- |  - Render pipeline   |
  +------------------+       PNG (1072x1448 grayscale)    |  - Template engine   |
                                                          |  - Data aggregator   |
                                                          +----------+-----------+
                                                                     |
                              +--------------------------------------+----------+
                              |                |                |              |
                    +---------+------+ +-------+--------+ +-----+------+ +----+---------+
                    | Google         | | Weather API    | | Home       | | RSS / HTTP   |
                    | Calendar API   | | (OpenMeteo or  | | Assistant  | | JSON feeds   |
                    | (OAuth2)       | |  OpenWeather)  | | (optional) | | (optional)   |
                    +----------------+ +----------------+ +------------+ +--------------+
```

---

## 2. Functional Requirements

### 2.1 HTTP Endpoints

| ID   | Endpoint                  | Method | Description |
|------|---------------------------|--------|-------------|
| F-01 | `/screen.png`             | GET    | Serve current screen as 8-bit grayscale PNG, max 500KB |
| F-02 | `/screen.jpg`             | GET    | Serve current screen as 8-bit grayscale JPEG, max 200KB |
| F-03 | `/screen/{name}.png`      | GET    | Serve named screen variant (e.g., `/screen/night.png`) |
| F-04 | `/render`                 | POST   | Accept JSON body, render custom template on demand, return image |
| F-05 | `/preview`                | GET    | Return HTML preview of the screen for browser-based debugging |
| F-06 | `/health`                 | GET    | Return JSON `{"status":"ok","ts":"..."}` for uptime monitoring |

All endpoints must support plain HTTP (not HTTPS-only) because Kindle Paperwhite 3's BusyBox wget has limited or broken TLS support.

### 2.2 Image Generation

| ID   | Requirement |
|------|-------------|
| F-07 | Output image MUST be exactly 1072 x 1448 pixels (portrait), Kindle Paperwhite 3 native resolution |
| F-08 | Output MUST be 8-bit grayscale (single channel, no alpha) |
| F-09 | PNG output MUST be under 500KB |
| F-10 | JPEG output MUST be under 200KB |
| F-11 | Image MUST be generated fresh on each request (with optional in-memory cache TTL, see NF-06) |
| F-12 | Rendering MUST complete within 10 seconds (cloud function hard timeout minus margin) |
| F-13 | System MUST support HTML/CSS templates as the primary layout mechanism |
| F-14 | Grayscale conversion MUST preserve contrast: colors mapped to well-separated gray values |
| F-15 | Text rendering MUST be sharp (no sub-pixel antialiasing; use grayscale antialiasing only) |
| F-16 | System MUST support a `/render` POST endpoint for dynamic, data-injected one-off renders |

### 2.3 Calendar Integration

| ID   | Requirement |
|------|-------------|
| F-17 | System MUST connect to at least 2 Google Calendar accounts/calendars simultaneously |
| F-18 | All fetched calendars MUST be merged into a single unified event list |
| F-19 | Events MUST be filtered to the current calendar day (midnight-to-midnight in user's timezone) |
| F-20 | Each event card MUST show: title, start time, end time, calendar source identifier |
| F-21 | System MUST distinguish overlapping events across calendars |
| F-22 | System MUST support public ICS calendar URLs in addition to Google Calendar API (for read-only subscriptions) |
| F-23 | Events from different calendars MUST be visually differentiated using distinct grayscale patterns/weights |
| F-24 | System MUST indicate whether an event is currently in progress (highlight "now") |
| F-25 | All-day events MUST be shown separately from timed events |
| F-26 | System MUST show participant count where available from Google Calendar metadata |

### 2.4 Google Calendar OAuth2

| ID   | Requirement |
|------|-------------|
| F-27 | System MUST use Google OAuth2 with offline access for server-to-server calendar reads |
| F-28 | OAuth2 refresh tokens MUST be stored securely (Secret Manager / environment secrets) |
| F-29 | System MUST support multiple OAuth2 credentials (one per Google account being read) |
| F-30 | Token refresh MUST be handled automatically on expiry without manual intervention |
| F-31 | Alternatively, Google service accounts with Calendar API sharing MUST be supported for calendars owned by a GSuite account |

### 2.5 Weather Data

| ID   | Requirement |
|------|-------------|
| F-32 | System MUST fetch current weather for Valencia, Spain (39.4699° N, 0.3763° W) |
| F-33 | Weather display MUST include: current temperature (Celsius), condition icon/label, high/low for day |
| F-34 | Weather source MUST be configurable (OpenMeteo preferred - free, no API key; OpenWeatherMap as fallback) |
| F-35 | Weather data MUST be cached for at least 15 minutes to avoid hammering the weather API |

### 2.6 Date and Time Display

| ID   | Requirement |
|------|-------------|
| F-36 | System MUST display current date in human-readable format (e.g., "Wednesday, 11 March 2026") |
| F-37 | System MUST display current time in 24h format (or configurable 12h/24h) |
| F-38 | All times MUST be rendered in the user's local timezone: `Europe/Madrid` (CET/CEST) |
| F-39 | System MUST show a visual timeline or list of today's time blocks |

### 2.7 Task and Context Display

| ID   | Requirement |
|------|-------------|
| F-40 | System MUST show a "Today's approach" section summarizing task priorities |
| F-41 | Tasks can be sourced from: Google Calendar (all-day events used as tasks), a static YAML/JSON config, or a Home Assistant to-do list |
| F-42 | System MUST show current user state/location: "Valencia, Spain" (static config initially, dynamic via Home Assistant optionally) |
| F-43 | System SHOULD indicate focus blocks or break recommendations between heavy meeting loads |

### 2.8 Template System

| ID   | Requirement |
|------|-------------|
| F-44 | Templates MUST be defined as HTML + CSS files loaded by the render engine |
| F-45 | Templates MUST receive a JSON data context object containing: date, time, events, weather, tasks, location |
| F-46 | Template engine MUST support a default "daily" template and named alternates |
| F-47 | Template CSS MUST use only grayscale-safe styling (no color, or colors auto-converted) |
| F-48 | System MUST support custom fonts embedded in the render environment |

### 2.9 Additional Data Providers

| ID   | Requirement |
|------|-------------|
| F-49 | System MUST support generic HTTP JSON endpoints as data sources (configured via YAML) |
| F-50 | System SHOULD support RSS feed ingestion for a "headlines" widget |
| F-51 | System SHOULD support Home Assistant REST API as a data provider for sensors/state |

### 2.10 Scheduling and Cache Invalidation

| ID   | Requirement |
|------|-------------|
| F-52 | System MUST support cron-style scheduled pre-renders (e.g., every 15 minutes) using cloud scheduler |
| F-53 | Pre-rendered images MUST be stored in object storage (Firebase Storage / S3) and served on Kindle request to avoid render-on-request latency |
| F-54 | The `/render` POST endpoint MUST trigger an immediate re-render and cache update |
| F-55 | System SHOULD support event-driven invalidation (e.g., calendar webhook pushes → triggers re-render) |
| F-56 | Cache TTL for each data provider MUST be individually configurable |

---

## 3. Non-Functional Requirements

### 3.1 Performance

| ID    | Requirement |
|-------|-------------|
| NF-01 | End-to-end render time (data fetch + image generation) MUST be under 10 seconds |
| NF-02 | Cold start time for the cloud function MUST be mitigated; warm-path (serving cached image from storage) MUST respond in under 1 second |
| NF-03 | Headless browser (if used) MUST be pre-warmed or replaced with a faster rendering path for the hot path |
| NF-04 | Data fetching for all providers MUST be parallelized (Promise.all / concurrent requests) |
| NF-05 | Google Calendar API calls MUST complete within 3 seconds; timeout and fallback to cached data if exceeded |
| NF-06 | In-memory render cache TTL: 5 minutes default (configurable). Requests within TTL serve cached bytes without re-rendering |
| NF-07 | The system MUST serve 99% of Kindle requests from pre-rendered cache (hot path), with cold render only on schedule or explicit trigger |

### 3.2 Reliability

| ID    | Requirement |
|-------|-------------|
| NF-08 | If any data provider fails, system MUST render with graceful degradation: show last known data with a "stale" indicator |
| NF-09 | If the render pipeline itself fails, system MUST return the last successfully generated cached image rather than an error |
| NF-10 | System MUST log all failures with structured JSON logs compatible with cloud provider log aggregation |
| NF-11 | Google Calendar token refresh failures MUST trigger an alert (email/notification) without crashing the render |

### 3.3 Security

| ID    | Requirement |
|-------|-------------|
| NF-12 | Google OAuth2 refresh tokens MUST be stored in cloud secret management (Firebase Secret Manager or AWS Secrets Manager), NOT in environment variables or source code |
| NF-13 | The HTTP endpoint serving images to Kindle MUST be either: (a) public with no sensitive data exposure risk, or (b) protected by a static secret token in the URL path |
| NF-14 | API keys for weather and other services MUST be stored in cloud secrets, not hardcoded |
| NF-15 | The `/render` POST endpoint MUST be protected by a bearer token or API key to prevent unauthorized renders |
| NF-16 | Source code MUST NOT contain any credentials, tokens, or personal data |

### 3.4 Scalability

| ID    | Requirement |
|-------|-------------|
| NF-17 | System is single-tenant (one user, one Kindle) - horizontal scaling is NOT a requirement |
| NF-18 | Cloud function MUST scale to zero when not in use (cost optimization) |
| NF-19 | Cloud scheduler invocations MUST NOT stack if previous render is still running (idempotency guard) |

### 3.5 Maintainability

| ID    | Requirement |
|-------|-------------|
| NF-20 | All configuration (calendars, data providers, display settings, timezone) MUST be in a single YAML or JSON config file |
| NF-21 | Adding a new data provider MUST require only: writing a provider module + adding config entry (no core changes) |
| NF-22 | Templates MUST be hot-reloadable in development without restarting the server |
| NF-23 | The codebase MUST be TypeScript with strict mode enabled |
| NF-24 | The project MUST include a local development mode that serves on localhost with auto-refresh |

### 3.6 Observability

| ID    | Requirement |
|-------|-------------|
| NF-25 | Each render MUST log: render duration (ms), data provider durations, image size (bytes), cache hit/miss |
| NF-26 | The `/health` endpoint MUST report: uptime, last render timestamp, last render duration, cache status |

---

## 4. Constraints

### 4.1 Kindle Device Constraints

| ID   | Constraint | Impact |
|------|------------|--------|
| C-01 | Kindle Paperwhite 3 uses BusyBox wget which has broken or absent SNI/TLS support | Server MUST be reachable over plain HTTP (port 80), OR the URL must avoid TLS certificate validation issues. Using a cloud function behind a plain HTTP proxy or a VPS with HTTP is required |
| C-02 | Kindle screen is 1072 x 1448 at 300 DPI, 8-bit grayscale only | Output must be exactly this resolution; any RGB output must be converted to grayscale |
| C-03 | FBInk on Kindle expects a standard image format (PNG or JPEG) | No exotic formats; standard PNG or JPEG only |
| C-04 | Kindle runs on a scheduled cron (via koreader / custom script), not event-driven | Server must tolerate bursty single requests on schedule, no persistent connection |
| C-05 | Kindle wget does not support HTTP/2 or complex headers | Response must be standard HTTP/1.1 with plain Content-Type |
| C-06 | PNG over 500KB or JPEG over 200KB may be unusable depending on Kindle memory | Image compression must be tuned to meet size limits |

### 4.2 Cloud Function Constraints

| ID   | Constraint | Impact |
|------|------------|--------|
| C-07 | Firebase Cloud Functions (Gen 2) max timeout: 60 minutes, but billing and cold start make <10s practical | Render pipeline must complete in <10s; use pre-render + cache pattern for Kindle hot path |
| C-08 | AWS Lambda max timeout: 15 minutes; same practical constraint applies | Same as above |
| C-09 | Headless Chromium (Puppeteer) binary is ~130MB compressed; fits in Lambda/CF but increases cold start by 3-8 seconds | Pre-warm strategy required; OR replace headless browser with node-canvas + sharp for cold-start-sensitive paths |
| C-10 | Cloud functions have ephemeral /tmp storage (~512MB Lambda, 8GB CF Gen2 with filesystem mounts) | Chromium temp files and font caches must fit in /tmp |
| C-11 | Firebase free tier (Spark) does NOT allow outbound HTTP calls to external APIs | Blaze (pay-as-you-go) plan required for Google Calendar, weather API calls |
| C-12 | Memory limit matters: Puppeteer needs ~512MB minimum | Cloud function must be configured with at least 1GB RAM |

### 4.3 Google Calendar API Constraints

| ID   | Constraint | Impact |
|------|------------|--------|
| C-13 | Google Calendar API has a quota of 1,000,000 requests/day but 10 requests/second per user | Aggressive caching required; do not fetch on every Kindle request |
| C-14 | OAuth2 access tokens expire after 1 hour | Automatic refresh token flow required |
| C-15 | Google Calendar API requires HTTPS for OAuth callbacks | OAuth setup/initial auth flow must happen in a browser on a HTTPS capable machine, not on Kindle |
| C-16 | Multiple Google accounts require separate OAuth2 credentials and refresh tokens | Token storage must support a list/map of credentials keyed by account identifier |

### 4.4 Rendering Constraints

| ID   | Constraint | Impact |
|------|------------|--------|
| C-17 | E-ink displays have limited grayscale levels (Kindle PW3: 16 levels) | Dithering or posterization may improve appearance; gradients should be avoided |
| C-18 | E-ink ghosting: previous image bleeds through | High-contrast layouts with clear white backgrounds preferred; avoid large gray fills |
| C-19 | E-ink refresh is slow (~1 second full refresh); partial refresh is partial-support | Display update frequency should be no more than every 5-15 minutes |
| C-20 | Font rendering at 300 DPI: small text (< 8pt) may be illegible | Minimum font size: 14px at 1x scale (maps to ~3.7pt equivalent in CSS at 96dpi; but at 300dpi renders sharper) - use 16px+ for body text |

### 4.5 Financial Constraints

| ID   | Constraint | Impact |
|------|------------|--------|
| C-21 | Target: near-zero cost (personal project) | Use free-tier cloud resources where possible; scale-to-zero required |
| C-22 | OpenMeteo weather API is free with no key required | Preferred over OpenWeatherMap (requires paid plan for commercial-level use) |
| C-23 | Google Calendar API is free within quota | No billing concern for personal use |

---

## 5. Assumptions

| ID   | Assumption |
|------|------------|
| A-01 | The user's primary timezone is `Europe/Madrid` (CET UTC+1 / CEST UTC+2); all time display and calendar filtering uses this timezone |
| A-02 | The user's location is static: Valencia, Spain. Coordinates: 39.4699° N, 0.3763° W. Dynamic location tracking is out of scope for v1 |
| A-03 | The Kindle is on the same local network or has internet access and can reach the cloud function URL |
| A-04 | The Kindle refresh script (cron + wget + FBInk) already exists or will be set up separately; this project only provides the server-side image endpoint |
| A-05 | Google Calendar access will be set up via OAuth2 by the user during initial configuration (one-time browser-based flow), not by the cloud function itself |
| A-06 | The user controls all Google Calendar accounts being read, or has been granted read access by the calendar owners |
| A-07 | "Multiple calendars" means 2-5 calendars (not hundreds); the merged event list fits comfortably in a single daily view |
| A-08 | The "tasks for today and how to approach them" section is based on calendar event density analysis and optionally static priority notes, NOT an AI inference engine (AI task analysis is a future enhancement) |
| A-09 | Plain HTTP is acceptable from a security standpoint because the image content is non-sensitive (no PII beyond meeting titles visible on screen) |
| A-10 | The cloud function is deployed to a single region (eu-west for proximity to Valencia) |
| A-11 | Development and deployment will use Node.js 20 LTS or Node.js 22 LTS |
| A-12 | The reference mobile screenshot (colorful meeting cards) is for visual reference only; the actual design will be adapted for grayscale e-ink from scratch |

---

## 6. Dependencies

### 6.1 Runtime Dependencies

| Category | Package / Service | Purpose | Notes |
|----------|------------------|---------|-------|
| Rendering | `puppeteer` or `playwright` | Headless Chromium for HTML→PNG | ~130MB binary; cold start concern |
| Rendering (alt) | `node-canvas` + `sharp` | Canvas-based rendering without browser | Faster cold start; less flexible layout |
| Image processing | `sharp` | Resize, grayscale convert, PNG/JPEG encode | Always required regardless of render path |
| Calendar | `googleapis` (npm) | Google Calendar API v3 client | OAuth2 support built-in |
| Calendar (ICS) | `ical.js` or `node-ical` | Parse ICS/iCal feeds | For public calendar URLs |
| Template | `handlebars` or `nunjucks` | HTML template rendering with data context | For headless browser render path |
| HTTP server | `express` or `fastify` | HTTP endpoint handling | Wrapped in cloud function |
| Config | `js-yaml` | Parse YAML config file | |
| Timezone | `luxon` or `date-fns-tz` | Timezone-aware date arithmetic | Critical for Europe/Madrid handling |
| Scheduler | Cloud Scheduler (GCP) or EventBridge (AWS) | Trigger pre-renders on cron | |
| Storage | Cloud Storage (GCS) or S3 | Store pre-rendered images | Serve cached images to Kindle |
| Secrets | Secret Manager (GCP) or AWS Secrets Manager | Store OAuth2 tokens, API keys | |
| Logging | `pino` | Structured JSON logging | |

### 6.2 External API Dependencies

| Service | URL | Auth | Free Tier | Rate Limit |
|---------|-----|------|-----------|------------|
| Google Calendar API v3 | `https://www.googleapis.com/calendar/v3/` | OAuth2 | Yes | 10 req/sec/user |
| OpenMeteo | `https://api.open-meteo.com/v1/forecast` | None | Yes (unlimited) | Fair use |
| OpenWeatherMap (fallback) | `https://api.openweathermap.org/data/2.5/` | API key | 1000 calls/day | 60 calls/min |
| Home Assistant REST API | User-configured URL | Long-lived token | Self-hosted | N/A |

### 6.3 Development Dependencies

| Package | Purpose |
|---------|---------|
| `typescript` | TypeScript compiler |
| `ts-node` / `tsx` | TypeScript dev runner |
| `jest` or `vitest` | Unit testing |
| `nodemon` | Dev auto-restart |
| `eslint` + `@typescript-eslint/*` | Linting |
| `firebase-tools` (if Firebase) | Deploy CLI |
| `aws-cdk` or `serverless` framework (if AWS) | Infrastructure as code |

### 6.4 Infrastructure Dependencies

| Component | GCP Option | AWS Option | Notes |
|-----------|-----------|-----------|-------|
| Compute | Cloud Functions Gen 2 | Lambda (Node.js runtime) | Serverless |
| Storage | Cloud Storage (GCS) | S3 | Pre-rendered image cache |
| Scheduler | Cloud Scheduler | EventBridge Scheduler | Cron triggers |
| Secrets | Secret Manager | Secrets Manager | OAuth tokens |
| Logging | Cloud Logging | CloudWatch | Auto-integrated |
| HTTP gateway | Cloud Run URL (Gen2 = Cloud Run) | API Gateway | Plain HTTP possible |

---

## 7. Architecture Decision Records (ADRs)

### ADR-001: Rendering Engine Selection

**Decision needed**: Headless browser (Puppeteer) vs. programmatic canvas (node-canvas + sharp)

**Option A: Puppeteer/Playwright + HTML/CSS templates**
- Pros: Full CSS layout engine; easy to design visually; template-driven; supports web fonts natively
- Cons: ~130MB binary; 3-8 second cold start overhead; needs more RAM (1GB+); Chromium sandbox issues in some Lambda environments
- Use case: Ideal for complex, visually rich layouts defined in HTML/CSS

**Option B: node-canvas + sharp (programmatic)**
- Pros: No large binary; fast cold start (<500ms); lower memory; precise pixel control
- Cons: All layout must be coded programmatically; no CSS; harder to iterate visually
- Use case: Ideal for simple, fixed-layout displays

**Option C: Hybrid - SVG template + sharp rasterize**
- Pros: SVG is text-based (no binary); can be templated with Handlebars; sharp can rasterize SVG
- Cons: SVG layout is more complex than HTML/CSS; limited font support without embedded fonts
- Use case: Middle ground; works for icon-heavy designs

**Recommendation**: Start with **Option A (Puppeteer)** for development flexibility, with a pre-render + cache pattern to hide cold start. If cold start remains problematic after profiling, migrate hot-path rendering to Option C (SVG + sharp) for the cached path only.

---

### ADR-002: Cloud Platform Selection

**Decision needed**: Firebase Cloud Functions vs. AWS Lambda

**Firebase (GCP)**
- Pros: Tight integration with GCS, Secret Manager, Cloud Scheduler; good free tier for functions; Firebase Storage for image cache; simpler auth setup with Google services (Calendar API on same Google ecosystem)
- Cons: Gen 1 functions had cold start issues; Gen 2 (Cloud Run backed) is better but slightly more complex
- Pricing: Cloud Run pricing applies for Gen 2; first 2M requests/month free

**AWS Lambda**
- Pros: Mature platform; Lambda Layers for shared binaries (Puppeteer layer exists); 15-min timeout; SnapStart for warm starts (Java only, not Node.js)
- Cons: More configuration for API Gateway + CloudFront; separate IAM complexity; Google Calendar OAuth on AWS requires more manual credential handling
- Pricing: 1M requests/month free; compute charges apply

**Recommendation**: **Firebase Cloud Functions Gen 2** (Cloud Run backed). The Google ecosystem integration (same auth infrastructure as Google Calendar API, Secret Manager, Cloud Scheduler) reduces operational complexity for a single-user personal project.

---

### ADR-003: Serving Pre-rendered vs. On-the-fly Images to Kindle

**Decision needed**: Render every Kindle GET request vs. serve pre-rendered cache

**Option A: On-the-fly render on every GET**
- Kindle sends GET → function wakes → fetches data → renders → returns image
- Pros: Always fresh data; simple architecture
- Cons: 5-15 second response time; Kindle wget may time out; cold start amplifies latency; Google Calendar API hammered on every refresh

**Option B: Pre-render on schedule + serve from cache**
- Scheduler (every 5-15 min) → render function → stores PNG in GCS/S3
- Kindle sends GET → lightweight function → streams image from storage
- Pros: Sub-second response to Kindle; cold start only on scheduled render (invisible to Kindle); Google Calendar API called on schedule, not per-request
- Cons: Data may be up to 15 min stale; more moving parts (scheduler + storage)

**Option C: Hybrid - serve cached, background refresh**
- Kindle GET hits function → returns cached image immediately → triggers background re-render
- Pros: Fresh-ish data; Kindle always gets fast response
- Cons: Cloud functions cannot reliably run background work after response is sent (in some runtimes)

**Recommendation**: **Option B (Pre-render on schedule)**. The Kindle does not need real-time data; calendar events for "today" are known in advance. 5-15 minute staleness is fully acceptable. This pattern also protects against headless browser cold start latency.

---

### ADR-004: Plain HTTP for Kindle Delivery

**Decision needed**: How to serve Kindle over HTTP given cloud functions default to HTTPS

**Problem**: Kindle Paperwhite 3 BusyBox wget cannot reliably handle modern TLS (SNI, cert chains). Cloud functions (Firebase/Lambda + API Gateway) default to HTTPS with valid certs.

**Options**:
1. **Cloudflare Workers proxy**: Deploy a Cloudflare Worker that proxies HTTPS → the image. Configure it to respond on a plain HTTP subdomain. Not straightforward; CF forces HTTPS.
2. **VPS reverse proxy**: A cheap VPS (€3-5/month) running nginx with `proxy_pass` to the cloud function. The VPS listens on HTTP (port 80) and proxies to the cloud function HTTPS URL. Kindle connects to VPS IP over HTTP.
3. **Use `--no-check-certificate` wget flag**: If the Kindle script uses `wget --no-check-certificate`, it can connect to HTTPS endpoints ignoring cert errors. This is the simplest solution.
4. **Cloud Storage public URL**: Pre-rendered image stored in public GCS/S3 bucket. Kindle fetches directly from storage URL. Storage URLs are HTTPS but some versions of wget handle them fine with `--no-check-certificate`.

**Recommendation**: **Option 3 first** (`wget --no-check-certificate` in Kindle script). If that fails with the specific BusyBox version, fall back to **Option 2** (VPS nginx proxy). This is a Kindle-side configuration decision, not a server-side architectural decision. Document both approaches.

---

### ADR-005: Google Calendar Authentication Strategy

**Decision needed**: Per-user OAuth2 vs. Google Service Account

**OAuth2 (user credentials)**
- User grants access via browser-based consent flow → refresh token stored in Secret Manager
- Works for: All Google Calendars the user owns or has been shared access to
- Multiple accounts: Requires separate OAuth2 credential set per Google account
- Complexity: One-time setup per account; then fully automated

**Service Account**
- Create a GCP service account → share individual calendars to service account email
- Works for: Only calendars explicitly shared with the service account
- Multiple accounts: One service account can be shared multiple calendars from different Google accounts
- Complexity: No OAuth flow; JSON key file used directly; cleaner for server-to-server

**Recommendation**: **Service Account** where possible (calendars under GSuite/Workspace), supplemented by **OAuth2 refresh tokens** for personal Gmail calendar accounts. Service accounts eliminate token expiry concerns for controlled calendars. Store service account key in Secret Manager, not in source code.

---

## 8. E-ink Display Design Requirements

### 8.1 Layout Zones

```
+------------------------------------------+
|  [DATE: Wednesday, 11 March 2026]   [TIME]|  <- Header zone (~80px)
|  [LOCATION: Valencia, Spain] [WEATHER]    |  <- Context bar (~60px)
+------------------------------------------+
|  ALL-DAY EVENTS (if any)                  |  <- All-day section (~80px, optional)
+------------------------------------------+
|  TIMELINE (8:00 - 22:00)                  |
|  +--------------------------------------+ |
|  | 09:00  [MEETING: Team Standup]       | |  <- Event cards
|  | 10:00  [                           ] | |
|  | 11:30  [MEETING: Design Review  +12] | |
|  | 13:00  [LUNCH BREAK              ] | |
|  | 14:00  [FREE]                       | |
|  | 15:00  [MEETING: 1:1 with Alex   ] | |
|  +--------------------------------------+ |  <- Remaining ~1100px
+------------------------------------------+
|  TASKS / TODAY'S APPROACH                 |  <- Task section (~200px)
|  [ ] Priority task 1                      |
|  [ ] Priority task 2                      |
+------------------------------------------+
|  Last updated: 14:32                      |  <- Footer (~40px)
+------------------------------------------+
```

### 8.2 Grayscale Design Rules

| Rule | Rationale |
|------|-----------|
| Black text (#000000) on white background (#FFFFFF) for all body text | Maximum contrast on e-ink |
| Event cards use border + fill pattern, not color fills | E-ink has 16 gray levels; solid gray fills cause ghosting |
| Use stroke weight (bold/regular) to differentiate calendar sources | E.g., Calendar A = bold border, Calendar B = dashed border |
| "Current" event (happening now) uses inverted colors (white text on black) | High visual salience without color |
| No gradients, shadows, or transparency | These render poorly on e-ink |
| All-caps section headers with heavy top border line | Clear visual hierarchy without color |
| Minimum font size: 16px at 96dpi equivalent | Readable at 300 DPI |

### 8.3 Typography Requirements

| Element | Weight | Approx Size |
|---------|--------|-------------|
| Date header | Bold | 32px |
| Time header | Regular | 28px |
| Section label | Bold, all-caps | 14px |
| Event title | SemiBold | 18px |
| Event time | Regular | 14px |
| Weather text | Regular | 16px |
| Task item | Regular | 16px |
| Footer / metadata | Light | 12px |

Font recommendation: **IBM Plex Sans** or **Inter** - both have excellent legibility at small sizes and are available as open source. Embed the font files in the project for deterministic rendering.

---

## 9. Configuration Schema

The system MUST be driven by a single config file. Below is the required schema (TypeScript interface):

```typescript
interface KindleCalendarConfig {
  display: {
    width: number;          // 1072
    height: number;         // 1448
    dpi: number;            // 300
    colorMode: "grayscale"; // fixed
    timezone: string;       // "Europe/Madrid"
  };
  location: {
    name: string;           // "Valencia, Spain"
    latitude: number;       // 39.4699
    longitude: number;      // -0.3763
  };
  calendars: CalendarSource[];
  weather: WeatherConfig;
  screens: ScreenConfig[];
  cache: {
    renderTTLSeconds: number;     // 300 (5 min)
    weatherTTLSeconds: number;    // 900 (15 min)
    calendarTTLSeconds: number;   // 300
  };
  endpoints: {
    secret?: string;   // Optional URL token: /screen/{secret}.png
  };
}

interface CalendarSource {
  id: string;                     // Unique identifier
  type: "google" | "ics";
  label: string;                  // Display name
  credentialRef?: string;         // Secret Manager key for OAuth token
  serviceAccountRef?: string;     // Secret Manager key for service account JSON
  calendarId?: string;            // Google Calendar ID
  icsUrl?: string;                // For ICS type
  displayStyle: "solid" | "dashed" | "dotted";  // Border style for differentiation
}

interface WeatherConfig {
  provider: "openmeteo" | "openweathermap";
  apiKeyRef?: string;             // Secret Manager key (openweathermap only)
  units: "metric" | "imperial";  // default: metric
}

interface ScreenConfig {
  name: string;                   // "default", "night", etc.
  template: string;               // Path to HTML template
  schedule?: string;              // Cron expression for pre-render
  dataProviders: string[];        // Which providers to include
}
```

---

## 10. Testing Requirements

| ID   | Requirement |
|------|-------------|
| T-01 | Unit tests MUST cover: data provider modules, calendar merge logic, timezone handling, config parsing |
| T-02 | Integration tests MUST cover: Google Calendar API fetch + parse cycle (with mocked HTTP) |
| T-03 | Render tests MUST produce fixture PNG files that can be visually inspected |
| T-04 | A `make preview` or `npm run preview` command MUST open the rendered screen in a local browser |
| T-05 | All tests MUST be runnable without cloud credentials (mock mode with fixture data) |
| T-06 | Image output tests MUST verify: dimensions (1072x1448), color mode (grayscale), file size under limit |

---

## 11. Open Questions

| ID   | Question | Priority |
|------|----------|----------|
| OQ-01 | Does the Kindle script use `wget --no-check-certificate`? If not, a plain HTTP proxy is needed. Determine this before cloud platform selection. | HIGH |
| OQ-02 | How many Google accounts / how many calendars total? This affects OAuth credential management complexity. | HIGH |
| OQ-03 | Should "tasks" be sourced from Google Calendar all-day events, a separate to-do service, or static config? | MEDIUM |
| OQ-04 | Is Home Assistant integration in scope for v1 or a future enhancement? | MEDIUM |
| OQ-05 | Should the system support multiple Kindles (e.g., one in the office, one in the bedroom) or strictly one device? | LOW |
| OQ-06 | What is the desired Kindle refresh frequency? (Every 5 min? 15 min? Hourly?) This drives caching TTL and scheduler interval choices. | MEDIUM |
| OQ-07 | Should event participants/attendees be shown (requires reading attendee data from Calendar API - GDPR consideration for shared calendars)? | MEDIUM |
| OQ-08 | Is a "night mode" screen (inverted, minimal) needed for nighttime display? | LOW |

---

## 12. Out of Scope (v1)

- AI-powered task prioritization or natural language schedule summaries
- Real-time push from calendar to Kindle (Kindle polls; no push channel)
- Multiple user support / multi-tenancy
- Kindle-side configuration UI
- Dynamic location tracking (location is static config)
- Offline mode / local server on Raspberry Pi (cloud function only for v1)
- Calendar write operations (read-only)
- Meeting join links / video conference URL extraction (future enhancement)
- SMS/email notifications
- Battery level or Kindle status monitoring

---

*Document generated: 2026-03-11 | Session: dev-arch-20260311-172353-6805ef5b*
