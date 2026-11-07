# Rakazo on a VPS

Scripts that set up Rakazo on a fresh Debian 13 server and keep it deployed from a GitHub
branch. Every push to that branch builds, switches, health-checks, and rolls back on failure.

## What you need

| Item | Example | Notes |
|---|---|---|
| VPS IP | `203.0.113.10` | Debian 13 x64, amd64. 4 GB RAM / 2 vCPU / 80 GB works (setup adds 4 GB swap); 8 GB is comfortable. |
| Domain | `rakazo.example.com` | A record → IP. If the DNS host proxies traffic, turn that off (DNS only) or HTTPS certificates fail. |
| GitHub repo + branch | `https://github.com/OWNER/REPO`, `main` | Deploy-on-push follows this branch. |
| Admin email | the email you sign up with | Unlocks Settings → Computer, Storage and Servers. |

SSH key: create the server with your `rakazo_vps` key (private part at `~/.ssh/rakazo_vps` on the
Mac). If the server was created with a password, run `ssh-copy-id -i ~/.ssh/rakazo_vps.pub root@<IP>`.

Before starting, check:

```sh
ssh -i ~/.ssh/rakazo_vps -o BatchMode=yes root@<IP> 'grep PRETTY /etc/os-release'   # Debian 13
dig +short <domain>                                                                # the IP
```

## One command

From the repository root on the Mac:

```sh
bash infra/vps/new-vps.sh <IP> <domain> <github-repo-url> main <admin-email>
```

It runs, in order:

1. Copies this folder to `/root` on the server.
2. `setup.sh` (about 10 minutes): Docker, Caddy (HTTPS), Google Chrome, tmux, 4 GB swap, UFW
   (22/80/443), fail2ban, Rakazo in `/srv/rakazo`, a `claude` user with Claude Code, and SSH keys
   only. Sets `RAKAZO_COMPUTER_MEMORY=4g` and `RAKAZO_ADMIN_EMAILS`. Safe to re-run.
3. `enable-autodeploy.sh <repo> main` (interactive):
   - Private repo: prints a deploy key. Add it at `<repo>/settings/keys` with write access off; the
     script waits until it works.
   - Installs a 2-minute deploy timer, the webhook listener, and Caddy's `/_autodeploy/github` route.
   - Prints the webhook Payload URL and Secret. Add them at `<repo>/settings/hooks`, content type
     `application/json`, "Just the push event". Unsigned requests are rejected.
4. The first deploy (20–30 minutes) builds the app image and the bot computer image (Debian 13 +
   Google Chrome + Xfce). `bot-desktop.patch` is applied when the repo does not carry the desktop.

To add the GitHub webhook before the server is ready, make the secret first:

```sh
mkdir -p ~/.rakazo-vps && (umask 077; openssl rand -hex 32 > ~/.rakazo-vps/webhook-secret-<domain>)
pbcopy < ~/.rakazo-vps/webhook-secret-<domain>
```

Use `https://<domain>/_autodeploy/github` as the Payload URL. `new-vps.sh` installs that secret on
the server. The ping fails until setup is done; use "Redeliver" afterwards. Never keep the secret
inside this repository.

Follow a deploy with `journalctl -fu rakazo-autodeploy`; see where it stands with
`rakazo-autodeploy status`.

## After the first deploy

1. **Sign up** at `https://<domain>`, then close signups:
   `ssh -i ~/.ssh/rakazo_vps root@<IP> 'bash setup.sh --lock-signups'`
2. **Verify the admin email.** Without email delivery the account stays unverified and admin pages
   stay hidden. Run this yourself so the password stays on the server:
   ```sh
   ssh -t -i ~/.ssh/rakazo_vps root@<IP> 'cd /srv/rakazo && read -rp "Email: " OWNER_EMAIL; read -rsp "Rakazo password: " OWNER_PASSWORD; echo; export OWNER_EMAIL OWNER_PASSWORD; docker compose --env-file .env -f docker-compose.images.yml exec -e OWNER_EMAIL -e OWNER_PASSWORD api node dist/cli/bootstrap-owner.js'
   ```
