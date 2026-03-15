# Kindle Calendar Display - Design Alternatives

**Project**: Kindle E-ink Calendar Display Server
**Date**: 2026-03-11
**Session**: dev-arch-20260311-172353-6805ef5b
**Status**: Design Analysis

---

## Context Summary

The system generates 1072x1448 grayscale PNG images for a Kindle Paperwhite 3. A cloud-hosted
server fetches Google Calendar events (3+ calendars, multiple Google accounts), weather data for
Valencia Spain, and renders an HTML/CSS template via Puppeteer into a grayscale image. The Kindle
polls for the pre-rendered image every 15 minutes via BusyBox wget. The Kindle's wget has
limited/broken TLS support, making plain HTTP delivery a hard constraint.

Key constraints driving the design:
- Plain HTTP delivery required (Kindle BusyBox wget TLS limitations)
- Puppeteer binary (~130MB) creates cold start latency of 3-8 seconds
- Pre-render + cache pattern required (Kindle must receive response within wget timeout)
- 15-minute refresh cycle; ~100 renders/day for personal use
- Multiple Google OAuth2 credentials (one per Google account)
- Scale-to-zero cost optimization preferred
- Single-tenant; no horizontal scaling needed

---

## Alternative A: Firebase Cloud Functions Gen 2 + Puppeteer + GCS Cache

### Overview

Deploy the render pipeline as a Firebase Cloud Functions Gen 2 function (backed by Cloud Run).
A Cloud Scheduler job triggers a render every 15 minutes. The rendered PNG is stored in a GCS
(Google Cloud Storage) bucket. The Kindle fetches the image from a lightweight serve function
(or directly from a public GCS object URL). Google Calendar credentials are stored in Secret
Manager.

### Architecture Diagram

```
  +-------------------+
  | Cloud Scheduler   |  (every 15 min)
  | "render-trigger"  |
  +--------+----------+
           | HTTPS POST /internal/render
           v
  +----------------------------+          +---------------------------+
  | Cloud Function Gen 2       |          | Secret Manager            |
  | "render" (Node.js 22)      |          |                           |
  |                            |  reads   | - oauth_token_account_1   |
  |  RenderOrchestrator        +--------> | - oauth_token_account_2   |
  |  - CalendarProvider(s)     |          | - oauth_token_account_3   |
  |  - WeatherProvider         |          | - service_account_key     |
  |  - TemplateEngine          |          +---------------------------+
  |  - PuppeteerRenderer       |
  |  - SharpProcessor          |          +---------------------------+
  |  - GCSUploader             |  writes  | GCS Bucket                |
  |                            +--------> | "kindle-screens"          |
  +----------------------------+          | - screen.png (public)     |
                                          | - screen.jpg (public)     |
           +----------------------------+ +---------------------------+
           | External APIs             |            |
           | - Google Calendar API v3  |            | public HTTPS GET
           | - OpenMeteo API           |            v
           +----------------------------+  +------------------+
                                           | Kindle PW3       |
  +----------------------------+           | BusyBox wget     |
  | Cloud Function Gen 2       |           | (--no-check-cert)|
  | "serve" (lightweight)      |           +------------------+
  |                            |
  |  - Reads from GCS          | <-- optional: wraps GCS URL to allow
  |  - Returns image bytes     |     plain HTTP via Cloud Run URL
  |  - /health endpoint        |
  |  - /preview endpoint       |
  +----------------------------+
```

Note on plain HTTP: Cloud Functions Gen 2 URLs are HTTPS only. The Kindle uses
`wget --no-check-certificate` to bypass TLS validation. If that is not viable, a
lightweight nginx proxy on a small VPS ($3-5/month) proxies port 80 to the Cloud Run URL.
Alternatively, a public GCS object URL may work with `--no-check-certificate`.

### Component List

| Component | Technology | Purpose |
|-----------|-----------|---------|
| render function | Cloud Functions Gen 2 (Node.js 22) | Orchestrates full render pipeline |
| serve function | Cloud Functions Gen 2 (Node.js 22) | Lightweight: reads GCS, returns image |
| Cloud Scheduler job | GCP Cloud Scheduler | Triggers render every 15 min (cron) |
| GCS bucket | Google Cloud Storage | Stores pre-rendered images; public read |
| Secret Manager | GCP Secret Manager | Stores OAuth2 refresh tokens, service account keys |
| Cloud Logging | GCP Cloud Logging | Structured JSON log aggregation |
| CalendarProvider | TypeScript module | Fetches + merges events from multiple Google accounts |
| WeatherProvider | TypeScript module | Fetches OpenMeteo data for Valencia |
| TemplateEngine | Handlebars/Nunjucks | Renders HTML template with data context |
| PuppeteerRenderer | Puppeteer + Chromium | Renders HTML to full-resolution PNG |
| SharpProcessor | sharp | Converts to 8-bit grayscale, encodes PNG/JPEG |
| GCSUploader | @google-cloud/storage | Writes rendered image to GCS bucket |

