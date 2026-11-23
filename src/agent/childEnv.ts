/** Common per-bot environment before backend-specific authentication overrides. */
export function buildAgentEnv(
  botGitIdentity?: { name: string; email: string },
  gitlabToken?: string,
  larkCliConfigDir?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Point this bot's lark-cli at its private config dir.
  if (larkCliConfigDir !== undefined) {
    env["LARKSUITE_CLI_CONFIG_DIR"] = larkCliConfigDir;
  }

  if (botGitIdentity) {
    env["GIT_AUTHOR_NAME"] = botGitIdentity.name;
    env["GIT_AUTHOR_EMAIL"] = botGitIdentity.email;
    env["GIT_COMMITTER_NAME"] = botGitIdentity.name;
    env["GIT_COMMITTER_EMAIL"] = botGitIdentity.email;
  }

  if (gitlabToken !== undefined) {
    env["GITLAB_TOKEN"] = gitlabToken;
  }

  return env;
}