3. **Connect a model** in Settings → Models, and pick the Main and Approval models.
   - A Claude subscription token comes from `claude setup-token`, run as the `claude` user on the
     server. Copy only the `sk-ant-oat01-…` line: a valid token is 108 characters and ends in `AA`.
     Clear the field first (Cmd+A, Delete) so the browser's password manager does not refill an old
     value. Subscription tokens can be blocked by the provider; an API key is the safe choice.
   - Do not put model keys in `.env`; connect them in Settings.
4. **Storage (optional).** Use Settings → Storage. Without it, `ssh -t … 'bash use-r2.sh'` asks for
   an S3-compatible bucket's details on the server and tests a write, read and delete before
   changing `.env`.
5. **Back up `ENCRYPTION_KEY`** from `/srv/rakazo/.env`. Without it, encrypted data cannot be read.

## Verify

- `curl -s -o /dev/null -w '%{http_code}' https://<domain>/` returns 200.
- `docker compose -f /srv/rakazo/docker-compose.images.yml --env-file /srv/rakazo/.env ps` shows
  api, worker and supervisor healthy.
- `bash /root/test-desktop.sh rakazo-custom/computer:<tag>` ends with `RESULT: 31 passed, 0 failed`.
  The tag is `RAKAZO_COMPUTER_IMAGE_TAG` in `/srv/rakazo/.env`.
- GitHub's "Recent Deliveries" shows a 200 ping, and a test push logs "deploying <sha>" within seconds.
- A bot's Computer tab shows the Xfce panel: Applications, Chrome, Thunar, Terminal and a clock.

## Day-to-day

| Task | How |
|---|---|
| Deploy | Push to the branch, or wait up to 2 minutes. A push during a deploy deploys right after. |
| Status | `rakazo-autodeploy status`, `journalctl -u rakazo-autodeploy -n 50` |
| A commit failed | It is skipped until a newer commit arrives; the previous release keeps running. |
| New computer image | Bots switch after **Update computer**, which waits while a bot waits for input. |
| Back up | `/srv/rakazo/.env` (`ENCRYPTION_KEY`) and the Postgres volume |
| Restart | `cd /srv/rakazo && docker compose -f docker-compose.images.yml --env-file .env up -d --pull never` |
| Update without autodeploy | `bash update.sh` |

Once custom images are in use, do not run `install-images.sh`: it tries to pull `rakazo-custom/*`
from a registry and fails.

## Files

| File | Purpose |
|---|---|
| `new-vps.sh` | Mac-side one-command setup |
| `setup.sh` | Server base setup; `--lock-signups` closes signups |
| `autodeploy.sh` | Deploys the newest commit: build, switch, health check, roll back |
| `autodeploy-webhook.py` | GitHub webhook listener (HMAC-checked, unprivileged, writes a trigger file) |
| `enable-autodeploy.sh` | Installs the deploy key, timer, path unit, webhook service and Caddy route |
| `bot-desktop.patch` | Debian 13 + Google Chrome + Xfce desktop for the bot computer image |
| `custom-computer.sh` | Builds the computer image with the patch by hand (autodeploy does this itself) |
| `test-desktop.sh` | 31 checks of the bot desktop under the real container restrictions |
| `update.sh` | Manual update without autodeploy |
| `use-r2.sh` | Connects an S3-compatible bucket through `.env` |

## Notes

- Maintenance scripts that touch the database need the owner URL
  `postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB`; row-level security
  hides rows from the app role.
- Autodeploy copies `infra/compose/docker-compose.images.yml` from the deployed commit and restores
  the previous copy on rollback.
- Pushes to other branches reach the webhook and get 202 "ignored"; only the tracked branch deploys.
  A deploy takes 1–3 minutes when the computer image is unchanged.
- Login allows 10 attempts per IP per 15 minutes (table `rateLimit`). To unblock someone who hit it
  during a restart, delete that IP's `/sign-in/email` row.
- `docker run --tmpfs /tmp` is `noexec`, and the computer starts its desktop scripts from `/tmp`.
- When copying a folder from macOS with `tar`, use `COPYFILE_DISABLE=1 tar --no-xattrs` to avoid `._*` files.