### Data Flow

#### Render Pipeline (triggered by Cloud Scheduler every 15 min)

```
Cloud Scheduler
    -> POST /internal/render (Cloud Function "render")
        -> RenderOrchestrator.run()
            -> [parallel]
                -> CalendarProvider.fetchAll()
                    -> GoogleAuth.getClient(account1) [token from Secret Manager]
                    -> googleapis.calendar.events.list(calendarId, today_range)
                    -> GoogleAuth.getClient(account2) [token from Secret Manager]
                    -> googleapis.calendar.events.list(calendarId, today_range)
                    -> mergeAndSortEvents(events1, events2, ...)
                -> WeatherProvider.fetch()
                    -> GET https://api.open-meteo.com/v1/forecast?lat=39.47&lon=-0.38
                    -> parseWeatherResponse()
            -> DataContext = { date, time, events, weather, location }
            -> TemplateEngine.render("default", DataContext)
                -> Handlebars.compile(template)(DataContext) -> HTML string
            -> PuppeteerRenderer.renderHTML(html)
                -> browser.newPage()
                -> page.setContent(html)
                -> page.screenshot({ fullPage: true }) -> PNG buffer (RGB)
            -> SharpProcessor.toGrayscale(pngBuffer)
                -> sharp(buffer).grayscale().png().toBuffer() -> grayscale PNG
            -> GCSUploader.upload("screen.png", grayscalePNG)
            -> log({ renderDuration, imageSizeBytes, cacheUpdated: true })
```

#### Serve Pipeline (triggered by Kindle GET every 15 min)

```
Kindle wget GET /screen.png (--no-check-certificate)
    -> Cloud Function "serve"
        -> GCS.getObject("screen.png") -> stream
        -> Response: 200 OK, Content-Type: image/png, body: image bytes
        -> log({ serveLatency, cacheHit: true })

    [fallback if GCS empty]
        -> Trigger immediate render (POST to render function)
        -> Wait up to 10s for render to complete
        -> Return newly rendered image
```

### OAuth2 Credential Management for Multiple Google Accounts

Each Google account requires a separate OAuth2 credential set:

```
Secret Manager structure:
  kindle-calendar/oauth/account-1/refresh_token  -> "1//0..."
  kindle-calendar/oauth/account-1/client_id      -> "xxx.apps.googleusercontent.com"
  kindle-calendar/oauth/account-1/client_secret  -> "GOCSPX-..."
  kindle-calendar/oauth/account-2/refresh_token  -> "1//0..."
  kindle-calendar/oauth/account-2/client_id      -> "xxx.apps.googleusercontent.com"
  kindle-calendar/oauth/account-2/client_secret  -> "GOCSPX-..."
  kindle-calendar/service-account/key            -> { JSON key for GSuite calendars }
```

Config file references credentials by key name:
```yaml
calendars:
  - id: personal
    type: google
    credentialRef: kindle-calendar/oauth/account-1
    calendarId: primary
  - id: work
    type: google
    credentialRef: kindle-calendar/oauth/account-2
    calendarId: work@example.com
  - id: shared
    type: google
    serviceAccountRef: kindle-calendar/service-account/key
    calendarId: shared-team@group.calendar.google.com
```

Token refresh is handled automatically by the `googleapis` npm client. On 401 response, the
library uses the stored refresh token to obtain a new access token. The new access token is
ephemeral; the refresh token stored in Secret Manager is long-lived.

Initial OAuth flow (one-time per account): Run a local Node.js script that opens the Google
consent URL in a browser, captures the authorization code, exchanges it for tokens, and writes
the refresh token to Secret Manager. This is not automated by the cloud function.

### Pros

- Native ecosystem: GCP Secret Manager, Cloud Scheduler, GCS, and Google Calendar API are all
  in the same Google ecosystem; IAM roles are unified
- No cross-cloud auth complexity; the Cloud Function service account can be granted direct access
  to Secret Manager without additional credential plumbing
- GCS public URL serves images at CDN speed with no function invocation cost per Kindle request
- Cloud Functions Gen 2 (Cloud Run backed) has good cold start performance compared to Gen 1;
  minimum instances can be set to 1 at low cost to eliminate cold start entirely
- Cloud Scheduler integrates directly in GCP console; cron management in same platform
- Firebase CLI (firebase-tools) provides straightforward local emulation for development
- GCS free tier includes 5GB storage and 5,000 Class A operations/month (ample for personal use)

