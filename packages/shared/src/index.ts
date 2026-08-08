export * from './logger.js'
export * from './errors.js'
export * from './trace.js'

// otel.ts is intentionally NOT re-exported here — it is exposed via the
// `./otel` subpath in package.json instead. otel.ts pulls
// @opentelemetry/auto-instrumentations-node, a heavy Node-only bootstrap dep;
// re-exporting it from the package root would drag that into every consumer's
// bundle, including the console's Next/webpack build, where the winston
// instrumentation's peer dep (@opentelemetry/winston-transport) can't resolve.
// Backend services (gateway) import the bootstrap explicitly via
// `@dagents/shared/otel`; the console only needs createLogger/getTracer.
