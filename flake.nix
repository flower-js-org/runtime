{
  description = "A Raft-backed database of reactive TypeScript values";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    xmit = {
      url = "github:xmit-co/xmit";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      xmit,
    }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      # Pin the current stable toolchain independently of the Nixpkgs release
      # so local and CI builds use the same compiler.
      rustVersion = "1.98.1";

      overlays = [ rust-overlay.overlays.default ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs supportedSystems (
          system:
          f (
            import nixpkgs {
              inherit system;
              inherit overlays;
              config.allowDeprecatedx86_64Darwin = true;
            }
          )
        );

      mkFlower =
        pkgs:
        let
          rustToolchain = pkgs.rust-bin.stable.${rustVersion}.default;
        in
        (pkgs.rustPlatform.buildRustPackage.override {
          cargo = rustToolchain;
          rustc = rustToolchain;
        })
          {
            pname = "flower";
            version = "0.1.0";

            src = ./.;
            cargoLock.lockFile = ./Cargo.lock;
            cargoBuildFlags = [
              "--bin"
              "flower"
            ];

            meta = {
              description = "A Raft-backed database of reactive TypeScript values";
              homepage = "https://github.com/xmit-dev/flower";
              license = pkgs.lib.licenses.mit;
              mainProgram = "flower";
              platforms = supportedSystems;
            };
          };
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          flower = mkFlower pkgs;
        in
        {
          inherit flower;
          default = flower;
        }
      );

      apps = forAllSystems (
        pkgs:
        let
          flower = mkFlower pkgs;
          app = {
            type = "app";
            program = "${flower}/bin/flower";
          };
        in
        {
          default = app;
          flower = app;
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          name = "flower-dev";

          packages = [
            pkgs.rust-bin.stable.${rustVersion}.default
            pkgs.nodejs_26
            pkgs.stdenv.cc
            xmit.packages.${pkgs.stdenv.hostPlatform.system}.default
          ];
        };
      });

      checks = forAllSystems (pkgs: {
        flower = mkFlower pkgs;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
