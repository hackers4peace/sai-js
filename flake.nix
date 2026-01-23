{
  description = "A sample NixOS-on-Lima configuration flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixos-lima, home-manager, ... }@inputs:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      nixosConfigurations.h4p = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./nix/lima.nix
          ./nix/caddy.nix
          ./nix/podman.nix
          {
            services.sai.containers = {
              id.domain = "id.hackers4peace.net";
              id.sparqlEndpoint = "http://sparql/sparql";
              sparql.resolver = "127.0.0.11";
            };
          }
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
              id.domain = "id";
              id.sparqlEndpoint = "http://sparql/sparql";
              sparql.resolver = "127.0.0.11";
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
              id.domain = "id";
              id.sparqlEndpoint = "http://sparql/sparql";
              sparql.resolver = "127.0.0.11";
            };
          }
        ];
      };

      packages.${system} = {
        sai-oxigraph = pkgs.callPackage ./nix/images/sai-oxigraph.nix { };
        sai-oxigraph-image = pkgs.callPackage ./nix/images/sai-oxigraph.nix { };
        sai-id = pkgs.callPackage ./nix/packages/sai-id.nix { };
        sai-id-image = pkgs.callPackage ./nix/images/sai-id.nix { };
      };
    };
}
