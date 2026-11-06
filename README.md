# Solid Application Interoperability (TypeScript)

[![CI](https://github.com/hackers4peace/sai-js/actions/workflows/ci.yml/badge.svg)](https://github.com/hackers4peace/sai-js/actions/workflows/ci.yml)
[![Matrix chat](https://badges.gitter.im/gitterHQ/gitter.png)](https://app.gitter.im/#/room/#solid_specification:gitter.im)
[![MIT license](https://img.shields.io/github/license/hackers4peace/sai-js)](https://github.com/hackers4peace/sai-js/blob/main/LICENSE)

Modules implementing [Solid Application Interoperability Specification](https://solid.github.io/data-interoperability-panel/specification/)

## Intended dependents

|                           | package                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Solid Applications        | [`@janeirodigital/interop-application`](https://github.com/hackers4peace/sai-js/tree/main/packages/application)                 |
| Solid Authorization Agent | [`@janeirodigital/interop-authorization-agent`](https://github.com/hackers4peace/sai-js/tree/main/packages/authorization-agent) |

## Development

### Docker Shared Services

Default setup assumes `docker` command available, and runs it as non-root user.
Also [mkcert](https://mkcert.dev/) is required.

The setup is using modified `Makefile` and `docker-compose.yaml` from [docker-shared-services](https://github.com/wayofdev/docker-shared-services)

### Node, corepack and npm

Requires Node.js 26 or higher

### Local DNS

#### macOS

```bash
mkdir /etc/resolver/
sudo sh -c 'echo "nameserver 127.0.0.1" > /etc/resolver/docker'
sudo dscacheutil -flushcache
```

If port 53 is occupied, go to docker and uncheck settings -> resources -> network -> Use kernel networking for UDP

To enable communication to docker network

```bash
# Install via Homebrew
$ brew install chipmk/tap/docker-mac-net-connect

# Run the service and register it to launch at boot
$ sudo brew services start chipmk/tap/docker-mac-net-connect
```

### Bootstrapping

```bash
npm install
npm run build
npm test
```

To create local certificates

```bash
make cert-install
```

To start local development

```bash
make up
```

It will run the following:

#### Community Solid Server

Runs as the `auth`, `registry`, and `data` services in [docker-compose.yaml](docker-compose.yaml) (configs in `environments/css/`), used for solid storage instances and the solid-oidc provider.

Available on https://auth.docker, https://reg.docker and https://*.data.docker. Seed the environment with `devbox run seed`.

#### Authorization Agent

##### UI

Run from [ui/authorization](https://github.com/hackers4peace/sai-js/tree/main/ui/authorization).
Available on https://ui.auth.docker , requires signing up with UI first and later signing up in with the service (_Connect server_).
Dev config uses local CSS as default provider when input left empty.

#### Demo app (Vujectron)

Run from [examples/vuejectron](https://github.com/hackers4peace/sai-js/tree/main/examples/vuejectron).
Available on https://vuejectron.docker , requires signup and authorization.
Dev config uses local CSS as default provider when input left empty.

## Localization

The translation project for all relevant components is hosted thanks to the courtesy of [Weblate Libre hosting](https://weblate.org/en/hosting/#libre).

[<img src="https://hosted.weblate.org/widget/sai/open-graph.png" alt="Translation status" width="40%" />](https://hosted.weblate.org/engage/sai/)

## Deployment

### VPS

Create a VPS and add your public SSH key. The examples below use a Hetzner
CAX21 (aarch64); adjust the flake host if you use another architecture.

### DNS

Configure DNS for your domain. For `me.example`:

```txt
me.example.            A  <VPS IP>
*.me.example.          A  <VPS IP>
app.auth.me.example.   A  <VPS IP>
data.me.example.       A  <VPS IP>
*.data.me.example.     A  <VPS IP>
```

`*.me.example` covers `auth`, `reg`, `id`, and user WebIDs. Keep these records
DNS-only (Cloudflare proxy off): Caddy terminates TLS and the WebID/SPARQL
endpoints are addressed by their public origin. If you replace the VPS, update
every A record that points to the old IP.

### NixOS

`nixos-anywhere` replaces the VPS disk. Make sure the target has no data you
need before continuing.

For the demo host, the flake provides wrappers:

```bash
# Fresh install of the base system. The host key is regenerated.
nix run .#install-demo-base -- root@<demo-host>

# Full install preserving the current host key (use when secrets already
# match that key).
nix run .#install-demo -- root@<demo-host>

# Subsequent configuration changes.
nix run .#deploy-demo -- root@<demo-host>

# Roll back one generation.
nix run .#rollback-demo -- root@<demo-host>
```

The raw base install equivalent is:

```bash
nixos-anywhere \
  --flake .#hetzner-cloud-aarch64 \
  --target-host root@me.example \
  --build-on remote \
  --kexec-extra-flags "-c"
```

`--kexec-extra-flags "-c"` forces the legacy `kexec_load` syscall. Hetzner
CAX / Ubuntu 26.04 rejects `kexec_file_load` with `EADDRNOTAVAIL`, leaving the
machine unreachable after kexec. The full-install wrapper additionally passes
`--copy-host-keys` so existing ragenix secrets remain decryptable.

If you use `--copy-host-keys`, add that host key to
`nix/hosts/me/secrets.nix` before encrypting the secrets. Without it, read the
new host key after the first boot and update the recipients before deploying.

### Nix config

Start from the demo host:

```bash
cp -r nix/hosts/demo nix/hosts/me
```

Add a matching `nixosConfigurations.me` in `flake.nix`, and set the image tag to
the release commit whose OCI images were published to Quay:

```nix
tag = "<release-commit-sha>";
```

The demo config uses `https://auth.<domain>`, `https://app.auth.<domain>`,
`https://reg.<domain>`, and `https://data.<domain>`; keep the flake host's
origins and Caddy virtual hosts consistent.

#### Secrets

All secret files are encrypted with ragenix. Add the target host's ed25519 key
to `nix/hosts/me/secrets.nix`:

```nix
let
  me = "ssh-ed25519 AAAA...";
in
{
  "secrets/cloudflare.age".publicKeys = [ me ];
  "secrets/auth.age".publicKeys = [ me ];
  "secrets/fuseki.age".publicKeys = [ me ];
  "secrets/garage.age".publicKeys = [ me ];
}
```

Encrypt or edit each file from `nix/hosts/me`:

```bash
RULES=./secrets.nix ragenix -e ./secrets/cloudflare.age
RULES=./secrets.nix ragenix -e ./secrets/auth.age
RULES=./secrets.nix ragenix -e ./secrets/fuseki.age
RULES=./secrets.nix ragenix -e ./secrets/garage.age
```

- `cloudflare.age` — `CF_API_TOKEN=...`, a Cloudflare token with `Zone:Zone:Read`
  and `Zone:DNS:Edit` for the zone. Caddy uses it for ACME DNS-01. If the token
  has IP filtering, allow both the VPS IPv4 and IPv6 addresses; Caddy may reach
  the Cloudflare API over IPv6.
- `auth.age` — `CSS_VAPID_PRIVATE_KEY=...`, `CSS_PUSH_SENDER=mailto:...`, and
  `CSS_ENCODED_PRIVATE_JWK=...`. The public VAPID key in the host config must
  match the private key.
- `fuseki.age` — `ADMIN_PASSWORD=...` and `CSS_FUSEKI_ADMIN=admin:...` with the
  same password. Fuseki uses the first; the worker uses the second to create
  per-account datasets.
- `garage.age` — `GARAGE_RPC_SECRET=...`, `GARAGE_ADMIN_TOKEN=...`, and
  `CSS_GARAGE_ADMIN_TOKEN=...` with the same admin token. The worker uses the
  admin token to create per-data-pod buckets and keys.

Generate the VAPID pair with:

```bash
npx web-push generate-vapid-keys
```

Generate the base64url-encoded private JWK with:

```bash
node packages/repl/cmd.ts -- gen-jwk -b
```

`CSS_PUSH_SENDER` must be a `mailto:` or `https:` contact URI.

#### Applying config

For a fresh install, `nixos-anywhere` installs the base system first; then deploy
the demo host:

```bash
nix run .#deploy-demo -- root@<demo-host>
```

The raw command is:

```bash
nixos-rebuild switch \
  --no-reexec \
  --flake .#me \
  --target-host root@me.example \
  --build-host root@me.example
```

`--no-reexec` is needed so `nixos-rebuild` does not try to execute the target's
aarch64 `nixos-rebuild` on the local build machine.

> [!TIP]
> If a one-shot service such as the Temporal schema/namespace setup fails
> because Postgres was not ready, re-run the command.

Caddy requests certificates through the Cloudflare DNS-01 challenge. Once the
containers are healthy, the account management UI is at
`https://app.auth.me.example`.

## Funding

This project is funded through the [NGI Zero Entrust Fund](https://nlnet.nl/entrust), a fund established by [NLnet](https://nlnet.nl) with financial support from the European Commission's [Next Generation Internet](https://ngi.eu) program. Learn more at the [NLnet project page](https://nlnet.nl/project/SolidInterop3).

[<img src="https://nlnet.nl/logo/banner.png" alt="NLnet foundation logo" height="100px" style="margin-right: 50px" />](https://nlnet.nl)
[<img src="https://nlnet.nl/image/logos/NGI0Entrust_tag.svg" alt="NGI Zero Entrust Logo" height="100px"/>](https://nlnet.nl/entrust)
