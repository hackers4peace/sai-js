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
      # Change this to "x86_64-linux" if necessary
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      nixosConfigurations.base = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        # Pass the `nixos-lima` input along with the default module system parameters
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./base.nix
        ];
      };
      nixosConfigurations.sai = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        # Pass the `nixos-lima` input along with the default module system parameters
        specialArgs = { inherit nixos-lima; };
        modules = [
          ./base.nix
          ./podman.nix
        ];
      };
    };    
}
