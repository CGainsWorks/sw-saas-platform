#!/usr/bin/env bash
# Run the dev overlay on a local kind cluster, with everything AWS would supply emulated.
#
#   scripts/kind/up.sh           create the cluster and deploy (idempotent)
#   scripts/kind/up.sh --down    delete the cluster
#
# What it builds, in order:
#   1. a kind cluster with the default CNI disabled, then Calico, so NetworkPolicies are
#      actually enforced
#   2. the API and web images, built locally and loaded into the node (nothing is pulled
#      from ghcr.io); set SKIP_BUILD=1 when they are already built, as CI does
#   3. Postgres and Redis in a `data` namespace (stand-ins for RDS and ElastiCache)
#   4. LocalStack Secrets Manager, holding a freshly generated application secret
#   5. the External Secrets Operator, pointed at LocalStack instead of AWS
#   6. infra/k8s/overlays/kind: the dev overlay plus static LocalStack credentials
# and then waits for the ExternalSecret to sync, the migration Job to finish and both
# Deployments to become ready.
#
# Pinned versions live in infra/k8s/kind/versions.env. Throwaway key material goes in
# .kind/ (gitignored) so scripts/kind/isolation-tests.sh can sign tokens the API accepts.
#
# Requires docker, kind, kubectl, helm, curl, openssl and sha256sum.

set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: do not rewrite /tmp/... arguments into Windows paths

cd "$(dirname "$0")/../.."
# shellcheck source=/dev/null # plain KEY=value pins, see the file
source infra/k8s/kind/versions.env

CLUSTER="${KIND_CLUSTER:-saas}"
CTX="kind-$CLUSTER"
WORK=.kind
API_IMAGE=ghcr.io/cgainsworks/sw-saas-platform-api:dev
WEB_IMAGE=ghcr.io/cgainsworks/sw-saas-platform-web:dev
LOCALSTACK_URL=http://localstack.localstack.svc.cluster.local:4566