### Cons

- HTTPS-only endpoints: Cloud Run URLs are always HTTPS; Kindle TLS issue must be solved by
  `wget --no-check-certificate` or a separate HTTP proxy
- Puppeteer cold start: Even with Gen 2, first invocation after idle period takes 5-10s; this
  affects scheduled renders but not Kindle serve latency (Kindle reads from GCS)
- Firebase Blaze plan required: Outbound HTTP calls (to Google Calendar API, OpenMeteo) require
  the paid Blaze plan. Practically free at this scale but requires billing enabled.
- Two functions to deploy and maintain (render + serve); alternatively one function handles both
  paths, increasing bundle size
- GCS bucket must be set to "public" or use signed URLs; public is simpler but means anyone
  with the URL can see your calendar data (mitigated by using a random token in the filename)
- Secret Manager has a per-version cost ($0.06/10,000 access operations); at 100 renders/day
  this is negligible but adds another billed component

### Estimated Monthly Cost (100 renders/day, personal use)

| Component | Usage | Estimated Cost |
|-----------|-------|----------------|
| Cloud Functions Gen 2 invocations | ~3,000/month (render) + ~3,000/month (serve) | Free tier covers first 2M requests; $0 |
| Cloud Functions compute | ~3,000 renders x 10s x 1GB RAM | ~$0.10-0.30/month |
| Cloud Scheduler | 2 jobs (render trigger + health check) | $0 (first 3 jobs free) |
| GCS storage | <5MB of images at any time | $0 (well within 5GB free tier) |
| GCS operations | ~6,000 reads + 3,000 writes/month | $0 (within free tier) |
| Secret Manager | ~6,000 access operations/month | $0 (first 10,000 free) |
| Cloud Logging | <1GB/month logs | $0 (first 50GB/month free) |
| **Total** | | **~$0.10-0.50/month** |

Note: Firebase Blaze plan is required (pay-as-you-go) but costs remain near-zero at this scale.
There is no minimum monthly charge on Blaze beyond usage.

### Complexity Rating: 3/5

Setup requires: GCP project creation, Firebase Blaze upgrade, service account IAM config,
Secret Manager secrets, GCS bucket creation, two Cloud Functions, Cloud Scheduler job, and
one-time OAuth2 flow per Google account. The ongoing operational complexity is low once deployed.

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Kindle TLS incompatibility with Cloud Run URL | Medium | High | Use `wget --no-check-certificate`; fallback: nginx VPS proxy |
| Puppeteer cold start exceeds 10s on render function | Medium | Low | Cold start only affects scheduled renders, not Kindle; set min-instances=1 if needed |
| OAuth refresh token expiry / revocation | Low | High | Alert on 401 errors; re-run initial OAuth flow; consider service accounts where possible |
| GCS public URL exposure of calendar data | Medium | Medium | Use random token in object name (e.g., `screen-{secret-uuid}.png`) |
| Firebase free tier outbound call restriction | Certain | High | Requires Blaze plan; no workaround on Spark |
| Secret Manager access latency adds to render time | Low | Low | Secrets cached in-memory for process lifetime; only fetched once per cold start |
| Cloud Scheduler missed triggers during function scaling | Low | Low | Kindle shows stale image; acceptable for personal use |

---

## Alternative B: AWS Lambda + Chromium Lambda Layer + S3

### Overview

Deploy the render pipeline as an AWS Lambda function using a pre-built Chromium Lambda Layer
(e.g., `chrome-aws-lambda` or the community `serverless-chrome` layer). An EventBridge Scheduler
rule triggers the render Lambda every 15 minutes. The rendered PNG is stored in an S3 bucket.
A separate lightweight Lambda behind API Gateway serves the image to the Kindle. Secrets are
stored in AWS Secrets Manager.

### Architecture Diagram

