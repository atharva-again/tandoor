# Tandoor

Tandoor is a Telegram-first, general-purpose agent built on Pi Durable. This is
a fresh application; it does not run inside the Pi checkout.

## Repository layout

- `packages/gateway` contains the Telegram gateway and worker orchestration.
- `packages/worker` contains the Pi Durable runtime and worker tools.
- `packages/shared` contains code used by both processes.
- `packages/protocol` contains the gRPC service definition.

The root package manages shared TypeScript tooling and scripts for the gateway
and worker.

## Architecture

- One Tandoor gateway owns the Telegram bot token, authorization, Telegram UI,
  and routing.
- Agent workers run Pi Durable inside rootless Podman containers.
- Each worker belongs to one allowlisted Telegram user and handles that user's
  private chat with Tandoor.
- The gateway talks to workers using gRPC over host loopback ports. Workers are
  not exposed to the LAN. Each worker has a separate authentication token.
- Durable SQLite data, workspace files, and OAuth credentials live in
  persistent, user-specific directories. Containers do not mount the host home
  directory, and each worker can access only its own data.
- Google account credentials use a separate per-user gog home.
- Only private messages from allowlisted users are handled.
- `pi-ai` supplies model access and OAuth for both OpenAI and OpenAI Codex.
  Tandoor supports OAuth only, not API keys.

## Current implementation

Tandoor currently routes Telegram text, photos, and documents through the
gateway. Photos are included in the model input; uploaded files are persisted
inside the user's workspace and their paths are given to the
agent. The `codex_generate_image` tool uses the worker's OpenAI Codex OAuth
login to generate or edit images with GPT Image 2.5. It can use images attached
to the latest Telegram message or reference images in the workspace, saves
results into `generated-images/`, and returns a `MEDIA:<path>` marker for
Telegram delivery. This uses the Codex image-generation backend endpoint rather
than a documented public image API, so OpenAI could change it without notice.
To send other workspace files back to Telegram, the agent can also include
`MEDIA:<path>` in its final reply. Tandoor removes the marker and uploads the
file; only regular files inside that worker's workspace are allowed.
`/new`, `/compact`, and `/abort` operate on the private conversation;
`/session` shows conversation message counts, token usage, recorded cost,
current context estimate, and runtime settings. `/help` and `/start` are also
available. While the agent is working, its Telegram preview has a **Stop**
button that aborts the current conversation run. Agent text streams into that
editable preview, then renders its final response with Telegram rich Markdown.
`/session` also uses rich Markdown formatting. `/model` opens a three step provider, model, and thinking
level picker. Providers and models appear after signing in with `/login_provider`.
`/model provider/model-id` remains available for direct selection and then
opens the thinking level picker. `/thinking` opens the levels supported by the
current model. `/login_provider` opens a button based OAuth login picker for OpenAI,
OpenAI Codex, or xAI (Grok/X). `/logout_provider` removes a provider's saved OAuth
credentials from that worker. It does not revoke the token with the provider.
OpenAI and OpenAI Codex use a browser flow. If sign in redirects to a
localhost page or an error, paste the full URL into the private bot chat.
Tandoor deletes that reply after forwarding it. xAI uses a verification page
and one time code.
`/scoped_models` lets a conversation choose from and edit its own saved subset
of models. Each user's private conversation has independent settings.

The worker image includes the `gog` CLI, which the agent can run directly from
its shell for Google Workspace tasks. Tandoor also invokes Gog through the
authenticated integration bridge for sign-in and account management. Other
integrations use that same bridge.

When `TANDOOR_CONTEXT_DEV_API_KEY` is configured, the agent has Durable
`web_search` and `web_fetch` tools for searching and reading public pages through
Context.dev. The API key stays in the gateway; workers call it over the
authenticated integration channel and receive no provider credential. All
configured Tandoor scopes share the service key and its quota. Search queries
and requested page URLs/content are sent to Context.dev. These tools do not use
website login cookies or credentials.

