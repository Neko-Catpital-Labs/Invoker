function shouldWrapInDevelopmentProfile(argv2, env) {
  if (argv2 === '--install-only') return false;
  if (env.INVOKER_DEVELOPMENT_PROFILE_ACTIVE === '1') return false;
  if (env.INVOKER_PRODUCTION_OWNER_SERVICE === '1') return false;
  return true;
}

module.exports = { shouldWrapInDevelopmentProfile };
