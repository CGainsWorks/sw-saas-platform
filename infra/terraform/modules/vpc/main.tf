/**
 * VPC with public and private subnets across N availability zones.
 *
 * Layout:
 *   public   - the ALB and the NAT gateways. Internet-routable.
 *   private  - EKS worker nodes. Egress via NAT, no inbound from the internet.
 *   data     - RDS and ElastiCache. No route to a NAT at all, so a compromised
 *              database instance cannot call out.
 *
 * The data tier having no egress route is the detail worth noticing. It costs nothing and
 * removes a whole class of exfiltration path: even with code execution on the database
 * host there is nowhere to send the data.
 *
 * COST WARNING: NAT gateways are the single largest fixed line item in this stack —
 * roughly $32/month each plus $0.045/GB processed. `single_nat_gateway = true` (the dev
 * default) uses one for the whole VPC, which is a real availability compromise: losing
 * that AZ takes egress with it. Production uses one per AZ. See docs/cost.md.
 */

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  tags = merge(var.tags, {
    Module = "vpc"
  })

  # /16 split into /20s: 4096 addresses per subnet, room for 3 tiers across 3 AZs with
  # space left over. Sized for node churn — every pod takes a VPC address under the AWS
  # CNI, and subnet exhaustion during a rollout is a genuinely unpleasant failure.
  public_cidrs  = [for i, az in local.azs : cidrsubnet(var.cidr_block, 4, i)]
  private_cidrs = [for i, az in local.azs : cidrsubnet(var.cidr_block, 4, i + 4)]
  data_cidrs    = [for i, az in local.azs : cidrsubnet(var.cidr_block, 4, i + 8)]
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block         = var.cidr_block
  enable_dns_support = true
  # Required by EKS: nodes and pods resolve service endpoints by name.
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

/* ------------------------------------------------------------------ subnets */

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.tags, {
    Name = "${var.name}-public-${local.azs[count.index]}"
    Tier = "public"
    # Tells the AWS Load Balancer Controller which subnets to place internet-facing
    # load balancers in. Without it, ingress creation fails with an unhelpful message.
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  })
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = merge(local.tags, {
    Name                                        = "${var.name}-private-${local.azs[count.index]}"
    Tier                                        = "private"
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  })
}

resource "aws_subnet" "data" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.data_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = merge(local.tags, {
    Name = "${var.name}-data-${local.azs[count.index]}"
    Tier = "data"
  })
}

/* ------------------------------------------------------------------- egress */

resource "aws_eip" "nat" {
  count = var.single_nat_gateway ? 1 : var.az_count

  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count = var.single_nat_gateway ? 1 : var.az_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })

  depends_on = [aws_internet_gateway.this]
}

/* ------------------------------------------------------------- route tables */

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One route table per AZ so each private subnet can use the NAT gateway in its own AZ.
# Cross-AZ NAT traffic is billed as inter-AZ data transfer on top of NAT processing.
resource "aws_route_table" "private" {
  count = var.az_count

  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-private-${local.azs[count.index]}" })
}

resource "aws_route" "private_nat" {
  count = var.az_count

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Deliberately no 0.0.0.0/0 route. The data tier can be reached from the private subnets
# and can reach nothing outward. See the module header.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-data" })
}

resource "aws_route_table_association" "data" {
  count = var.az_count

  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

/* ------------------------------------------------------------- vpc endpoints */

# S3 via a gateway endpoint. Free, and it keeps ECR image layer pulls (which are stored in
# S3) off the NAT gateway — on a busy cluster that is a meaningful share of the NAT bill.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.private[*].id, [aws_route_table.data.id])

  tags = merge(local.tags, { Name = "${var.name}-s3" })
}

/* --------------------------------------------------------------- flow logs */

resource "aws_cloudwatch_log_group" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name              = "/aws/vpc/${var.name}/flow-logs"
  retention_in_days = var.flow_log_retention_days

  tags = local.tags
}

resource "aws_iam_role" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name = "${var.name}-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name = "${var.name}-flow-logs"
  role = aws_iam_role.flow_logs[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.flow_logs[0].arn}:*"
    }]
  })
}

# Rejected traffic only. ALL is far more useful during an investigation and far more
# expensive to ingest; REJECT answers "what is being blocked" for a fraction of the volume.
resource "aws_flow_log" "this" {
  count = var.enable_flow_logs ? 1 : 0

  vpc_id                   = aws_vpc.this.id
  traffic_type             = "REJECT"
  iam_role_arn             = aws_iam_role.flow_logs[0].arn
  log_destination          = aws_cloudwatch_log_group.flow_logs[0].arn
  max_aggregation_interval = 600

  tags = merge(local.tags, { Name = "${var.name}-flow-logs" })
}
