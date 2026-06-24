export default async function globalSetup(): Promise<void> {
  if (process.env.SENTINEL_LIVE_MODE === 'true') {
    process.stdout.write(
      '\n\x1b[33m⚠ LIVE MODE ENABLED - tests will interact with real backends\x1b[0m\n\n',
    );
  }
}
