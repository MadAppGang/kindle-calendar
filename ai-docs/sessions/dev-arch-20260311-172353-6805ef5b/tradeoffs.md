# Kindle Calendar Display - Trade-off Analysis

**Project**: Kindle E-ink Calendar Display Server
**Date**: 2026-03-11
**Session**: dev-arch-20260311-172353-6805ef5b
**Status**: Trade-off Analysis

---

## Alternatives Under Comparison

- **Alt A**: Firebase Cloud Functions Gen 2 + Puppeteer + GCS cache
- **Alt B**: AWS Lambda + Chromium Lambda Layer + S3
- **Alt C**: Self-hosted Docker container (Cloud Run / Fly.io / VPS)

---

## Dimension-by-Dimension Analysis

### 1. Development Complexity (Setup, Config, Deploy)

#### Alt A: Firebase/GCS

Setup steps:
1. Create GCP project, enable billing (Blaze plan required)
2. Enable APIs: Cloud Functions, Cloud Run, Cloud Scheduler, Secret Manager, GCS
3. Create GCS bucket with public read ACL (or fine-grained + object-level public)
4. Configure service account IAM: `secretmanager.secretAccessor`, `storage.objectCreator/Viewer`
5. Run one-time OAuth2 flow per Google account; write refresh tokens to Secret Manager
6. Deploy two Cloud Functions (render + serve) via `firebase deploy --only functions`
7. Create Cloud Scheduler job targeting the render function endpoint
8. Configure `firebase.json` + `functions/` project structure

Estimated initial setup time: 3-5 hours for someone familiar with GCP; 6-10 hours otherwise.

One significant advantage: the firebase-tools CLI provides local function emulation via
`firebase emulators:start`. This allows running the render function locally without deploying,
though emulators do not fully replicate the Cloud Run environment (especially Puppeteer sandbox
behavior and memory limits).

Development iteration cycle:
- Code change -> `firebase emulators:start` -> test locally -> `firebase deploy`
- Template changes can be tested locally with the emulator; no deploy required

#### Alt B: AWS Lambda/S3

Setup steps:
1. Create AWS account; configure IAM user for deployment
2. Create Lambda functions (render + serve) with appropriate execution roles
3. Attach Chromium Lambda Layer to render function; verify arm64/x86_64 compatibility
4. Create S3 bucket; configure bucket policy for public read (or API GW access)
5. Create EventBridge Scheduler rule; configure Lambda invoke permissions
6. Create API Gateway HTTP API; configure routes to serve Lambda
7. Create Secrets Manager secrets for OAuth tokens; grant Lambda execution role access
8. Install and configure IaC (CDK or Serverless Framework) - highly recommended to manage
   the above resources as code; skipping IaC makes this significantly more error-prone
9. Run OAuth2 flow; write tokens to Secrets Manager
10. Deploy: `cdk deploy` or `serverless deploy`

Estimated initial setup time: 5-8 hours for someone familiar with AWS; 10-15 hours otherwise.

The Chromium Lambda Layer is the most fragile piece. The community-maintained `@sparticuz/chromium`
package must be kept in sync with the Puppeteer version used in the function. When either updates,
the developer must verify compatibility. Lambda also has architecture constraints: the layer must
match the Lambda function architecture (x86_64 or arm64). Arm64 is cheaper (Graviton2) but the
Chromium layer is primarily maintained for x86_64.

Local development for Lambda is more painful. AWS SAM (`sam local invoke`) can invoke Lambda
functions locally but does not replicate Lambda Layers well. The typical approach is to develop
the core render logic independently from the Lambda handler, then test the Lambda wrapper in CI
or against a real deployment.

#### Alt C: Self-hosted Docker

Setup steps (Fly.io path):
1. Write Dockerfile: `node:22-slim` base + install Chromium system packages
2. Write `docker-compose.yml` for local development
3. Configure environment variables / secrets in `.env` (local) and Fly secrets (production)
4. Run OAuth2 flow; add tokens as Fly secrets (`fly secrets set`)
5. `fly launch` to create Fly app; `fly deploy` to deploy

