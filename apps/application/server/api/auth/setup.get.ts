import { isAuthEnabled, needsInitialSetup, setupTokenRequired } from '../../utils/auth';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Initial setup status',
    description:
      'Reports whether the first-admin setup form should be shown — true only when auth is enabled and the users table is empty — and whether it asks for the setup token (`PIWI_SETUP_TOKEN` is set).',
    security: [],
  },
});

export default eventHandler(async (event) => {
  const needsSetup = isAuthEnabled(event) && (await needsInitialSetup());
  return { needsSetup, setupTokenRequired: needsSetup && setupTokenRequired() };
});
