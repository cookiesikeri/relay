resource "aws_security_group" "alb" {
  name   = "${var.name}-alb"
  vpc_id = aws_vpc.this.id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP redirect to HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description     = "To relay NodePort"
    from_port       = var.app_node_port
    to_port         = var.app_node_port
    protocol        = "tcp"
    security_groups = [aws_security_group.nodes.id]
  }
}

resource "aws_security_group" "nodes" {
  name   = "${var.name}-nodes"
  vpc_id = aws_vpc.this.id

  ingress {
    description = "Node to node"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group_rule" "nodes_from_alb" {
  description              = "Relay NodePort from the load balancer"
  type                     = "ingress"
  from_port                = var.app_node_port
  to_port                  = var.app_node_port
  protocol                 = "tcp"
  security_group_id        = aws_security_group.nodes.id
  source_security_group_id = aws_security_group.alb.id
}
