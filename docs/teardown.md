# Teardown — how to stop paying

The short version:

```bash
make teardown
```

The long version matters, because **`terraform destroy` alone will not empty the
account.** Several resources are either protected on purpose, created by something other
than Terraform, or refuse to delete while something else still references them. Each one
is a line item that keeps billing after you believe the stack is gone.

---

## Local demo

Nothing to pay for, but to reclaim the disk:

```bash
docker compose down -v          # containers, network AND the postgres/redis volumes
docker image prune -a           # optional: reclaim ~1.5 GB of build layers
```

`down` without `-v` keeps the database volume, which is what you want between runs.

---

## AWS: the order matters

Destroy from the outside in. Terraform mostly works this out from the dependency graph,
but the resources it does **not** know about have to go first, or they hold their
dependencies hostage and the destroy hangs for twenty minutes before failing.

### 1. Delete Kubernetes objects that create AWS resources

This is the step people skip.

The AWS Load Balancer Controller creates a real ALB, target groups and security groups in
response to an `Ingress` object. **Terraform did not create them and does not know they
exist.** Destroying the cluster orphans them: the ALB keeps billing at ~$16/month, and its
security group blocks the VPC from being deleted, so the Terraform destroy fails with a
`DependencyViolation` that gives no hint as to the cause.

```bash
aws eks update-kubeconfig --name saas-dev --region eu-west-2

# Removes the Ingress, which makes the controller delete the ALB it created.
kubectl delete -k infra/k8s/overlays/dev --ignore-not-found

# Confirm the load balancer is actually gone before continuing. This can take a minute.
aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?contains(LoadBalancerName, 'saas')].[LoadBalancerName,State.Code]" \
  --output table
```

Do the same for any `Service` of `type: LoadBalancer` (this project has none — everything
goes through the single Ingress — but check).

### 2. Turn off deletion protection

Production sets `deletion_protection = true` on RDS deliberately: it is the friction in
front of "destroy the customer database". Removing it is a separate, visible change.

```bash
# Only needed for prod. The dev environment sets deletion_protection = false already.
aws rds modify-db-instance \
  --db-instance-identifier saas-prod-postgres \
  --no-deletion-protection --apply-immediately

aws rds wait db-instance-available --db-instance-identifier saas-prod-postgres
```

### 3. Destroy the Terraform-managed infrastructure

```bash
cd infra/terraform/envs/dev
terraform destroy
```

Expect **15–25 minutes**. Most of it is the EKS control plane and the RDS final snapshot.

If it fails partway, run it again — `destroy` is idempotent and the second pass usually
clears whatever was still draining.

### 4. Handle what Terraform leaves behind

**RDS final snapshot.** Production has `skip_final_snapshot = false`, so a final snapshot
is taken and then **kept forever**, billing at snapshot storage rates. That is the correct
default and it is also a charge nobody expects.

```bash
aws rds describe-db-snapshots --snapshot-type manual \
  --query "DBSnapshots[?contains(DBSnapshotIdentifier,'saas')].[DBSnapshotIdentifier,SnapshotCreateTime,AllocatedStorage]" \
  --output table

# Only once you are certain you do not want it back.
aws rds delete-db-snapshot --db-snapshot-identifier <identifier>
```

**Secrets Manager entries.** With a non-zero recovery window these are *scheduled* for
deletion, not deleted. They keep billing ($0.40/month each) and — more annoyingly — the
name stays reserved, so recreating the stack fails with a name collision.

```bash
aws secretsmanager list-secrets \
  --include-planned-deletion \
  --query "SecretList[?contains(Name,'saas')].[Name,DeletedDate]" --output table

# Skip the recovery window entirely.
aws secretsmanager delete-secret --secret-id saas-prod/app --force-delete-without-recovery
```

The dev environment sets `recovery_window_in_days = 0` precisely so this step is not
needed there.

**KMS key.** Scheduled for deletion after the window (7 days in dev, 30 in prod) and
billed at $1/month until then. Seven days is the AWS minimum; it cannot be made immediate.

```bash
aws kms describe-key --key-id alias/saas-dev \
  --query 'KeyMetadata.[KeyState,DeletionDate]' --output table
```

