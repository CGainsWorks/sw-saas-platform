/**
 * Remote state.
 *
 * Commented out so `terraform init` works with no prerequisites — the first apply from a
 * clean account would otherwise fail on a bucket that does not exist yet, which is a
 * poor first experience.
 *
 * Turn it on before anyone else touches this environment. Local state means no locking,
 * so two concurrent applies corrupt each other, and it means the state file — which
 * contains the generated database password and the JWT private key in cleartext — lives
 * in a working directory rather than an encrypted, versioned bucket.
 *
 * Bootstrap:
 *
 *   aws s3api create-bucket --bucket sw-saas-tfstate-<account-id> \
 *     --region eu-west-2 --create-bucket-configuration LocationConstraint=eu-west-2
 *   aws s3api put-bucket-versioning --bucket sw-saas-tfstate-<account-id> \
 *     --versioning-configuration Status=Enabled
 *   aws s3api put-bucket-encryption --bucket sw-saas-tfstate-<account-id> \
 *     --server-side-encryption-configuration \
 *     '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
 *
 * Then uncomment and run `terraform init -migrate-state`.
 */

# terraform {
#   backend "s3" {
#     bucket       = "sw-saas-tfstate-<account-id>"
#     key          = "envs/dev/terraform.tfstate"
#     region       = "eu-west-2"
#     encrypt      = true
#     # S3-native locking (Terraform >= 1.10). Replaces the old DynamoDB table.
#     use_lockfile = true
#   }
# }
