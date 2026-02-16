# Solid Application Interoperability (TypeScript)

[![CI](https://github.com/hackers4peace/sai-js/actions/workflows/ci.yml/badge.svg)](https://github.com/hackers4peace/sai-js/actions/workflows/ci.yml)
[![Matrix chat](https://badges.gitter.im/gitterHQ/gitter.png)](https://app.gitter.im/#/room/#solid_specification:gitter.im)
[![MIT license](https://img.shields.io/github/license/hackers4peace/sai-js)](https://github.com/hackers4peace/sai-js/blob/main/LICENSE)

Modules implementing [Solid Application Interoperability Specification](https://solid.github.io/data-interoperability-panel/specification/)

## Intended dependents

|                           | package                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Solid Applications        | [`@janeirodigital/interop-application`](https://github.com/hackers4peace/sai-js/tree/main/packages/application)                 |
| Solid Authorization Agent | [`@janeirodigital/interop-authorization-agent`](https://github.com/hackers4peace/sai-js/tree/main/packages/authorization-agent) |

## Development

### Docker Shared Services

Default setup assumes `docker` command available, and runs it as non-root user.
Also [mkcert](https://mkcert.dev/) is required.

The setup is using modified `Makefile` and `docker-compose.yaml` from [docker-shared-services](https://github.com/wayofdev/docker-shared-services)

### Node, corepack and npm

Requires node.js 22 or higher

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

Run from [packages/css-solid-fixture](https://github.com/hackers4peace/sai-js/tree/main/packages/css-storage-fixture).
Used for solid storage instances and solid-oidc provider.

Available on https://pod.docker, default demo account is `alice@acme.example` with `password`.

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

Create VPS, you can use any Linux distribution, we are going to use [NixOS anywhere](https://nix-community.github.io/nixos-anywhere/) to replace it in next step.

Let's use [Hetzner CAX21](https://www.hetzner.com/cloud/#pricing) as an example. We need to add our public SSH key when we create it.

### DNS
Configure DNS for your domain, for example `A` records for `me.example` :

```txt
me.example.
*.me.example.
auth.me.example.
app.auth.me.example.
data.me.example
*.data.me.example.
```

Use IP of your VPS. To avoid having to change in case you want to destroy your VPS and create a different one, you can configure that IP to stay rented independently from specific VPS.

### NixOS

Use [NixOS anywhere](https://nix-community.github.io/nixos-anywhere/) to install it on your VPS. Flake in this repo includes config for `hetzner-cloud-aarch64` so you can simply run

```bash
nixos-anywhere --flake .#hetzner-cloud-aarch64 --build-on remote root@me.example
```

We build on remote to use its architecture.

### Nix config

You can start by making a copy of the demo config:

```bash
cp -r nix/hosts/demo nix/hosts/me
```

And following `#demo` config create `#me` config in `flake.nix`

#### Secrets

We will use [ragenix](https://github.com/yaxitech/ragenix) to encrypt two env files:

* DNS API Key - which is used by [Caddy](https://caddyserver.com/) plugin to issue [Let's encrypt](https://letsencrypt.org/) certificates
* Auth service secrets - Web Push [VAPID](https://www.rfc-editor.org/rfc/rfc8292.html) keys and JSON Web Key for signing tokens.

First we need to add VPS public key to `nix/hosts/me/secrets.nix`. To do it we can first `ssh root@me.example` and accept server fingerprint. Now we can `cat ~/.ssh/known_hosts | grep me.example` and use the `ssh-ed25519` key.

##### DNS API

In our example we will use Cloudflare and [Cloudflare module for Caddy](https://github.com/caddy-dns/cloudflare). Following instructions we create [Account API Token](https://dash.cloudflare.com/1f3f4037f2cee649a505f427550473dc/api-tokens) (custom token) with `Zone.Zone Read` and `Zone.DNS Edit`, we can also set Client IP Address Filtering to IP we have assigned to our VPS.

We can encrypt that by running following command in `nix/hosts/me`

```bash
RULES=./secrets.nix ragenix -e ./secrets/cloudflare.age
```

And following Cloudflare module for Caddy set it as:
```env
CF_API_TOKEN=
```
nix config will set it as an env file so Caddy can access it.

##### VAPID

You can generate a pair by running

```bash
npx web-push generate-vapid-keys
```

You can replace `vapidPublicKey` in your config with generated public key. Private key will be used when we encrypt `auth.age` file.

##### JWK

You can generate base64url encoded JWK, including a private key, by running:

```bash
bun packages/repl/cmd.ts -- gen-jwk -b
```

It will be used when we encrypt `auth.age` file.

##### Auth

We can encrypt that file by running following command in `nix/hosts/me`

```bash
RULES=./secrets.nix ragenix -e ./secrets/auth.age
```

And set
```env

CSS_VAPID_PRIVATE_KEY=
CSS_PUSH_SENDER=
CSS_ENCODED_PRIVATE_JWK=
```

[Application Server Contact Information](https://datatracker.ietf.org/doc/html/draft-thomson-webpush-vapid#section-2.1) is required by the VAPID spec and must be a `mailto:` or an `https:` contact URI.


#### Applying config

Now we can apply our configuration by running

```bash
nixos-rebuild switch \
  --flake .#me \
  --target-host root@me.example \
  --build-host root@me.example
```

> [!TIP]
> In case starting some systemd service errors, you can simply re-run this command.


Now Caddy will request certificates from Let's encrypt and after short moment you should be able to access account management application on `https://app.auth.me.example` (if you further customized your config it will be at that address)

## Funding

This project is funded through the [NGI Zero Entrust Fund](https://nlnet.nl/entrust), a fund established by [NLnet](https://nlnet.nl) with financial support from the European Commission's [Next Generation Internet](https://ngi.eu) program. Learn more at the [NLnet project page](https://nlnet.nl/project/SolidInterop3).

[<img src="https://nlnet.nl/logo/banner.png" alt="NLnet foundation logo" height="100px" style="margin-right: 50px" />](https://nlnet.nl)
[<img src="https://nlnet.nl/image/logos/NGI0Entrust_tag.svg" alt="NGI Zero Entrust Logo" height="100px"/>](https://nlnet.nl/entrust)