**CloudWatch log groups.** Terraform destroys the ones it created. EKS also creates
`/aws/eks/<cluster>/cluster` and the containers may have created others.

```bash
aws logs describe-log-groups --log-group-name-prefix /aws/eks/saas \
  --query 'logGroups[].logGroupName' --output text | \
  xargs -r -n1 aws logs delete-log-group --log-group-name
```

**Orphaned EBS volumes and snapshots.** Node root volumes should go with the nodes, but a
volume detached during a spot reclaim can survive.

```bash
aws ec2 describe-volumes --filters Name=status,Values=available \
  --query 'Volumes[].[VolumeId,Size,CreateTime]' --output table
```

**Elastic IPs.** An unattached EIP costs ~$3.60/month. They are released with the NAT
gateways, but check.

```bash
aws ec2 describe-addresses \
  --query 'Addresses[?AssociationId==`null`].[PublicIp,AllocationId]' --output table
```

---

## Verify the account is actually clean

Do not trust "destroy complete". Check.

```bash
REGION=eu-west-2

echo "--- EKS clusters ---";        aws eks list-clusters --region $REGION
echo "--- RDS instances ---";       aws rds describe-db-instances --region $REGION \
  --query 'DBInstances[].DBInstanceIdentifier'
echo "--- RDS snapshots ---";       aws rds describe-db-snapshots --region $REGION \
  --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier'
echo "--- ElastiCache ---";         aws elasticache describe-replication-groups --region $REGION \
  --query 'ReplicationGroups[].ReplicationGroupId'
echo "--- Load balancers ---";      aws elbv2 describe-load-balancers --region $REGION \
  --query 'LoadBalancers[].LoadBalancerName'
echo "--- NAT gateways ---";        aws ec2 describe-nat-gateways --region $REGION \
  --filter Name=state,Values=available --query 'NatGateways[].NatGatewayId'
echo "--- Elastic IPs ---";         aws ec2 describe-addresses --region $REGION \
  --query 'Addresses[].PublicIp'
echo "--- Non-default VPCs ---";    aws ec2 describe-vpcs --region $REGION \
  --filters Name=isDefault,Values=false --query 'Vpcs[].VpcId'
echo "--- Secrets ---";             aws secretsmanager list-secrets --region $REGION \
  --include-planned-deletion --query 'SecretList[].Name'
```

Every one of those should be empty (or contain only things belonging to other projects).

Then confirm against the bill, which is the only source of truth that matters:

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -d '2 days ago' +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY --metrics UnblendedCost \
  --filter '{"Tags":{"Key":"Project","Values":["sw-saas-platform"]}}'
```

Cost Explorer lags by up to 24 hours, so check again the following day. **Yesterday's
figure trending to zero is the real confirmation.**

---

## If destroy gets stuck

| Symptom | Cause | Fix |
|---|---|---|
| `DependencyViolation` deleting a subnet or VPC | An ALB or ENI created by the Load Balancer Controller still exists | Do step 1. Then `aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=<vpc>` and delete leftovers |
| RDS destroy hangs ~10 min | Taking the final snapshot | Wait. `aws rds describe-db-instances` shows status `deleting` |
| `InvalidParameterCombination: deletion protection` | Step 2 not done | Turn off deletion protection, retry |
| Security group will not delete | Another SG rule references it | `aws ec2 describe-security-groups --filters Name=ip-permission.group-id,Values=<sg>` to find the referrer |
| EKS destroy hangs on the node group | Pods with a PodDisruptionBudget blocking the drain | `kubectl delete pdb --all -n saas`, then retry |
| Secret name already exists on re-apply | Previous secret still in its recovery window | `--force-delete-without-recovery` (above) |

---

## The control that actually works

Every technique above is a way of cleaning up after the fact. The one that reliably
prevents surprise bills is deciding, before you apply, when you will destroy — and setting
the budget alert from [cost.md](cost.md#guardrails-worth-setting-up-first) so that being
wrong about it is noisy rather than silent.

For a short-lived evaluation environment: apply, capture the screenshots and `kubectl` output
you need as evidence, destroy the same day. That is about **$1**.
