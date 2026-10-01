// Unit tests that import Den modules need Den's required settings, never a real database.
// Imported first so it runs before those modules read their environment.
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:1/headless_unit_test"
process.env.DEN_DB_ENCRYPTION_KEY ??= "headless-unit-test-encryption-key-000000"
process.env.BETTER_AUTH_SECRET ??= "headless-unit-test-auth-secret-0000000000"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"
