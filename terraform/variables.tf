variable "gcp_project" {
  description = "GCP project whose Secret Manager vault holds the source-of-truth secrets."
  type        = string
  default     = "mycadet"
}

variable "github_repo" {
  description = "GitHub repository (owner/name) that receives the Actions secret replicas."
  type        = string
  default     = "vargasjr-dev/mycadet-temp"
}

variable "binary_secrets_stored_base64" {
  description = <<-EOT
    Whether the binary secrets (provisioning profiles, the .p12 certificate)
    are stored in Secret Manager as the base64 text produced by
    `base64 -i <file>` (true — matches the README flow), or as the raw file
    bytes from a console file-upload (false — terraform base64-encodes them
    on the way into GitHub). The release workflow requires base64 in the
    Actions secret either way.
  EOT
  type        = bool
  default     = true
}
