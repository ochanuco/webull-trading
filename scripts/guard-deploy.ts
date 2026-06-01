const allow = process.env.ALLOW_UNQUALIFIED_DEPLOY

if (allow === '1' || allow === 'true') {
  console.warn('ALLOW_UNQUALIFIED_DEPLOY is set; continuing with top-level wrangler deploy.')
  process.exit(0)
}

console.error(
  [
    'Refusing unqualified deploy.',
    'Use pnpm deploy:dev, pnpm deploy:staging, or pnpm deploy:production.',
    'For a deliberate top-level deploy, rerun with ALLOW_UNQUALIFIED_DEPLOY=1.',
  ].join('\n'),
)
process.exit(1)
