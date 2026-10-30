#!/usr/bin/env bash
# Prove the NetworkPolicies in infra/k8s/base/networkpolicy.yaml are enforced.
#
# Run after scripts/kind/up.sh. Each check opens a TCP connection from inside a pod to the
# ClusterIP of Postgres or Redis in the `data` namespace and asserts the outcome:
#
#   saas-api pod            -> postgres, redis   must CONNECT  (allowed by the saas-api policy)
#   saas-web pod            -> postgres, redis   must FAIL     (web may talk to the API only)
#   unlabelled pod in saas  -> postgres          must FAIL     (default-deny)
#   same pod, other ns      -> postgres          must CONNECT  (control: Postgres is reachable,
#                                                               so the failures above are the
#                                                               policy and not the network)
#
# The migration Job reaching Postgres is the remaining allowed case; up.sh already waits
# for it to complete.
#
# Connections are made by IP, not name, so a denied pod fails on the Postgres connection
# itself rather than on the DNS lookup that default-deny also blocks.

set -euo pipefail
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/../.."
CTX="kind-${KIND_CLUSTER:-saas}"
k() { kubectl --context "$CTX" "$@"; }

PG_IP=$(k -n data get svc postgres -o jsonpath='{.spec.clusterIP}')
REDIS_IP=$(k -n data get svc redis -o jsonpath='{.spec.clusterIP}')
echo "postgres $PG_IP:5432, redis $REDIS_IP:6379"

# A 4 s TCP connect in node, which both application images have. Exit 0 on connect.
probe_js() {
  printf "const s=require('net').connect({host:'%s',port:%s});s.setTimeout(4000);s.on('connect',()=>{console.log('connected');process.exit(0)});s.on('timeout',()=>{console.log('timed out');process.exit(1)});s.on('error',e=>{console.log(e.code);process.exit(1)})" "$1" "$2"
}

failures=0
check() { # check <expect: allow|deny> <label> <kubectl exec target...> -- <ip> <port>
  local expect=$1 label=$2
  shift 2
  local target=()
  while [ "$1" != "--" ]; do target+=("$1"); shift; done
  shift
  local out rc=0
  out=$(k exec "${target[@]}" -- node -e "$(probe_js "$1" "$2")" 2>&1) || rc=$?
  out=${out%%$'\n'*} # first line only; kubectl appends "command terminated ..."
  local got=deny
  [ "$rc" -eq 0 ] && got=allow
  if [ "$got" = "$expect" ]; then
    printf '  PASS  %-52s expected %-5s got %-5s (%s)\n' "$label" "$expect" "$got" "$out"
  else
    printf '  FAIL  %-52s expected %-5s got %-5s (%s)\n' "$label" "$expect" "$got" "$out"
    failures=$((failures + 1))
  fi
}

echo "Starting the probe pod in saas and in netpol-control"
k create namespace netpol-control --dry-run=client -o yaml | k apply -f - >/dev/null
k -n saas apply -f infra/k8s/kind/netpol-probe.yaml >/dev/null
k -n netpol-control apply -f infra/k8s/kind/netpol-probe.yaml >/dev/null
k -n saas wait pod/netpol-probe --for=condition=Ready --timeout=120s >/dev/null
k -n netpol-control wait pod/netpol-probe --for=condition=Ready --timeout=120s >/dev/null

echo "NetworkPolicy enforcement (Calico):"
check allow "saas-api -> postgres" -n saas deploy/saas-api -c api -- "$PG_IP" 5432
check allow "saas-api -> redis" -n saas deploy/saas-api -c api -- "$REDIS_IP" 6379
check deny "saas-web -> postgres" -n saas deploy/saas-web -c web -- "$PG_IP" 5432
check deny "saas-web -> redis" -n saas deploy/saas-web -c web -- "$REDIS_IP" 6379
check deny "unlabelled pod in saas -> postgres" -n saas netpol-probe -- "$PG_IP" 5432
check allow "same pod in netpol-control (no policies) -> postgres" -n netpol-control netpol-probe -- "$PG_IP" 5432

k -n saas delete pod netpol-probe --wait=false >/dev/null
k delete namespace netpol-control --wait=false >/dev/null

if [ "$failures" -ne 0 ]; then
  echo "$failures NetworkPolicy check(s) failed" >&2
  exit 1
fi
echo "All NetworkPolicy checks passed."
