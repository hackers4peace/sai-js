{
  description = "A sample NixOS-on-Lima configuration flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    ragenix.url = "github:yaxitech/ragenix";
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";
    nixos-anywhere = {
      url = "github:nix-community/nixos-anywhere";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.nixos-stable.follows = "nixpkgs";
    };
    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      ragenix,
      disko,
      nixos-anywhere,
      nixos-lima,
      ...
    }@inputs:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      # Quay image tags are the commit SHA of the release.
      latestRelease = "4db779a50ecc820892d6dc3c040d440c312bd246";

      # Deployment wrappers. Build on the VPS (aarch64), not locally.
      buildSystem = "x86_64-linux";
      deployPkgs = nixpkgs.legacyPackages.${buildSystem};
      repoCheck = ''
        repo_root="''${REPO_ROOT:-$PWD}"
        if [ ! -f "$repo_root/flake.nix" ]; then
          echo "error: run this from the repository root, or set REPO_ROOT" >&2
          exit 2
        fi
      '';
      targetArg = ''
        target="''${1:-}"
        if [ -z "$target" ]; then
          echo "usage: $0 root@<ip> [options...]" >&2
          exit 2
        fi
        shift
      '';
      installDemo = deployPkgs.writeShellApplication {
        name = "install-demo";
        runtimeInputs = [ nixos-anywhere.packages.${buildSystem}.default ];
        text = ''
          ${repoCheck}
          ${targetArg}
          # -c forces the legacy kexec_load syscall. Hetzner CAX / Ubuntu 26.04
          # rejects kexec_file_load with EADDRNOTAVAIL.
          exec nixos-anywhere \
            --flake "path:$repo_root#demo" \
            --target-host "$target" \
            --build-on remote \
            --copy-host-keys \
            --kexec-extra-flags "-c" \
            "$@"
        '';
      };
      installDemoBase = deployPkgs.writeShellApplication {
        name = "install-demo-base";
        runtimeInputs = [ nixos-anywhere.packages.${buildSystem}.default ];
        text = ''
          ${repoCheck}
          ${targetArg}
          # Base install: no demo services, secrets, or ragenix. The host key
          # is regenerated, so update nix/hosts/demo/secrets.nix afterwards.
          exec nixos-anywhere \
            --flake "path:$repo_root#hetzner-cloud-aarch64" \
            --target-host "$target" \
            --build-on remote \
            --kexec-extra-flags "-c" \
            "$@"
        '';
      };
      deployDemo = deployPkgs.writeShellApplication {
        name = "deploy-demo";
        runtimeInputs = [
          deployPkgs.nixos-rebuild
          deployPkgs.openssh
          deployPkgs.nix
          deployPkgs.gitMinimal
        ];
        text = ''
          ${repoCheck}
          ${targetArg}
          exec nixos-rebuild switch \
            --no-reexec \
            --flake "path:$repo_root#demo" \
            --target-host "$target" \
            --build-host "$target" \
            "$@"
        '';
      };
      rollbackDemo = deployPkgs.writeShellApplication {
        name = "rollback-demo";
        runtimeInputs = [
          deployPkgs.nixos-rebuild
          deployPkgs.openssh
          deployPkgs.nix
        ];
        text = ''
          ${repoCheck}
          ${targetArg}
          exec nixos-rebuild switch \
            --no-reexec \
            --rollback \
            --target-host "$target" \
            "$@"
        '';
      };
    in
    {
      nixosConfigurations.hetzner-cloud-aarch64 = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          disko.nixosModules.disko
          ./nix/base.nix
          ./nix/keys/elf.nix
        ];
      };

      nixosConfigurations.h4p = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          disko.nixosModules.disko
          ragenix.nixosModules.default
          ./nix/base.nix
          ./nix/keys/elf.nix
          ./nix/h4p.nix
          ./nix/caddy.nix
          ./nix/podman.nix
          {
            services.sai.containers = {
              id.idOrigin = "hackers4peace.net";
              id.docOrigin = "id.hackers4peace.net";
              data.origin = "data.hackers4peace.net";
              registry.origin = "reg.hackers4peace.net";
              auth.origin = "auth.hackers4peace.net";
              ui.origin = "app.auth.hackers4peace.net";
              auth.cookieDomain = ".auth.hackers4peace.net";
              id.tag = latestRelease;
              data.tag = latestRelease;
              registry.tag = latestRelease;
              auth.tag = latestRelease;
              worker.tag = latestRelease;
              id.caddyConfig = ''
                tls {
                  dns gandi {env.GANDI_BEARER_TOKEN}
                  propagation_delay 300s
                }
                reverse_proxy localhost:3000 {
                  header_up Host {host}
                }
              '';
              data.caddyConfig = ''
                tls {
                  dns gandi {env.GANDI_BEARER_TOKEN}
                  propagation_delay 300s
                }
                reverse_proxy localhost:4700 {
                  header_up Host {host}
                  header_up X-Forwarded-Proto https
                }
              '';
              auth.caddyConfig = ''
                tls {
                  dns gandi {env.GANDI_BEARER_TOKEN}
                  propagation_delay 300s
                }
                reverse_proxy localhost:4800 {
                  header_up Host {host}
                  header_up X-Forwarded-Proto https
                }
              '';
              registry.caddyConfig = ''
                tls {
                  dns gandi {env.GANDI_BEARER_TOKEN}
                  propagation_delay 300s
                }
                reverse_proxy localhost:4600 {
                  header_up Host {host}
                  header_up X-Forwarded-Proto https
                }
              '';
              data.baseUrl = "https://data.hackers4peace.net/";
              auth.vapidPublicKey = "BJ5cuKc1taNAQ87rXz9mO9g8kE7198r_yc2iCSexaqDlax4nUpnj9T1sxAyBH8l--1qiZCeSwCsDi6KYUkx2vBA";
              auth.baseUrl = "https://auth.hackers4peace.net/";
              auth.authEndpoint = "https://app.auth.hackers4peace.net/authorize";
              auth.idOrigin = "hackers4peace.net";
              auth.docOrigin = "id.hackers4peace.net";
              auth.dataOrigin = "data.hackers4peace.net";
              auth.regOrigin = "reg.hackers4peace.net";
              registry.baseUrl = "https://reg.hackers4peace.net/";
            };
          }
        ];
      };

      nixosConfigurations.demo = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          disko.nixosModules.disko
          ragenix.nixosModules.default
          ./nix/base.nix
          ./nix/keys/elf.nix
          ./nix/hosts/demo/demo.nix
          ./nix/caddy.nix
          ./nix/podman.nix
        ];
      };
      nixosConfigurations.lima-min = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/hosts/lima/lima.nix
        ];
      };
      nixosConfigurations.lima = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/hosts/lima/lima.nix
          ./nix/hosts/lima/config.nix
          ./nix/caddy.nix
          ./nix/podman.nix
          {
            services.sai.containers = {
              id.tag = latestRelease;
              data.tag = latestRelease;
              registry.tag = latestRelease;
              auth.tag = latestRelease;
            };
          }
        ];
      };
      nixosConfigurations.lima-local = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/hosts/lima/lima.nix
          ./nix/hosts/lima/config.nix
          ./nix/caddy.nix
          ./nix/hosts/lima/podman-local.nix
        ];
      };

      apps.${buildSystem} = {
        "install-demo" = {
          type = "app";
          program = "${installDemo}/bin/install-demo";
          meta.description = "Install NixOS on the demo VPS with nixos-anywhere";
        };
        "install-demo-base" = {
          type = "app";
          program = "${installDemoBase}/bin/install-demo-base";
          meta.description = "Install the base NixOS system on the demo VPS";
        };
        "deploy-demo" = {
          type = "app";
          program = "${deployDemo}/bin/deploy-demo";
          meta.description = "Build and switch the demo host over SSH";
        };
        "rollback-demo" = {
          type = "app";
          program = "${rollbackDemo}/bin/rollback-demo";
          meta.description = "Roll the demo host back one generation";
        };
        default = self.apps.${buildSystem}."install-demo";
      };

      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          sai-runtime = pkgs.callPackage ./nix/packages/sai-runtime.nix { };

          sai-id = pkgs.callPackage ./nix/packages/sai-id.nix { };
          sai-id-image = pkgs.callPackage ./nix/images/sai-id.nix { };

          sai-css = pkgs.callPackage ./nix/packages/sai-css.nix { };
          sai-css-image = pkgs.callPackage ./nix/images/sai-css.nix { };

          sai-worker = pkgs.callPackage ./nix/packages/sai-worker.nix { };
          sai-worker-image = pkgs.callPackage ./nix/images/sai-worker.nix { };

          sai-ui = pkgs.callPackage ./nix/packages/sai-ui.nix { };
        }
      );
    };
}
