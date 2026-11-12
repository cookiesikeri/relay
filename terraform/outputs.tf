output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "archive_bucket" {
  value = aws_s3_bucket.archive.bucket
}

output "relay_role_arn" {
  value = aws_iam_role.relay.arn
}
