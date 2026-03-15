FROM public.ecr.aws/lambda/nodejs:20 AS builder

WORKDIR /build

# Copy package files and install dependencies
COPY functions/package.json functions/package-lock.json ./
RUN npm ci --production=false

# Copy source and compile
COPY functions/tsconfig.json ./
COPY functions/src ./src
RUN npx tsc

# ── Production image ──
FROM public.ecr.aws/lambda/nodejs:20

WORKDIR ${LAMBDA_TASK_ROOT}

# Copy compiled JS
COPY --from=builder /build/lib ./lib

# Copy package files and install production deps only
COPY functions/package.json functions/package-lock.json ./
RUN npm ci --omit=dev

# Copy runtime assets
COPY functions/config.yaml ./config.yaml
COPY functions/templates ./templates

# Lambda handler: lib/lambda.handler
CMD ["lib/lambda.handler"]
