{
  description = "A sample NixOS-on-Lima configuration flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    ragenix = {
      url = "github:yaxitech/ragenix";
      inputs.darwin.follows = "";
    };
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";
    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, ragenix, disko, nixos-lima, home-manager, ... }@inputs:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      latestRelease = "0b2f5613fe4632537c8e3597ea44ec01775d5496";
    in
    {
      nixosConfigurations.hetzner-cloud-aarch64 = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          disko.nixosModules.disko
          ./nix/base.nix
        ];
      };

      nixosConfigurations.h4p = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          disko.nixosModules.disko
          ragenix.nixosModules.default
          ./nix/base.nix
          ./nix/h4p.nix
          ./nix/caddy.nix
          ./nix/podman.nix
          {
            services.sai.containers = {
              sparql.resolver = "127.0.0.11";
              id.idOrigin = "hackers4peace.net";
              id.docOrigin = "id.hackers4peace.net";
              data.origin = "data.hackers4peace.net";
              registry.origin = "reg.hackers4peace.net";
              auth.origin = "auth.hackers4peace.net";
              ui.origin = "app.auth.hackers4peace.net";
              sparql.tag = latestRelease;
              id.tag = latestRelease;
              data.tag = latestRelease;
              registry.tag = latestRelease;
              auth.tag = latestRelease;
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
      nixosConfigurations.lima-min = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/lima.nix
        ];
      };
      nixosConfigurations.lima = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/lima.nix
          ./nix/caddy.nix
          ./nix/podman.nix
          {
            services.sai.containers = {
              sparql.resolver = "127.0.0.11";
              id.idOrigin = "id";
              id.docOrigin = "id";
              data.baseUrl = "https://data/";
              auth.vapidPublicKey = "BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY";
              auth.baseUrl = "https://auth/";
              auth.authEndpoint = "https://app.auth/authorize";
              auth.env = ./packages/css-storage-fixture/dev/env;
              auth.idOrigin = "id";
              auth.docOrigin = "id";
              auth.dataOrigin = "data";
              auth.regOrigin = "registry";
              registry.baseUrl = "https://registry/";
              sparql.tag = latestRelease;
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
          ./nix/lima.nix
          ./nix/caddy.nix
          ./nix/podman-local.nix
          {
            services.sai.containers = {
              sparql.resolver = "127.0.0.11";
              id.idOrigin = "id";
              id.docOrigin = "id";
              data.baseUrl = "https://data/";
              auth.vapidPublicKey = "BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY";
              auth.baseUrl = "https://auth/";
              auth.authEndpoint = "https://app.auth/authorize";
              auth.env = ./packages/css-storage-fixture/dev/env;
              auth.idOrigin = "id";
              auth.docOrigin = "id";
              auth.dataOrigin = "data";
              auth.regOrigin = "registry";
              registry.baseUrl = "https://registry/";
            };
          }
        ];
      };

      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          sai-oxigraph = pkgs.callPackage ./nix/packages/sai-oxigraph.nix { };
          sai-oxigraph-image = pkgs.callPackage ./nix/images/sai-oxigraph.nix { };

          sai-id = pkgs.callPackage ./nix/packages/sai-id.nix { };
          sai-id-image = pkgs.callPackage ./nix/images/sai-id.nix { };

          sai-css = pkgs.callPackage ./nix/packages/sai-css.nix { };
          sai-css-image = pkgs.callPackage ./nix/images/sai-css.nix { };

          sai-ui = pkgs.callPackage ./nix/packages/sai-ui.nix {};
        }
      );
    };
}
