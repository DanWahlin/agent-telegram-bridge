# Security Policy

## Supported versions

Security fixes are applied to the latest commit on `main`. This project does not currently publish versioned packages or maintain older release branches.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow on the repository Security tab.

Do not open a public issue for a suspected vulnerability. Do not include real Telegram tokens, private prompts, runtime state, credentials, or other secrets in reports or reproductions. Use unmistakably fake values.

Include:

- A concise description and expected impact
- Affected commit or configuration
- Reproduction steps or a minimal proof of concept
- Relevant logs with secrets and private content removed
- Any suggested mitigation

Reports will be acknowledged and evaluated privately. Confirmed issues will be fixed and disclosed through GitHub's security-advisory process when appropriate.

## Security boundary

The bridge restricts Telegram access to one paired numeric owner in a private chat, minimizes the agent child environment, serializes ACP work, and protects local state with owner-only permissions. These controls are not an operating-system sandbox.

The agent subprocess (Grok Build or GitHub Copilot CLI) can act with the permissions of its operating-system user and may read files available to that identity. Keep the bridge configuration and secrets outside `AGENT_CWD`. Leave `AGENT_ALWAYS_APPROVE` disabled unless the agent, account, and workspace are fully trusted. Run one bridge instance per provider with its own bot token and state directory.