```
  +-------------------+
  | EventBridge       |  (every 15 min cron)
  | Scheduler         |
  +--------+----------+
           | Lambda invoke (async)
           v
  +----------------------------+          +---------------------------+
  | Lambda: render             |          | AWS Secrets Manager       |
  | Node.js 22, 1GB RAM        |          |                           |
  | + Chromium Lambda Layer    |  reads   | - /kindle/oauth/account1  |
  |                            +--------> | - /kindle/oauth/account2  |
  |  RenderOrchestrator        |          | - /kindle/oauth/account3  |
  |  - CalendarProvider(s)     |          | - /kindle/service-acct    |
  |  - WeatherProvider         |          +---------------------------+
  |  - TemplateEngine          |
  |  - ChromiumRenderer        |          +---------------------------+
  |  - SharpProcessor          |  writes  | S3 Bucket                 |
  |  - S3Uploader              +--------> | "kindle-screens"          |
  +----------------------------+          | - screen.png              |
           |                              | - screen.jpg              |
           | fetches                      +---------------------------+
           v                                          |
  +---------------------------+           public S3 URL or API GW
  | External APIs             |                       |
  | - Google Calendar API     |                       v
  | - OpenMeteo API           |            +------------------+
  +---------------------------+            | API Gateway      |
                                           | HTTP API (v2)    |
                                           | GET /screen.png  |
  +----------------------------+           +--------+---------+
  | Lambda: serve              |                    |
  | Node.js 22, 128MB RAM      | <------------------+
  |                            |
  |  - GetObject from S3       |           +------------------+
  |  - Stream response         | --------> | Kindle PW3       |
  |  - /health endpoint        |           | BusyBox wget     |
  +----------------------------+           +------------------+

  Optional: CloudFront distribution in front of S3 for CDN caching
  (not needed for personal use)
```

Note on plain HTTP: API Gateway HTTP API (v2) is HTTPS-only. Options are identical to Alt A:
`wget --no-check-certificate`, or an HTTP-only custom domain via a VPS proxy. For S3 presigned
URLs or S3 website hosting, HTTP can be enabled on S3 static website endpoint directly.

### Component List

| Component | Technology | Purpose |
|-----------|-----------|---------|
| render Lambda | AWS Lambda Node.js 22, 1GB | Full render pipeline |
| serve Lambda | AWS Lambda Node.js 22, 128MB | Lightweight image serve |
| Chromium Layer | Lambda Layer (chrome-aws-lambda) | Provides Chromium binary for Puppeteer |
| EventBridge Scheduler | AWS EventBridge | Triggers render every 15 min |
| API Gateway | AWS API Gateway HTTP API v2 | HTTP frontend for serve Lambda |
| S3 bucket | AWS S3 | Pre-rendered image storage |
| Secrets Manager | AWS Secrets Manager | OAuth2 tokens, service account keys |
| CloudWatch | AWS CloudWatch | Log aggregation and metrics |
| IAM roles | AWS IAM | Lambda execution permissions |
| CalendarProvider | TypeScript module | Multi-account Google Calendar fetching |
| WeatherProvider | TypeScript module | OpenMeteo fetch for Valencia |
| TemplateEngine | Handlebars/Nunjucks | HTML template rendering |
| ChromiumRenderer | Puppeteer + chrome-aws-lambda | HTML to PNG rendering |
| SharpProcessor | sharp | Grayscale conversion and encoding |
| S3Uploader | @aws-sdk/client-s3 | Writes images to S3 |

### Data Flow

#### Render Pipeline (triggered by EventBridge every 15 min)

```
EventBridge Scheduler
    -> Lambda invoke (async): render function
        -> RenderOrchestrator.run()
            -> SecretsManager.getSecretValue("kindle/oauth/account1")
            -> SecretsManager.getSecretValue("kindle/oauth/account2")
            -> [parallel]
                -> CalendarProvider.fetch(account1Creds, calendarId1)
                -> CalendarProvider.fetch(account2Creds, calendarId2)
                -> WeatherProvider.fetch(lat=39.47, lon=-0.38)
            -> mergeAndSortEvents(allEvents)
            -> TemplateEngine.render("default", { date, time, events, weather })
            -> ChromiumRenderer.renderHTML(html)
                -> chromium.executablePath() [from Lambda Layer]
                -> puppeteer.launch({ executablePath, args: chromium.args })
                -> page.setContent(html)
                -> page.screenshot() -> RGB PNG buffer
            -> SharpProcessor.toGrayscale(pngBuffer) -> grayscale PNG
            -> S3.putObject({ Bucket: "kindle-screens", Key: "screen.png", Body: pngBuffer })
            -> log structured JSON to CloudWatch
```

#### Serve Pipeline (triggered by Kindle GET every 15 min)

```
Kindle wget GET /screen.png (via API Gateway)
    -> API Gateway HTTP API
    -> serve Lambda (128MB, fast cold start)
        -> S3.getObject("screen.png") -> stream
        -> Response: 200, Content-Type: image/png
        -> log({ serveLatency })

    [alternative: S3 presigned URL redirect]
        -> serve Lambda returns 302 redirect to S3 presigned URL
        -> Kindle follows redirect (BusyBox wget handles 302)
        -> Kindle downloads directly from S3
```

Alternative direct S3 serve: Configure S3 bucket as static website host (HTTP endpoint, not
HTTPS). Kindle fetches directly from `http://bucket-name.s3-website-eu-west-1.amazonaws.com/screen.png`.
This is the only option that provides plain HTTP without any proxy. S3 static website endpoints
use plain HTTP by design.

