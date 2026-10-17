# ---------------------------------------------------------------------------
# iOS signing secrets: GCP Secret Manager (source of truth) → GitHub Actions
# (replica consumed by .github/workflows/release-ios.yaml).
#
# Portfolio doctrine (vargasjr.dev/terraform/secrets.tf): GCP Secret Manager
# is the single source of truth; everything else is a replica terraform
# converges. Rotation = write a new SM version, then `terraform apply`.
#
# STAGING IS DELIBERATELY EXCLUDED (per Vargas): the _STAGING profile
# replicas are not managed here. Extend the map below if that changes.
# ---------------------------------------------------------------------------

locals {
  # GHA secret name → GCP Secret Manager secret ID. Portfolio convention:
  # identical names in both places.
  #
  # binary = the secret is an encoded binary artifact (a .mobileprovision or
  # the distribution .p12) that release-ios.yaml expects as base64 text in
  # the Actions secret. Plain secrets pass through verbatim.
  ios_secrets = {
    # Distribution certificate + its export password + team id
    DIST_CERTIFICATE_P12      = { binary = true }
    DIST_CERTIFICATE_PASSWORD = { binary = false }
    APPLE_TEAM_ID             = { binary = false }

    # Main app (production + dev)
    IOS_PROVISIONING_PROFILE     = { binary = true }
    IOS_PROVISIONING_PROFILE_DEV = { binary = true }

    # Notification Service Extension (production + dev)
    IOS_PROVISIONING_PROFILE_NSE     = { binary = true }
    IOS_PROVISIONING_PROFILE_NSE_DEV = { binary = true }

    # Share Extension (production + dev)
    IOS_PROVISIONING_PROFILE_SHARE     = { binary = true }
    IOS_PROVISIONING_PROFILE_SHARE_DEV = { binary = true }

    # Widget/other extension (production + dev)
    IOS_PROVISIONING_PROFILE_EXT     = { binary = true }
    IOS_PROVISIONING_PROFILE_EXT_DEV = { binary = true }
  }

  # Binary secrets must arrive in Actions as base64 text. If the vault
  # already stores base64 (default), pass through; if it stores raw file
  # bytes, encode here.
  secret_values = {
    for name, cfg in local.ios_secrets : name => (
      cfg.binary && !var.binary_secrets_stored_base64
      ? base64encode(data.google_secret_manager_secret_version.ios_secrets[name].secret_data)
      : data.google_secret_manager_secret_version.ios_secrets[name].secret_data
    )
  }
}

data "google_secret_manager_secret_version" "ios_secrets" {
  for_each = local.ios_secrets

  secret  = each.key
  version = "latest"
}

resource "github_actions_secret" "ios_secrets" {
  for_each = local.ios_secrets

  repository  = var.github_repo
  secret_name = each.key
  value       = local.secret_values[each.key]
}
