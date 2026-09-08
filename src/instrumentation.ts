export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { readTrialConfig, assertTrialLaunch } = await import('./server/reading/config.ts');
    assertTrialLaunch(readTrialConfig(process.env), process.argv);
  }
}