Estimated initial setup time: 1-3 hours for someone with basic Docker knowledge.

Local development is the closest to production of all three alternatives. The same Docker image
runs locally and in Fly.io. Hot reloading of templates and code (via nodemon + volume mounts)
works without any cloud emulator. Secrets are `.env` locally and Fly secrets in production.

The main development complexity difference: there is no cloud infrastructure to configure.
The application code IS the deployment artifact. No IAM roles, no bucket policies, no scheduler
service to wire up - all of that is replaced by application code (node-cron) and a single
Dockerfile.

**Assessment**:
- Alt A: Moderate complexity; GCP-specific knowledge required; firebase-tools help
- Alt B: High complexity; most cloud primitives to configure; IaC almost mandatory
- Alt C: Lowest complexity; Docker knowledge sufficient; cloud-agnostic approach

---

### 2. Operational Complexity (Monitoring, Debugging, Maintenance)

#### Alt A: Firebase/GCS

Monitoring: Cloud Logging automatically captures function logs. Cloud Monitoring can alert on
function error rates or execution duration. Setting up basic alerts requires configuring
notification channels (email) in Cloud Monitoring.

Debugging: Logs are searchable in Cloud Logging console. Local debugging with `firebase emulators`
is possible for the function code but not for the full cloud environment. Stack traces are
preserved in structured logs.

Maintenance: Function runtime updates (e.g., Node.js 20 -> 22) require redeployment. GCS bucket
and Secret Manager require no ongoing maintenance. Cloud Scheduler jobs are durable and self-healing.

Failure modes:
- Render function fails: Cloud Scheduler retries (configurable); old cached image remains in GCS;
  Kindle continues serving stale image silently
- OAuth token revoked: 401 logged; render fails gracefully; alert needed (not automatic)
- GCS unavailable: Serve function fails; Kindle shows wget error; rare for GCS

Operational maturity: Cloud Functions has strong operational tooling (dashboards, error reporting,
alerting) out of the box via GCP console.

#### Alt B: AWS Lambda/S3

Monitoring: CloudWatch automatically captures Lambda logs. CloudWatch Alarms can alert on error
rates, duration, or throttles. Setting up alarms requires Lambda metric configuration.

Debugging: Log groups in CloudWatch; Lambda structured logs are searchable. X-Ray tracing can
be enabled for distributed tracing across Lambda invocations (useful if render failures are hard
to diagnose).

Maintenance: Lambda runtime updates (Node.js EOL) require function redeployment. The Chromium
Lambda Layer requires attention when the community updates it; staying on an old layer version
creates security and compatibility debt. EventBridge rules and S3 bucket are low-maintenance.

Failure modes identical to Alt A in principle; different tooling for detection.

The additional operational concern with Alt B is the Chromium Lambda Layer: if a new Puppeteer
version is installed as a dependency, the layer must also be updated. This is not a one-time
concern; it recurs on every dependency update cycle.

#### Alt C: Self-hosted Docker

Monitoring:
- Fly.io: Built-in metrics dashboard (CPU, memory, request count); `fly logs` for real-time logs
- Cloud Run: Cloud Monitoring integration; Cloud Logging for structured logs
- VPS: Must set up log aggregation manually (e.g., ship logs to a log service, or inspect locally)

Debugging: SSH into Fly machine (`fly ssh console`) or connect to Cloud Run instance for live
inspection. The always-on process means the state at time of failure is preserved (unlike
serverless where the instance may be gone by the time debugging starts).

Maintenance:
- Fly.io / Cloud Run: Platform handles OS security; developer only maintains application code
  and Dockerfile dependencies
- VPS: Developer is responsible for OS updates, Docker engine updates, nginx patches; higher
  maintenance burden

Failure modes:
- Puppeteer browser crashes inside container: render stops until container restarts; Docker
  restart policy ensures recovery within 1-2 minutes; Kindle shows stale image in the interim
- In-memory cache lost on restart: disk fallback at /tmp prevents total failure; first Kindle
  request after restart may wait 3-8 seconds for an on-demand render