The agent can create one-time reminders and recurring work with `schedule_work`,
inspect it with `list_scheduled_work`, and cancel, pause, or resume it with the
corresponding scheduling tools. `/scheduled` lists work in the current chat;
`/scheduled cancel <ID>` cancels one. Schedules support elapsed intervals,
daily local times, and five-field cron expressions. For clock-time schedules,
the agent asks for a city only when needed and saves the resulting IANA time
zone for later use. Recurring schedules can also have a duration, after which
they stop automatically.

Schedules live in one durable service owned by the gateway, in
`gateway/schedules.sqlite`, separate from individual workers. The gateway
keeps an active and paused schedule book per user; finished execution tasks
are not scanned when listing or managing schedules. Existing schedules are
indexed on the first startup after upgrading, without changing their IDs.
Client adapters
use that same service to create and manage schedules; it resumes them after
gateway restarts and asks the user's worker to perform each run. Schedules are
created and delivered in that user's private chat. If the worker is busy when
a reminder is due, the work queues
behind the active run. If a worker was offline, overdue work runs when it
returns. Missed recurring intervals are coalesced rather than burst-replayed.
Scheduled results can include text, files, and images, just like ordinary
replies. Results and file contents are saved before delivery; each successfully
sent text chunk or file has its own durable receipt. Temporary Telegram delivery failures
are retried with capped exponential backoff, honoring Telegram's retry delay.
A definitive rejection of one part does not block the remaining parts.
If Telegram reports that a private chat or topic
is unreachable, Tandoor cancels the reminders for that destination instead of running work
whose results cannot be delivered. A lost response or a crash between Telegram
accepting a part and saving its receipt can still duplicate that part; delivery is not
exactly-once. Cancelling withdraws a
not-yet-started scheduled input and stops future runs; work already underway or
a Telegram delivery already in flight may still complete.

Removing a user from `TANDOOR_ALLOWED_USER_IDS` and restarting the gateway
permanently cancels their future and paused schedules. A scheduled run already
underway is allowed to finish, but its result is not delivered or retried.
Restoring access does not restore cancelled schedules.

The gateway records ordinary messages before acknowledging their Telegram updates.
It hands them off in order within each conversation and retries if that worker is
unavailable; other conversations can still hand off and run messages. The worker
inbox remains the only execution queue. A restart retries an unconfirmed handoff
with the same message ID, or reconnects to work already accepted. The final reply
waits for the worker to save its text and attachments. The progress display is
optional: losing it does not stop the run or block the final reply. The Stop
button explicitly withdraws the selected queued input or stops its active run.

`/login_google` connects Google accounts through Gog's server friendly browser
flow and saves the account to that user's worker. One worker can have multiple
Google accounts; run `/login_google` again to add another. The bot sends the
authorization URL in the private chat and deletes the full callback URL after
exchanging it.

To enable Google sign in, create a **Web application** OAuth client in your
Google Cloud project and register this exact authorized redirect URI:
`https://auth.atharvaverma.com/oauth/google/callback`. Set
`TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE` to the downloaded client JSON path and
`TANDOOR_GOOGLE_OAUTH_REDIRECT_URI` to `https://auth.atharvaverma.com/oauth/google/callback`
in `.env`. Keep the source JSON
outside the repository with owner-only permissions. The gateway imports it into
a versioned Podman secret and mounts that secret read-only into workers. New
Google sign-ins use Gog's named `tandoor-web` client. If
`TANDOOR_GOOGLE_OAUTH_CLIENT_FILE` already points to your Desktop client, keep
it: Tandoor leaves its default Gog client and existing tokens alone. Gog
associates newly connected accounts with the Web client, so
existing Desktop-client accounts continue using their original client. Sign in
requests Gog's `all-user` services, including Gmail, Calendar, Drive, Docs,
Sheets, Classroom, and Contacts. Google displays the requested permissions
before the user approves them.
When rotating the Web client JSON, workers are recreated to pick up its new
versioned secret; older Podman secret versions can be removed once no containers
use them.