### OAuth2 Credential Management for Multiple Google Accounts

```
Secrets Manager structure:
  /kindle-calendar/oauth/account-1    -> JSON: { client_id, client_secret, refresh_token }
  /kindle-calendar/oauth/account-2    -> JSON: { client_id, client_secret, refresh_token }
  /kindle-calendar/oauth/account-3    -> JSON: { client_id, client_secret, refresh_token }
  /kindle-calendar/service-account    -> JSON: { GCP service account key file contents }
```

The render Lambda fetches all credential secrets at cold start and caches them in the Lambda
execution environment for subsequent warm invocations. Rotation: if a refresh token is revoked,
a new one must be manually added to Secrets Manager via the one-time OAuth CLI flow.

Config file references:
```yaml
calendars:
  - id: personal
    type: google
    credentialRef: /kindle-calendar/oauth/account-1
    calendarId: primary
  - id: work
    type: google
    credentialRef: /kindle-calendar/oauth/account-2
    calendarId: work@example.com
```

Note: The `googleapis` npm library handles token refresh automatically using the stored
refresh token. AWS Secrets Manager does not have native Google OAuth token rotation built in;
refresh is handled at the application layer by the googleapis client.

### Pros

- S3 static website endpoint provides native plain HTTP - this directly solves the Kindle TLS
  problem without any proxy, making S3 the cleanest solution for Kindle delivery
- Mature Lambda ecosystem with battle-tested Chromium layers maintained by the community
  (`chrome-aws-lambda`, `@sparticuz/chromium`)
- Lambda free tier is generous: 1 million requests/month and 400,000 GB-seconds compute
- EventBridge Scheduler is very reliable with built-in retry and exactly-once delivery semantics
- Strong IAM model with fine-grained permissions per Lambda function
- AWS has eu-west-1 (Ireland) and eu-south-2 (Spain) regions close to Valencia

### Cons

- Cross-cloud complexity: AWS hosting Google Calendar API calls; no native Google auth integration;
  service account key must be stored as a plain JSON secret in Secrets Manager
- More configuration surface: IAM roles, Lambda execution roles, API Gateway routes, EventBridge
  rules, S3 bucket policies - each requires explicit setup
- Secrets Manager cost: $0.40/secret/month; with 3 OAuth credentials + 1 service account = $1.60/month
  minimum (unlike GCP Secret Manager which has a generous free tier)
- Chromium Lambda Layer adds deployment complexity: layer versioning, architecture compatibility
  (arm64 vs x86_64), and the layer may lag behind Puppeteer versions
- AWS CDK or Terraform is recommended to manage infrastructure as code, adding a learning curve
  if the developer is not familiar with AWS IaC tools
- EventBridge Scheduler minimum granularity is 1 minute; Cloud Scheduler is similar

### Estimated Monthly Cost (100 renders/day, personal use)

| Component | Usage | Estimated Cost |
|-----------|-------|----------------|
| Lambda invocations | ~3,000 render + ~3,000 serve/month | Free (1M free/month) |
| Lambda compute (render) | ~3,000 x 10s x 1GB = 30,000 GB-sec | Free (400K GB-sec free/month) |
| Lambda compute (serve) | ~3,000 x 0.5s x 128MB = 190 GB-sec | Free |
| EventBridge Scheduler | ~3,000 invocations/month | Free (first 14M/month free) |
| API Gateway | ~3,000 requests/month | Free (first 1M/month free, HTTP API) |
| S3 storage | <5MB | $0 (within 5GB free tier first 12 months; $0.023/GB after) |
| S3 requests | ~6,000 GET + ~3,000 PUT/month | ~$0.01 |
| Secrets Manager | 4 secrets | $1.60/month |
| CloudWatch Logs | <1GB/month | $0 (first 5GB/month free) |
| **Total** | | **~$1.61-2.00/month** |

Note: Secrets Manager cost is the dominant ongoing cost. This can be reduced by consolidating
secrets or using SSM Parameter Store (free for standard parameters).

### Complexity Rating: 4/5