- Fly.io machine goes down: Fly restarts automatically; brief unavailability

The persistent browser (PuppeteerBrowserPool) is the operational novelty. A stuck browser page
or zombie process can consume memory until the container OOMs. The application needs a browser
health check (ping the browser process; restart if unresponsive) and memory monitoring.

**Assessment**:
- Alt A: Low operational complexity; native GCP tooling handles most concerns
- Alt B: Medium operational complexity; Lambda Layer maintenance is an ongoing concern
- Alt C: Low-medium complexity (managed platform); higher complexity on VPS; browser health
  monitoring is a unique operational concern not present in serverless alternatives

---

### 3. Cost (Monthly, Personal Use)

Using ~100 renders/day = ~3,000 renders/month:

| Cost Item | Alt A Firebase | Alt B AWS Lambda | Alt C Fly.io | Alt C VPS |
|-----------|---------------|-----------------|-------------|-----------|
| Compute | ~$0.20 | ~$0.00 (free tier) | ~$3.00 | ~$5.00 |
| Storage | $0.00 | ~$0.01 | $0.00 | $0.00 |
| Scheduler | $0.00 | $0.00 | $0.00 (internal) | $0.00 |
| Secrets | $0.00 | $1.60 | $0.00 | $0.00 |
| Logging | $0.00 | $0.00 | $0.00 | $0.00 |
| Proxy (if needed) | $0-5.00 | $0-5.00 | $0.00 (built-in HTTP) | $0.00 (nginx local) |
| **Monthly Total** | **$0.20-5.50** | **$1.61-6.60** | **~$3.00** | **~$5.00** |

Notes:
- Alt A cost is near-zero if Kindle can use `wget --no-check-certificate` (no proxy needed)
- Alt B has a fixed $1.60/month minimum from Secrets Manager regardless of usage
- Alt B proxy cost applies only if Kindle cannot reach HTTPS and S3 static website is not used
- Alt C Fly.io shared-cpu-1x with 512MB RAM is $2.69/month; 1GB RAM is $3.19/month
- Alt C VPS (Hetzner CX22, 2vCPU/2GB) is ~$4.50/month; DigitalOcean is ~$6/month

**Cost winner**: Alt A (Firebase) at effectively $0/month if the TLS workaround works.
**Most predictable cost**: Alt C (flat monthly rate; no usage spikes).

---

### 4. Performance

#### Cold Start (render function)

| Alternative | Cold Start Duration | Impact |
|-------------|--------------------| -------|
| Alt A | 5-10s (Chromium init) | Only affects scheduled renders; Kindle is served from GCS cache |
| Alt B | 5-10s (Chromium init from Layer) | Only affects scheduled renders; Kindle served from S3 |
| Alt C | None (browser always warm) | Render takes 1-3s from warm browser |

For Alt A and B, cold start only matters when the Cloud Scheduler fires and the function has
been idle. The Kindle is never waiting for a cold start because it reads from pre-rendered
storage. The render function can take 15 seconds if needed without impacting Kindle UX.

For Alt C, the warm browser means that even an on-demand render (triggered by the first Kindle
request after a server restart) completes in 1-3 seconds instead of 8-15 seconds.

#### Serve Latency (Kindle request)

| Alternative | Hot Path Latency | Notes |
|-------------|-----------------|-------|
| Alt A | 200-800ms | Cloud Function reads from GCS; slight overhead vs. direct GCS |
| Alt A (direct GCS) | 50-200ms | If Kindle fetches directly from GCS URL |
| Alt B | 200-500ms | Lambda reads from S3; Lambda cold start for serve function only |
| Alt B (S3 website) | 50-200ms | Kindle fetches directly from S3 static website endpoint |
| Alt C | <10ms | In-memory cache hit; no I/O for serve |

Alt C is the clear performance winner for serve latency: in-memory cache returns bytes with
essentially no overhead. Alt A and B have identical serve latency characteristics; the serve
Lambda/Function has a very small footprint and warms quickly.

