# Use your own network

Send your bots' browsers through a network of your own, such as your home internet, so websites
see your address instead of the server's.

Only the browser on each bot's computer uses it. Web search and page reads that bots do without the
computer still come from the server. Each person's network serves only their own computers, never a
teammate's.

## Your desktop app

In the Rakazo desktop app, open **Settings → General** and turn on **Route bot browsing through
this computer**. While the app is open and connected, your computers' browsers reach websites
from that computer's internet connection. When none of your desktops is online, they go out from
the server as usual.

Only that computer can turn it on, and it reaches only public addresses: bots can't use it to
open pages on your home network or router. A computer that's already running picks up the change
the next time it starts.

> [!NOTE]
> This needs a server reached over HTTPS and its Docker computers. A Tailscale or proxy connection
> in the same space takes its place.

## Tailscale

Your computers join your tailnet and leave through an exit node you choose, such as a phone or a
computer at home.

1. **Pick an exit node.** An Android phone, a Mac, a Windows or Linux PC, or an Apple TV can be an
   exit node; an iPhone or iPad can't. In the Tailscale app on that device, turn on **Run as exit
   node**, then allow it in the admin console under **Machines**.
2. **Limit what computers can reach.** Bots control their computers, so let them reach the internet
   and nothing else on your tailnet. In **Access controls**, add a tag and a grant like this, and
   make sure no other rule includes the tag:

   ```json
   "tagOwners": { "tag:rakazo": ["autogroup:admin"] },
   "grants": [{ "src": ["tag:rakazo"], "dst": ["autogroup:internet"], "ip": ["*"] }]
   ```

3. **Create an auth key.** Under **Settings → Keys**, generate an auth key that is **Reusable** and
   **Ephemeral**, with the tag `tag:rakazo`. Ephemeral machines leave your tailnet on their own when
   a computer stops.
4. **Connect it.** Choose **Connect apps**, then **+** and **Tailscale**. Enter the key and the exit
   node's machine name, then choose **Connect**.

A computer that's already running picks up the change the next time it starts. To switch now, open
its screen, choose **More computer actions** and then **Stop computer**.

If the exit node is offline or the key stops working, the browser can't load pages; it never falls
back to the server's address. Choose **Tailscale** again to change the exit node or key, or
**Disconnect** to stop using it.

> [!NOTE]
> This works with the Docker computers of a self-hosted server. Other computer providers don't
> offer it yet.

## A proxy of your own

If you already run an HTTP proxy, such as an app on your phone or a proxy on your home network,
choose **Connect apps**, then **+** and **Proxy**. Enter its **Proxy address** as host and port
(for example `proxy.example.com:8080`) and, if it asks for one, a username and password. The
address must be reachable from the internet; HTTPS sites go through it as well. For a SOCKS
proxy, use Tailscale instead.

## How it stays private

The key or password is encrypted on the server and never enters the bot's computer. A separate
container next to the computer holds it and runs the connection; the computer only gets the address of
that container's proxy, and no other computer can reach it. WebRTC is limited to the proxy too, so
calls and video can't reveal the server's address. Connecting and disconnecting are recorded in
the [audit log](./self-host-audit-log.md).
