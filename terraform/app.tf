resource "aws_s3_bucket" "archive" {
  bucket = "${var.name}-event-archive"
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_secretsmanager_secret" "database_url" {
  name = "${var.name}/database-url"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgres://relay:${var.db_password}@${var.db_host}:5432/relay"
}

# ------------------------------------------------- relay pod identity (S3)

data "aws_iam_policy_document" "relay_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "relay" {
  name               = "${var.name}-relay"
  assume_role_policy = data.aws_iam_policy_document.relay_assume.json
}

data "aws_iam_policy_document" "relay_archive" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.archive.arn}/events/*"]
  }
}

resource "aws_iam_role_policy" "relay_archive" {
  name   = "${var.name}-archive"
  role   = aws_iam_role.relay.id
  policy = data.aws_iam_policy_document.relay_archive.json
}

resource "aws_eks_addon" "pod_identity" {
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "eks-pod-identity-agent"
}

resource "aws_eks_pod_identity_association" "relay" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "relay"
  service_account = "relay"
  role_arn        = aws_iam_role.relay.arn
}