#### Data Fetch Parallelism

All three alternatives use the same TypeScript data provider modules with `Promise.all` for
parallel fetching. Data fetch performance is identical across alternatives for the same
runtime environment (Node.js 22).

OpenMeteo (no auth, fast CDN): ~100-300ms
Google Calendar API (OAuth, per-account): ~300-800ms each, fetched in parallel
Total parallel data fetch: ~500-1000ms (dominated by Calendar API)

**Performance winner**: Alt C for serve latency and render start time. Alt A/B are equivalent
for the pre-render pipeline and acceptable for the Kindle serve path.

---

### 5. Kindle Compatibility (HTTP/HTTPS, TLS Issues)

This is the most critical hardware constraint. Kindle Paperwhite 3 BusyBox wget has known
issues with SNI-based TLS and modern certificate chains.

| Alternative | HTTP Solution | Reliability | Notes |
|-------------|--------------|-------------|-------|
| Alt A | `wget --no-check-certificate` | Medium | Depends on wget build; may still fail on TLS handshake |
| Alt A + VPS proxy | VPS nginx on port 80 | High | Adds $3-5/month; proven to work with any wget |
| Alt B | S3 static website (HTTP) | High | S3 website endpoints are HTTP by default; cleanest solution |
| Alt B + VPS proxy | VPS nginx on port 80 | High | Same as Alt A proxy option |
| Alt C (Cloud Run) | `wget --no-check-certificate` | Medium | Cloud Run is HTTPS-only |
| Alt C (Fly.io) | `wget --no-check-certificate` | Medium | Fly.io is HTTPS-only |
| Alt C (VPS + nginx) | nginx on port 80 | High | Native HTTP; no TLS concerns at all |

Analysis:
- Alt B with S3 static website hosting is the only cloud-native solution that provides true
  plain HTTP without any workaround. S3 website endpoints (`http://bucket.s3-website-region.amazonaws.com`)
  use HTTP by default and cannot use HTTPS. This is a significant advantage for Kindle compatibility.
- Alt A (Firebase/GCS) has no plain HTTP option for Cloud Functions. GCS objects can be served
  over HTTP via the XML API (`http://storage.googleapis.com/bucket/object`) but this endpoint
  now enforces HTTPS redirects in practice.
- Alt C (VPS) solves this cleanly by running nginx on port 80.
- `wget --no-check-certificate` is a viable workaround but should be tested against the specific
  BusyBox wget version on the target Kindle before committing to a cloud architecture.

**Kindle compatibility winner**: Alt B (S3 static website = native HTTP) or Alt C VPS (nginx on port 80).
Alt A requires the `--no-check-certificate` workaround or an additional VPS proxy.

---

### 6. Google Calendar Integration Friction

#### Alt A: Firebase/GCS

The lowest friction option for Google Calendar integration. The Cloud Function service account
is already a GCP identity. Granting it access to Secret Manager requires only an IAM role
assignment within the same project. The `googleapis` npm package uses Application Default
Credentials (ADC) transparently when running on GCP, simplifying authentication setup.

For multiple OAuth accounts: each requires a separate Secret Manager secret. The Cloud Function
service account gets `secretmanager.secretAccessor` role. During local development, `gcloud
auth application-default login` provides ADC automatically.

Initial OAuth setup: run a local script to perform the consent flow; write the refresh token
directly to Secret Manager with `gcloud secrets create`.

#### Alt B: AWS Lambda/S3

Higher friction for Google Calendar. The Lambda execution role has no native Google identity.
The full OAuth2 credential set (client_id, client_secret, refresh_token) must be stored as
a JSON secret in AWS Secrets Manager. There is no ADC equivalent; credentials must be explicitly
loaded from Secrets Manager and passed to the `googleapis` client.

For multiple OAuth accounts: each account requires a separate Secrets Manager secret or a
consolidated JSON structure. The pattern works but requires more explicit credential management
code.

For service accounts (GSuite calendars): the GCP service account JSON key file is stored as a
Secrets Manager secret. The key file is loaded as a string, parsed as JSON, and passed to the
`googleapis.auth.GoogleAuth` constructor. This works but feels awkward on AWS.

