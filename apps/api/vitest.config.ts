import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    // Request logs would bury the assertions. Set LOG_LEVEL=info when debugging a suite.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'fatal' },
    // These suites talk to one real Postgres. Running files in parallel would have
    // several of them contending for the same connection pool and, worse, would make a
    // failure hard to attribute. Isolation tests are the ones you least want to be flaky.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.ts'],

    /**
     * Force one copy of `graphql` into the module graph.
     *
     * Vitest externalises some dependencies (loaded through Node, resolving `graphql` to
     * its CJS `index.js`) while transforming others (resolving to the ESM `index.mjs`).
     * Two copies means two sets of class identities, and graphql-js validates types with
     * `instanceof` — so every operation fails with "Cannot use GraphQLNonNull from another
     * module or realm".
     *
     * This is a test-runner artefact only: under plain Node the package's export map
     * yields a single copy, which is why the server itself is unaffected.
     */
    server: { deps: { inline: [/graphql/, /@envelop/] } },
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './test-results/junit.xml' },
  },
});