k() { kubectl --context "$CTX" "$@"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

for t in docker kind kubectl helm curl openssl sha256sum; do
  command -v "$t" >/dev/null 2>&1 || { echo "missing required tool: $t" >&2; exit 1; }
done

if [ "${1:-}" = "--down" ]; then
  kind delete cluster --name "$CLUSTER"
  exit 0
fi

diagnostics() {
  echo
  echo '---- diagnostics ----'
  k get pods -A -o wide || true
  k -n saas get externalsecret,secretstore,job,deploy || true
  k -n saas describe externalsecret saas-api-secrets || true
  k -n saas get events --sort-by=.lastTimestamp | tail -40 || true
  k -n saas logs job/saas-migrate --tail=50 || true
  k -n saas logs deploy/saas-api --tail=50 || true
  k -n external-secrets logs deploy/external-secrets --tail=50 || true
}
trap 'diagnostics' ERR

mkdir -p "$WORK"

step "Cluster ($KIND_NODE_IMAGE)"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "cluster $CLUSTER already exists"
else
  kind create cluster --name "$CLUSTER" --config infra/k8s/kind/cluster.yaml \
    --image "$KIND_NODE_IMAGE" --wait 0s
fi

step "Calico $CALICO_VERSION"
curl -fsSL -o "$WORK/calico.yaml" \
  "https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/calico.yaml"
echo "$CALICO_MANIFEST_SHA256  $WORK/calico.yaml" | sha256sum -c -
# Pin the IP pool to kind's pod subnet rather than relying on auto-detection.
sed -i \
  -e 's|# - name: CALICO_IPV4POOL_CIDR|- name: CALICO_IPV4POOL_CIDR|' \
  -e 's|#   value: "192.168.0.0/16"|  value: "10.244.0.0/16"|' \
  "$WORK/calico.yaml"
grep -q 'value: "10.244.0.0/16"' "$WORK/calico.yaml"
k apply -f "$WORK/calico.yaml" >/dev/null
k -n kube-system rollout status daemonset/calico-node --timeout=300s
k -n kube-system rollout status deployment/calico-kube-controllers --timeout=300s
k wait --for=condition=Ready nodes --all --timeout=180s

step "Images"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  docker build -q -f apps/api/Dockerfile -t "$API_IMAGE" .
  docker build -q -f apps/web/Dockerfile -t "$WEB_IMAGE" .
fi
kind load docker-image "$API_IMAGE" "$WEB_IMAGE" --name "$CLUSTER"

step "Data stores and LocalStack"
k create namespace data --dry-run=client -o yaml | k apply -f - >/dev/null
# The same role bootstrap docker compose mounts, from its single source.
k -n data create configmap postgres-init --from-file=infra/postgres/init \
  --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -f infra/k8s/kind/datastores.yaml
# The ServiceMonitor CRD only, so the dev overlay applies unchanged. No Prometheus
# operator runs here; the object is accepted and nothing scrapes it.
PO_RAW=https://raw.githubusercontent.com/prometheus-operator/prometheus-operator
curl -fsSL -o "$WORK/servicemonitor-crd.yaml" \
  "$PO_RAW/$PROMETHEUS_OPERATOR_VERSION/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml"
echo "$SERVICEMONITOR_CRD_SHA256  $WORK/servicemonitor-crd.yaml" | sha256sum -c -
k apply --server-side -f "$WORK/servicemonitor-crd.yaml" >/dev/null

step "External Secrets Operator $ESO_CHART_VERSION (Secrets Manager endpoint -> LocalStack)"
helm repo add external-secrets https://charts.external-secrets.io --force-update >/dev/null
helm --kube-context "$CTX" upgrade --install external-secrets external-secrets/external-secrets \
  --version "$ESO_CHART_VERSION" -n external-secrets --create-namespace \
  --set installCRDs=true \
  --set "extraEnv[0].name=AWS_SECRETSMANAGER_ENDPOINT" \
  --set "extraEnv[0].value=$LOCALSTACK_URL" \
  --set "extraEnv[1].name=AWS_STS_ENDPOINT" \
  --set "extraEnv[1].value=$LOCALSTACK_URL" \
  --wait --timeout 5m

step "Waiting for the data stores"
k -n data rollout status deployment/postgres --timeout=180s
k -n data rollout status deployment/redis --timeout=180s
k -n localstack rollout status deployment/localstack --timeout=300s

step "Seeding saas-dev/app in LocalStack Secrets Manager"
# Throwaway material, generated per cluster. The API refuses to start in production mode
# without a signing key pair or with the development OIDC client secret.
if [ ! -f "$WORK/jwt.key" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WORK/jwt.key" 2>/dev/null
  openssl pkey -in "$WORK/jwt.key" -pubout -out "$WORK/jwt.pub"
  openssl rand -hex 24 >"$WORK/oidc-client-secret"
fi
JWT_PRIVATE_KEY_B64=$(base64 <"$WORK/jwt.key" | tr -d '\n')
JWT_PUBLIC_KEY_B64=$(base64 <"$WORK/jwt.pub" | tr -d '\n')
OIDC_CLIENT_SECRET=$(cat "$WORK/oidc-client-secret")
# Same property names as the secret infra/terraform/envs/dev writes on AWS.
printf '{"DATABASE_URL":"%s","DATABASE_ADMIN_URL":"%s","REDIS_URL":"%s","JWT_PRIVATE_KEY_B64":"%s","JWT_PUBLIC_KEY_B64":"%s","OIDC_CLIENT_SECRET":"%s"}' \
  "postgres://app_user:app_dev_password@postgres.data.svc.cluster.local:5432/saas" \
  "postgres://postgres:postgres@postgres.data.svc.cluster.local:5432/saas" \
  "redis://redis.data.svc.cluster.local:6379" \
  "$JWT_PRIVATE_KEY_B64" "$JWT_PUBLIC_KEY_B64" "$OIDC_CLIENT_SECRET" >"$WORK/app-secret.json"
k -n localstack exec -i deploy/localstack -- sh -c '
  cat > /tmp/app.json
  awslocal --region eu-west-2 secretsmanager create-secret --name saas-dev/app \
    --secret-string file:///tmp/app.json >/dev/null 2>&1 ||
  awslocal --region eu-west-2 secretsmanager put-secret-value --secret-id saas-dev/app \
    --secret-string file:///tmp/app.json >/dev/null
  awslocal --region eu-west-2 secretsmanager describe-secret --secret-id saas-dev/app \
    --query "{Name:Name,ARN:ARN}" --output text
  rm -f /tmp/app.json' <"$WORK/app-secret.json"
rm -f "$WORK/app-secret.json"

step "Applying infra/k8s/overlays/kind (dev overlay + LocalStack credentials)"
k apply -k infra/k8s/overlays/kind

step "Waiting for External Secrets to sync saas-api-secrets from LocalStack"
k -n saas wait externalsecret/saas-api-secrets --for=condition=Ready --timeout=180s
k -n saas get secret saas-api-secrets -o jsonpath='{.data}' |
  grep -o '"[A-Z0-9_]*"' | tr -d '"' | sort | tr '\n' ' '
echo

step "Waiting for the migration Job and the Deployments"
k -n saas wait job/saas-migrate --for=condition=Complete --timeout=300s
k -n saas rollout status deployment/saas-api --timeout=300s
k -n saas rollout status deployment/saas-web --timeout=300s
k -n saas get pods -o wide

trap - ERR
step "Up. Next: scripts/kind/netpol-check.sh and scripts/kind/isolation-tests.sh"