AWS Lambda requires more configuration than Firebase: IAM policies, Lambda execution roles,
API Gateway setup, EventBridge rules, S3 bucket policies, Secrets Manager, and the Chromium
Lambda Layer. The infrastructure-as-code tooling (CDK/Serverless Framework) adds setup overhead.
Ongoing maintenance is similar to Alt A once running.

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Chromium Lambda Layer version incompatibility with Puppeteer | Medium | High | Pin to a tested layer version; use `@sparticuz/chromium` which tracks Puppeteer releases |
| Kindle cannot reach S3 static website endpoint (old HTTP) | Low | Medium | S3 website endpoints use HTTP by default; test early |
| Secrets Manager cost escalation if secrets multiplied | Low | Low | Consolidate to fewer secrets; use SSM Parameter Store as free alternative |
| Lambda cold start for render function (with Chromium) | Medium | Low | Affects only scheduled renders, not Kindle; use provisioned concurrency if needed |
| OAuth refresh token expiry on AWS | Low | High | Same mitigation as Alt A; alert on 401; re-run OAuth CLI |
| IAM misconfiguration causes silent failures | Medium | Medium | Use least-privilege IAM; test with IAM policy simulator |
| Chromium arm64 vs x86_64 architecture mismatch | Low | High | Explicitly match Lambda architecture to layer architecture in IaC |

---

## Alternative C: Lightweight Self-hosted Docker (Cloud Run / Fly.io / VPS)

### Overview

Run an always-on containerized Express/Fastify server with Puppeteer, a node-cron scheduler,
and an in-memory (or Redis) image cache. Deploy to Cloud Run (min-instances=1, always warm),
Fly.io, or a dedicated VPS. The container handles both rendering on schedule and serving to
the Kindle. Because it is a long-running process, Puppeteer can maintain a warm browser
instance, eliminating cold start entirely.

### Architecture Diagram

```
  +----------------------------------------+
  | Docker Container                       |
  | (Cloud Run / Fly.io / VPS)             |
  |                                        |
  | +------------------------------------+ |
  | | Express/Fastify HTTP Server        | |
  | |                                    | |
  | | GET /screen.png  -> ServeHandler   | |
  | | GET /health      -> HealthHandler  | |
  | | GET /preview     -> PreviewHandler | |
  | | POST /render     -> RenderHandler  | |
  | +------------------------------------+ |
  |                                        |
  | +------------------------------------+ |
  | | node-cron Scheduler                | |     +------------------------+
  | | "*/15 * * * *"                     | |     | In-Memory Cache        |
  | |  -> RenderOrchestrator.run()       | |     | (Map<string, Buffer>)  |
  | +------------------------------------+ |     | - screen.png: Buffer   |
  |                                        |     | - screen.jpg: Buffer   |
  | +------------------------------------+ |     | TTL: 5 minutes         |
  | | PuppeteerBrowserPool               | |     +------------------------+
  | | - Persistent browser instance      | |
  | | - Warm page pool                   | |     +------------------------+
  | +------------------------------------+ |     | Filesystem Cache       |
  |                                        |     | /tmp/screens/          |
  | +------------------------------------+ |     | - screen.png (fallback)|
  | | RenderOrchestrator                 | |     +------------------------+
  | | - CalendarProvider(s)              | |
  | | - WeatherProvider                  | |
  | | - TemplateEngine                   | |
  | | - SharpProcessor                   | |
  | +------------------------------------+ |
  |                                        |
  +--------+-------------------------------+
           |
           | HTTPS outbound
           v
  +---------------------------+     +---------------------------+
  | Google Calendar API v3    |     | OpenMeteo API             |
  +---------------------------+     +---------------------------+

           ^
           | HTTP (plain)
  +------------------+
  | Kindle PW3       |
  | BusyBox wget     |
  +------------------+
```

For Cloud Run deployment (min-instances=1): Cloud Run provides HTTPS URL. Kindle uses
`wget --no-check-certificate`. For VPS deployment: nginx listens on port 80 (HTTP) and
proxies to the container on port 3000. This is the only alternative that can trivially
serve plain HTTP without any workaround.

For secret management:
- Cloud Run: environment variables from Secret Manager via Cloud Run secret injection
- Fly.io: Fly secrets (encrypted env vars)
- VPS: `.env` file or environment variables (less secure but simpler for personal use)

### Architecture Diagram (VPS variant, plain HTTP)

```
  +--------------------+     HTTP :80      +----------------------+
  | Kindle PW3         | ----------------> | VPS (nginx)          |
  | BusyBox wget       |                   | port 80              |
  +--------------------+                   | proxy_pass :3000     |
                                           +----------+-----------+
                                                      |
                                                      | HTTP :3000
                                                      v
                                           +----------------------+
                                           | Docker Container     |
                                           | Express :3000        |
                                           | (same as above)      |
                                           +----------------------+
```

### Component List

