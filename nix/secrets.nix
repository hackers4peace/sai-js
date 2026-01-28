let
  h4p = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPt6xCq1uGWa687mXrMbxDNVmCHRpOt/ZuRAqh5dyzhT";
in
{
  "secrets/gandi.age".publicKeys = [ h4p ];
}
