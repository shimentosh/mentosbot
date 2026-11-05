# More servers for computers

When one Docker host can't run every bot's computer, add more servers. Rakazo places each new
computer on the least-used server, spreads equally used ones at random, and keeps a computer on
the server it started on. Every organization on the deployment uses the same servers.

Only deployment admins (`RAKAZO_ADMIN_EMAILS`) on a deployment running Docker computers
(`SANDBOX_PROVIDER=docker`) see **Settings → Computer → Servers**.

## Network

The main server reaches each extra server over a private network: a cloud provider's VPC, or a
VPN such as WireGuard or a tailnet. The supervisor and the computers' screens speak plain HTTP, so
Rakazo accepts only private addresses (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) and the
setup script listens on that address alone. Keep port 7091 and the published screen ports closed
on public interfaces.

## Adding a server

1. Start a Debian server with Docker able to pull images (or let the script install `docker.io`).
2. In **Settings → Computer**, choose **Add server** and enter a name, the server's private
   address, and how many computers it should hold.
3. Run the command Rakazo shows on the new server as root. It installs Docker if needed, writes the
   token to a root-only file, and starts the supervisor from the app image with host networking.
   Pass `--image` or `--computer-image` to use your own images.
4. The server shows as ready once it answers. Only then does it take computers.

## Homes

A computer's home is copied onto its server when it starts and saved back to the main server's
home storage (local disk or object storage), as with any remote computer. If a server is removed
or lost, its computers start on another server from their last saved home. Pausing a server keeps
its computers there and sends new ones elsewhere.

## Limits

- The count per server includes stopped computers that still live there.
- `SANDBOX_MAX_COMPUTERS_PER_SPACE` is enforced by each supervisor, so it applies per server.
- Removing a server leaves its containers running on that machine; stop the machine or run
  `docker rm -f $(docker ps -aq --filter label=rakazo.botId)` there.