| Component | Technology | Purpose |
|-----------|-----------|---------|
| HTTP server | Express or Fastify (Node.js 22) | Handles all HTTP endpoints |
| node-cron | node-cron npm | In-process 15-minute render scheduler |
| PuppeteerBrowserPool | puppeteer | Persistent warm browser; eliminates cold start |
| In-memory cache | Map + TTL logic | Stores rendered PNG/JPEG buffers |
| Filesystem cache | /tmp/screens/ | Fallback persistence across server restarts |
| CalendarProvider | TypeScript module | Multi-account Google Calendar fetching |
| WeatherProvider | TypeScript module | OpenMeteo fetch for Valencia |
| TemplateEngine | Handlebars/Nunjucks | HTML template rendering |
| SharpProcessor | sharp | Grayscale conversion, PNG/JPEG encoding |
| Docker image | Node.js 22 slim + Chromium | Container image for deployment |
| nginx (VPS only) | nginx | Reverse proxy, port 80 HTTP entry point |
| Cloud Run / Fly.io | Platform | Managed container hosting |

### Data Flow

#### Render Pipeline (triggered by node-cron every 15 min, internal)

```
node-cron fires: "*/15 * * * *"
    -> RenderOrchestrator.run()
        -> [parallel]
            -> CalendarProvider.fetchAll()  [OAuth tokens from env/secrets]
            -> WeatherProvider.fetch()
        -> DataContext = { date, time, events, weather, location }
        -> TemplateEngine.render("default", DataContext)
        -> PuppeteerBrowserPool.render(html)
            -> browser is ALREADY running (no launch overhead)
            -> page.setContent(html)
            -> page.screenshot() -> RGB PNG buffer
            -> page.close() (return to pool)
        -> SharpProcessor.toGrayscale(pngBuffer)
        -> inMemoryCache.set("screen.png", grayscalePNG, TTL=5min)
        -> fs.writeFile("/tmp/screens/screen.png", grayscalePNG)  [disk fallback]
        -> log({ renderDuration, imageSizeBytes })
```

#### Serve Pipeline (triggered by Kindle GET every 15 min)

```
Kindle wget GET /screen.png
    -> nginx port 80 proxy_pass -> Express :3000
    -> ServeHandler
        -> inMemoryCache.get("screen.png")
        -> if hit: Response 200 with cached bytes (sub-millisecond)
        -> if miss (first request, or server restart):
            -> fs.readFile("/tmp/screens/screen.png") [disk fallback]
            -> if disk miss: trigger immediate render (await RenderOrchestrator.run())
            -> Response 200 with image bytes
```

### OAuth2 Credential Management for Multiple Google Accounts

Environment variables (injected securely at deploy time):

```
OAUTH_ACCOUNT_1_CLIENT_ID=xxx.apps.googleusercontent.com
OAUTH_ACCOUNT_1_CLIENT_SECRET=GOCSPX-...
OAUTH_ACCOUNT_1_REFRESH_TOKEN=1//0...
OAUTH_ACCOUNT_2_CLIENT_ID=xxx.apps.googleusercontent.com
OAUTH_ACCOUNT_2_CLIENT_SECRET=GOCSPX-...
OAUTH_ACCOUNT_2_REFRESH_TOKEN=1//0...
SERVICE_ACCOUNT_KEY_JSON={"type":"service_account",...}
```

For Cloud Run: inject via Cloud Run secret environment variables (backed by Secret Manager).
For Fly.io: `fly secrets set OAUTH_ACCOUNT_1_REFRESH_TOKEN=...` (encrypted storage).
For VPS: `.env` file with restricted permissions (600), not committed to source control.

The `googleapis` client handles token refresh automatically. Access tokens are cached in-memory;
on 401 the library fetches a new access token using the refresh token from the environment.

Config file structure is identical to alternatives A and B; `credentialRef` points to the
environment variable name prefix rather than a Secret Manager path.

### Pros

- Warm browser: Puppeteer browser runs persistently in the container; no cold start for rendering;
  render time drops to 1-3 seconds instead of 5-10 seconds
- Plain HTTP trivially achievable: VPS with nginx on port 80 is the simplest solution to the
  Kindle TLS problem; no `--no-check-certificate` needed at all
- Single deployable unit: one container handles scheduling, rendering, and serving; simpler to
  reason about and debug
- Local development is identical to production: `docker-compose up` or `npm run dev` starts
  the same server locally; no cloud emulators needed
- Hot template reloading: file watcher can reload templates without restarting the process
- No cold start anywhere in the system: container is always warm (Cloud Run min-instances=1,
  or VPS always on)
- Least number of cloud services: no separate scheduler service, no object storage, no
  additional cloud primitives to configure
- Cheapest option if using a VPS: $3-6/month flat; predictable billing

### Cons

- Does not scale to zero: always-on container costs money even when idle (though minimal)
- In-memory cache lost on restart: if the container crashes and restarts, the first Kindle
  request after restart may trigger a slow on-demand render; disk fallback mitigates this