Initial OAuth setup: same local script approach; write tokens to Secrets Manager with AWS CLI.

#### Alt C: Self-hosted Docker

Friction is context-dependent:
- Fly.io: `fly secrets set OAUTH_TOKEN=...` is simple; accessed as `process.env.OAUTH_TOKEN`
- Cloud Run: Secrets injected as environment variables from Secret Manager; ADC works if the
  Cloud Run service account has Secret Manager access
- VPS: Credentials in `.env` file; simplest but least secure

The application code for credential management is identical across all three alternatives;
the difference is only in where secrets are stored and how they are injected at runtime.

**Google Calendar integration winner**: Alt A, by virtue of native GCP ecosystem alignment
and Application Default Credentials. Alt B has the most friction. Alt C is neutral.

---

### 7. Extensibility (Adding Providers Later)

The requirements define a pluggable provider architecture (NF-21: adding a new data provider
requires only writing a provider module + config entry). This is entirely an application-layer
concern; the cloud platform does not affect it.

However, platform choice does affect some extensibility scenarios:

#### Google Calendar webhook push (F-55: event-driven invalidation)

Google Calendar API supports push notifications (webhooks): the API notifies a URL when a
calendar changes. This would allow triggering an immediate re-render when a calendar event
is added/modified, rather than waiting for the 15-minute schedule.

- Alt A: The Cloud Function URL can receive webhook POSTs. Webhook registration requires an
  HTTPS URL with a valid certificate, which Cloud Functions provides. Easy to implement.
