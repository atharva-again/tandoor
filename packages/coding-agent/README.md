# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Pi packages](docs/packages.md) and share via npm or git.

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way.

Use Pi [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Pi TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

This fork does not publish npm packages or binaries. The repository [README](../../README.md) describes fork-specific features; see the local [AGENTS.md](../../AGENTS.md) for development rules and the [coding-agent documentation](docs/index.md) for usage and API details.

## Development

Run commands from the repository root. Install dependencies and start the fork using the instructions in the root [README](../../README.md).

Before validating changes, run:

```bash
npm run check
./test.sh
```

Read the repository's local [AGENTS.md](../../AGENTS.md) for implementation, testing, and dependency rules. This checkout is `atharva-again/pi`; it is not the upstream repository.

## License

MIT
