variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "name" {
  type    = string
  default = "relay-prod"
}

variable "app_node_port" {
  description = "NodePort the relay Service is exposed on"
  type        = number
  default     = 30080
}

variable "db_host" {
  description = "Endpoint of the managed Postgres instance (owned by the data team)"
  type        = string
  default     = "relay-prod.cluster-c1xyz.eu-west-1.rds.amazonaws.com"
}

variable "db_password" {
  description = "Set via TF_VAR_db_password from the secret store, never committed"
  type        = string
  sensitive   = true
}

variable "certificate_arn" {
  description = "ACM certificate for the public HTTPS listener"
  type        = string
}

variable "cluster_public_access_cidrs" {
  description = "CIDRs allowed to reach the EKS API (VPN / CI egress)"
  type        = list(string)
}