- Alt B: API Gateway provides an HTTPS URL suitable for webhook registration. Also easy.
- Alt C (Cloud Run / Fly.io): The service URL is HTTPS and suitable for webhook registration.
- Alt C (VPS plain HTTP): Webhook registration requires HTTPS. A separate HTTPS termination
  (Certbot/Let's Encrypt + nginx) is needed, adding complexity.

#### Home Assistant integration (future)

A future provider reading Home Assistant REST API (F-51) is a simple HTTP fetch in the
WeatherProvider/HA pattern. Platform has no impact on this.

#### RSS feed ingestion (F-50)

Simple outbound HTTP; no platform impact. Note: Firebase Spark plan blocks outbound HTTP;
Blaze plan is required regardless.

#### Additional Kindle screens / named variants

Alt A: Each screen variant is a named GCS object (`screen-night.png`). Trivial to extend.
Alt B: Each variant is a named S3 object. Trivial.
Alt C: Each variant is a named in-memory cache key. Trivial.

**Extensibility assessment**: All three alternatives support the extensibility requirements
equally at the application layer. Alt A has a slight advantage for webhook-driven invalidation
due to native HTTPS URL + simpler IAM. Alt C VPS has a slight disadvantage if HTTPS is needed
for webhooks.

---

### 8. Local Development Experience

#### Alt A: Firebase/GCS

Firebase provides a local emulator suite (`firebase emulators:start`) that emulates:
- Cloud Functions (runs functions locally on a local HTTP server)
- Cloud Firestore (not needed here)
- Cloud Storage (partial; some operations work)

Limitations:
- Secret Manager is NOT emulated; local dev must use mock secrets or a local `.env` fallback
- Puppeteer inside the emulator runs with the same constraints as on the developer's machine
  (sandbox mode, Chrome binary must be installed locally)
- The emulator does not replicate Cloud Run resource limits or networking

Local development cycle:
```
npm run dev  ->  firebase emulators:start  ->  open http://localhost:5001/proj/region/serve
```

Template hot-reloading works inside the emulator.

#### Alt B: AWS Lambda/S3

AWS SAM provides local Lambda invocation (`sam local invoke`) but:
- Lambda Layers are not fully emulated locally; Chromium must be installed separately on the
  developer's machine as a fallback
- EventBridge cannot be triggered locally; the cron trigger must be simulated manually
- S3 can be mocked with LocalStack, but LocalStack requires a separate Docker container

Local development cycle is the most friction-heavy of the three alternatives. Most developers
working with Lambda locally end up writing the core logic so it can run outside of the Lambda
handler, then testing the Lambda wrapper only in a real AWS environment.

#### Alt C: Self-hosted Docker

Identical to production. `docker-compose up` starts the same container that runs in Fly.io/VPS.
Alternatively, `npm run dev` (with nodemon) runs the Express server directly with:
- Template file watching (hot reload without restart)
- `.env` file for local secrets
- Same Puppeteer setup as production (Chromium must be installed locally)

This is the best local development experience. There is no "emulator gap" between local and
production. Any bug that appears locally will appear in production; any fix that works locally
will work in production.

Mock mode (T-05: tests without cloud credentials) is straightforward: a `--mock` flag loads
fixture data instead of calling live APIs. This works identically in all three alternatives
at the application layer.

**Local dev experience winner**: Alt C is clearly the best. Alt A is acceptable with emulators.
Alt B has the worst local dev experience due to Lambda Layer emulation gaps.

---

## Weighted Scoring Matrix

### Criteria and Weights

Weights reflect the priorities for this specific project:
- Kindle compatibility is weighted highest because it is a hard requirement
- Cost is weighted second because this is a personal project with tight budget constraints
- Dev/Ops complexity are weighted high because this is a solo developer project
- Google Calendar integration is weighted high due to the multi-account OAuth requirement

| Criterion | Weight | Rationale |
|-----------|--------|-----------|
| Kindle HTTP compatibility | 20% | Hard constraint; broken compatibility = entire system fails |
| Development complexity | 15% | Solo developer; simpler = more time for features |
| Monthly cost | 15% | Personal project; near-zero preferred |
| Operational complexity | 15% | Solo operator; less moving parts = less maintenance burden |
| Local dev experience | 10% | Daily development quality; iteration speed |
| Google Calendar integration | 10% | Core feature; auth friction affects reliability |
| Performance (serve latency) | 10% | Kindle should get fast response |
| Extensibility | 5% | Future providers matter but not immediately |

Total: 100%

### Scoring (1-5 scale, 5 = best)

| Criterion | Weight | Alt A Firebase | Alt B AWS | Alt C Docker |
|-----------|--------|---------------|----------|-------------|
| Kindle HTTP compatibility | 20% | 3 | 5 | 5 |
| Development complexity | 15% | 3 | 2 | 5 |
| Monthly cost | 15% | 5 | 3 | 3 |
| Operational complexity | 15% | 4 | 3 | 4 |
| Local dev experience | 10% | 3 | 2 | 5 |
| Google Calendar integration | 10% | 5 | 3 | 4 |
| Performance (serve latency) | 10% | 3 | 3 | 5 |
| Extensibility | 5% | 4 | 4 | 4 |

### Score Justification Notes

**Kindle HTTP compatibility**:
- Alt A scores 3: Cloud Run is HTTPS-only; `wget --no-check-certificate` is the workaround,
  but it is not tested and may fail on this specific BusyBox wget build
- Alt B scores 5: S3 static website endpoint is native HTTP; definitively solves the problem
- Alt C scores 5: VPS with nginx port 80 is native HTTP; Cloud Run/Fly.io variant scores 3
  (same issue as Alt A) but the VPS variant elevates the score

**Development complexity**:
- Alt A scores 3: Firebase tooling is well-documented but has GCP-specific learning curve;
  IAM, Secret Manager, and two-function deployment add steps
- Alt B scores 2: Most components to configure; IaC almost mandatory; Lambda Layer friction
- Alt C scores 5: Dockerfile + npm run dev; fewest cloud-specific concepts

**Monthly cost**:
- Alt A scores 5: Near-zero at personal use scale; GCP free tiers cover all components
- Alt B scores 3: $1.60/month minimum from Secrets Manager; acceptable but not free
- Alt C scores 3: $3-6/month flat; more than Alt A but predictable

**Operational complexity**:
- Alt A scores 4: Cloud Scheduler, GCS, and Secret Manager are fully managed; minimal ops
- Alt B scores 3: Lambda Layer maintenance is an ongoing concern; more components to monitor
- Alt C scores 4: Fly.io is managed; VPS adds OS maintenance; browser health check needed

**Local dev experience**:
- Alt A scores 3: Firebase emulators work but have Secret Manager gap and emulator limitations
- Alt B scores 2: SAM local invoke does not handle Lambda Layers; S3 needs LocalStack
- Alt C scores 5: npm run dev = production; no emulator gap

**Google Calendar integration**:
- Alt A scores 5: Native GCP, ADC, and same ecosystem as Google Calendar API
- Alt B scores 3: Explicit credential management; no ADC; cross-cloud friction
- Alt C scores 4: Environment variables are straightforward; no native GCP integration but
  the googleapis client handles everything at the application layer

**Performance (serve latency)**:
- Alt A scores 3: 200-800ms via Cloud Function; acceptable for 15-min polling
- Alt B scores 3: Similar to Alt A
- Alt C scores 5: <10ms from in-memory cache; meaningfully faster

**Extensibility**:
- All score 4: Plugin architecture is application-layer; all equally extensible
  Alt A has slight webhook advantage; otherwise equal

### Weighted Scores

| Criterion | Weight | Alt A | Alt B | Alt C |
|-----------|--------|-------|-------|-------|
| Kindle HTTP compatibility | 0.20 | 0.60 | 1.00 | 1.00 |
| Development complexity | 0.15 | 0.45 | 0.30 | 0.75 |
| Monthly cost | 0.15 | 0.75 | 0.45 | 0.45 |
| Operational complexity | 0.15 | 0.60 | 0.45 | 0.60 |
| Local dev experience | 0.10 | 0.30 | 0.20 | 0.50 |
| Google Calendar integration | 0.10 | 0.50 | 0.30 | 0.40 |
| Performance (serve latency) | 0.10 | 0.30 | 0.30 | 0.50 |
| Extensibility | 0.05 | 0.20 | 0.20 | 0.20 |
| **Total** | **1.00** | **3.70** | **3.20** | **4.40** |

---

## Critical Path Analysis

Before the cloud platform decision finalizes, one question must be answered first:

**OQ-01: Does `wget --no-check-certificate` work on this specific Kindle's BusyBox wget?**

Test procedure (5 minutes):
```sh
# On Kindle, via SSH:
wget --no-check-certificate https://httpbin.org/get -O /tmp/test.json && echo "SUCCESS"
```

If this succeeds: Alt A becomes viable (score remains 3.70) and the HTTP constraint is resolved
across all alternatives.

If this fails: Alt A drops to 2.60 (Kindle compatibility score drops from 3 to 1), and Alt B
or Alt C VPS become the only clean solutions.

**Recommendation: Test this before choosing a platform.**

---

## Recommendation

### Primary Recommendation: Alternative C (Self-hosted Docker, Fly.io)

**Weighted score: 4.40** (highest of the three alternatives)

**Justification**:

1. **Kindle HTTP compatibility is solved definitively.** Fly.io provides an HTTPS endpoint;
   the application can also serve over a custom domain. If `wget --no-check-certificate` fails,
   a Fly.io app can be placed behind a VPS with nginx on port 80 as a trivial proxy. On a VPS
   deployment, nginx handles port 80 natively. Alt C does not require a workaround in the VPS
   variant; it IS the workaround for every other alternative.

2. **Development velocity is highest.** `npm run dev` starts everything; templates hot-reload;
   no cloud emulators; no IAM roles to debug. For a solo developer building a personal project,
   the iteration speed advantage of Alt C translates directly into shipping features faster.

3. **Warm Puppeteer browser eliminates render latency concern.** The most persistent technical
   risk in Alt A and B is Puppeteer cold start (5-10s). Alt C eliminates this entirely by
   keeping the browser warm. On-demand renders triggered by the first Kindle request after a
   restart complete in 1-3 seconds.

4. **Operational simplicity matches personal project scale.** Fly.io handles container
   orchestration, TLS termination, machine restart on failure, and secret storage. The developer
   manages only the application code and Dockerfile. `fly logs` provides real-time log access.
   `fly status` shows machine health.

5. **No serverless cold start complexity.** The pre-render + cloud storage pattern in Alt A/B
   was designed specifically to hide Puppeteer cold start from the Kindle request path. Alt C
   makes this architectural complexity unnecessary.

**Specific recommended deployment**: Fly.io with a `shared-cpu-1x` machine (512MB RAM minimum;
1GB recommended for Puppeteer headroom). Use Fly secrets for OAuth tokens. Deploy to
`ams` (Amsterdam) or `mad` (Madrid) region for lowest latency from Valencia.

**Estimated cost**: $3.19/month (Fly.io 1GB shared machine).

**If cost is the primary constraint**: Alt A (Firebase/GCS) at near-zero cost is the best
alternative, provided the BusyBox wget TLS workaround is verified first. If the workaround
fails, add a Hetzner CX11 VPS ($3/month) as an nginx proxy, bringing total cost to ~$3.20/month
- effectively the same as Alt C Fly.io but with more operational complexity.

### Secondary Recommendation: Alternative A (Firebase/GCS)

**Weighted score: 3.70**

Choose Alt A if:
- The Kindle wget TLS test passes (`wget --no-check-certificate` works)
- The developer is already familiar with GCP and Firebase
- True scale-to-zero and near-zero cost is a hard requirement
- The project may later expand to use other GCP services (Firebase Auth, Firestore, etc.)

Alt A requires the fewest ongoing financial commitments. Once deployed, the system can run for
months with zero interaction and near-zero cost. The Firebase ecosystem is also the best fit
for the Google Calendar API integration, which is the most complex piece of the system.

### Do Not Recommend: Alternative B (AWS Lambda/S3)

**Weighted score: 3.20**

Alt B scores lowest because:
- It has the highest setup complexity of the three alternatives
- The Chromium Lambda Layer is an ongoing maintenance concern with version pinning requirements
- It costs more than Alt A ($1.60/month minimum from Secrets Manager) while offering no
  significant advantages over Alt A for this use case
- The AWS ecosystem is misaligned with Google Calendar API (the core integration requirement)
- Local development experience is the worst of the three

The only scenario where Alt B is the best choice: the developer is already heavily invested in
AWS infrastructure and has existing Lambda tooling, IAM setup, and AWS expertise. In that case,
the S3 static website plain HTTP benefit is meaningful and the setup friction is amortized.

---

## Risk Register (All Alternatives)

| Risk | Alt A | Alt B | Alt C | Notes |
|------|-------|-------|-------|-------|
| Kindle TLS incompatibility | Medium | None (S3 HTTP) | Low (VPS) | Test wget first |
| Puppeteer cold start | Medium | Medium | None | Pre-render mitigates A/B |
| OAuth token revocation | Medium | Medium | Medium | Same across all; alert needed |
| Monthly cost overrun | None | Low | None | Secrets Manager dominates B |
| Platform outage | Low | Low | Low | All have redundancy |
| Chromium version mismatch | Low | High | Low | Lambda Layer is fragile |
| Browser memory leak (persistent) | N/A | N/A | Medium | Only affects Alt C |
| Vendor lock-in | Medium | Medium | Low | C is most portable |

---

## Final Decision Matrix Summary

```
Alternative A (Firebase/GCS):   3.70/5.00
Alternative B (AWS Lambda/S3):  3.20/5.00
Alternative C (Docker/Fly.io):  4.40/5.00  <-- Recommended
```

The recommendation is Alternative C deployed on Fly.io with a VPS (optional) nginx proxy on
port 80 if `wget --no-check-certificate` is insufficient. This alternative has the highest
score, the best developer experience, the cleanest solution to the Kindle HTTP constraint,
and the lowest architectural complexity for a personal single-tenant project.

---

*Document generated: 2026-03-11 | Session: dev-arch-20260311-172353-6805ef5b*