- VPS requires manual server management: OS updates, security patches, docker updates, nginx config
- Cloud Run min-instances=1 adds a small persistent compute cost (~$5-10/month vs. near-zero
  for serverless); if min-instances=0, cold start problem returns
- Less "cloudy": no native integration with Cloud Scheduler, Secret Manager, Cloud Logging;
  must configure equivalent tools manually
- OAuth credential storage is less secure on VPS (env file on disk) unless Cloud Run secrets
  or Fly.io secrets are used
- Puppeteer browser process is a memory risk: if it leaks or crashes, the render pipeline
  stops until the container is restarted; needs a browser health check and restart logic

### Estimated Monthly Cost (100 renders/day, personal use)

#### Option C1: Cloud Run (min-instances=1, always warm)

| Component | Usage | Estimated Cost |
|-----------|-------|----------------|
| Cloud Run (1 instance, 1GB RAM, 1 vCPU) | Always on | ~$7-10/month |
| GCS or in-process cache | No separate storage needed | $0 |
| Secret Manager | 2-4 secrets | ~$0 (free tier) |
| Cloud Logging | <1GB/month | $0 |
| **Total** | | **~$7-10/month** |

#### Option C2: Fly.io (shared-cpu-1x, 512MB RAM)

| Component | Usage | Estimated Cost |
|-----------|-------|----------------|
| Fly.io machine (shared-1x, 512MB) | Always on | ~$2.69-3.50/month |
| Fly.io secrets | Included | $0 |
| **Total** | | **~$3.00-4.00/month** |

#### Option C3: VPS (Hetzner CX22 / DigitalOcean Basic)

| Component | Usage | Estimated Cost |
|-----------|-------|----------------|
| VPS (2 vCPU, 2GB RAM) | Always on | ~$4-6/month |
| **Total** | | **~$4-6/month** |

Note: VPS option provides the most resources for the money and solves the HTTP problem natively.
Fly.io is a good middle ground with managed deployment.

### Complexity Rating: 2/5

Local development is the simplest of the three alternatives: run `npm run dev` and everything
works. Deployment to Fly.io is a single `fly deploy` command. VPS setup requires basic Docker
and nginx knowledge. No cloud-specific primitives (schedulers, object storage) to configure.
The tradeoff is operational responsibility for the container's health.

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Puppeteer browser crash inside container | Medium | Medium | Implement browser health check; restart browser on failure; Docker restart policy |
| Container out-of-memory (Puppeteer + Node.js) | Medium | Medium | Ensure at least 512MB RAM (1GB preferred); monitor memory usage |
| VPS security exposure (open port 80) | Medium | Low | nginx rate limiting; firewall rules; image content is non-sensitive |
| In-memory cache lost on restart | Medium | Low | Disk fallback at /tmp/screens/; first request triggers immediate render |
| Fly.io / Cloud Run cold start if min-instances=0 | High | Medium | Set min-instances=1; accept small fixed cost |
| OAuth tokens in env file on VPS | Medium | Medium | Restrict .env permissions (600, owned by app user); use Fly.io secrets or Cloud Run Secret Manager injection instead |
| Developer must manage VPS OS/security | Certain | Low | Use managed platform (Fly.io, Cloud Run) to eliminate OS management concern |

---

## Summary Comparison Table

| Dimension | Alt A: Firebase/GCS | Alt B: AWS Lambda/S3 | Alt C: Self-hosted Docker |
|-----------|--------------------|--------------------|--------------------------|
| Plain HTTP for Kindle | wget --no-check-cert | S3 website = native HTTP | VPS nginx = native HTTP |
| Cold start (render) | 5-10s (mitigated by pre-render) | 5-10s (mitigated by pre-render) | None (warm browser) |
| Cold start (serve) | ~1s (Cloud Function) | ~0.5s (serve Lambda) | None (always warm) |
| Scheduler | Cloud Scheduler (external) | EventBridge (external) | node-cron (internal) |
| Secret management | Secret Manager (native) | Secrets Manager ($1.60/mo) | Fly secrets / env file |
| GCP/Google ecosystem fit | Excellent | Poor | Neutral |
| Est. monthly cost | ~$0.10-0.50 | ~$1.61-2.00 | ~$3.00-10.00 |
| Setup complexity | 3/5 | 4/5 | 2/5 |
| Operational complexity | 2/5 | 3/5 | 2/5 (managed) / 3/5 (VPS) |
| Local dev experience | Firebase emulators | SAM/CDK local | npm run dev (identical) |
| Render performance | Good (pre-rendered) | Good (pre-rendered) | Best (warm browser) |

---

*Document generated: 2026-03-11 | Session: dev-arch-20260311-172353-6805ef5b*