The gateway listens for callbacks on `127.0.0.1:8787` by default
(`TANDOOR_GOOGLE_OAUTH_CALLBACK_PORT` changes the port). Configure a Cloudflare
Tunnel public hostname `auth.atharvaverma.com` to forward to
`http://127.0.0.1:8787`. The Tunnel routes only callback traffic to the gateway
and does not expose SSH. The callback is short-lived and correlated to the
pending Gog login using OAuth `state`. If the gateway or worker restarts during
sign-in, start the login again.

OAuth tokens are persisted with owner-only file permissions under
`$TANDOOR_DATA_DIR/scopes/<scope-id>/auth/credentials.json` (the scope ID is a
non-reversible hashed directory name). They are not encrypted at rest. Each
worker can access only its own user's files. The worker's shell and filesystem
tools run as the same container user that reads its credential, so the agent
can access its own OAuth file. This isolates one user's credentials from other
workers, not from that user's agent. Gog tokens use its encrypted file keyring
in the same persistent volume. The encryption password is managed by the
gateway and provided only to that user's worker.

This is an early implementation, not Pi-TG feature parity. A richer model
selector, broad media handling, richer session controls, Codex-quality
compaction, and schedule pause/resume controls still need work. Web access is
limited to public search and extraction; interactive browser access is still
deferred. MCP, Codemode, `pi-fff`, and `pi-apply-patch` are not part of the
initial runtime.

## Configuration

Set:

- `TANDOOR_TELEGRAM_BOT_TOKEN`
- `TANDOOR_ALLOWED_USER_IDS` (comma-separated Telegram IDs allowed to use the
  bot in private chats)

Optional:

- `TANDOOR_DATA_DIR` (defaults to `~/.local/share/tandoor`)
- `TANDOOR_WORKER_IMAGE` (defaults to `localhost/tandoor-worker:dev`)
- `TANDOOR_PODMAN` (defaults to `podman`)
- `TANDOOR_MODEL_PROVIDER` (`openai`, `openai-codex`, or `xai`; defaults to `openai-codex`)
- `TANDOOR_MODEL_ID` (defaults to `gpt-6-luna` for OpenAI and OpenAI Codex, or `grok-4.3` for xAI; new OpenAI/OpenAI Codex conversations default to xhigh thinking)
- `TANDOOR_GOOGLE_OAUTH_CLIENT_FILE` (optional existing/default Gog OAuth client path; keep it if existing accounts use the Desktop client)
- `TANDOOR_GOOGLE_OAUTH_WEB_CLIENT_FILE` (Web application OAuth client JSON path; required for callback-based `/login_google`)
- `TANDOOR_GOOGLE_OAUTH_REDIRECT_URI` (Google callback URI; defaults to the `auth.tandoor.atharvaverma.com` callback above)
- `TANDOOR_GOOGLE_OAUTH_CALLBACK_PORT` (gateway's loopback callback listener; defaults to `8787`)
- `TANDOOR_CONTEXT_DEV_API_KEY` (optional; enables `web_search` and `web_fetch` with one gateway-owned key shared across scopes)

Build the worker image with
`podman build -t localhost/tandoor-worker:dev -f Containerfile .` and start
the gateway with `pnpm run dev`. Then send `/login_provider` to Tandoor to connect an
account. Each allowlisted user can choose their own provider account and model.

Rebuild the worker image after changes to worker code or the gRPC protocol.
The gateway rejects incompatible worker protocols with a rebuild instruction.
`pnpm run protocol:generate` derives TypeScript types from `worker.proto`; the
typecheck and worker image build both run it automatically.

The bot only responds to allowlisted users in private chats. Group chats are
not supported.
