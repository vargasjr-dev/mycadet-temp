#!/usr/bin/env sh

cadet_is_kata_family_runtime() {
  case "${CADET_SANDBOX_RUNTIME:-}" in
    kata|firecracker|cloud-hypervisor)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}
