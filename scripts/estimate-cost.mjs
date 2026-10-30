#!/usr/bin/env node
/**
 * AWS cost estimate for the dev and production environments.
 *
 * Every quantitative claim in the documentation has to be reproducible from a script in
 * the repository. This is that script for docs/cost.md: the tables there are this
 * script's output, not hand arithmetic.
 *
 * It makes NO AWS API calls, so it costs nothing to run and works offline. The rate table
 * below is published on-demand pricing for eu-west-2 as of August 2026. When AWS changes
 * a price, edit the rate — the assumptions are meant to be visible and arguable rather
 * than buried in a spreadsheet.
 *
 *   node scripts/estimate-cost.mjs
 *   node scripts/estimate-cost.mjs --markdown   # tables for pasting into docs/cost.md
 */

const HOURS_PER_MONTH = 730;

/**
 * Published on-demand rates, eu-west-2 (London), USD, excluding VAT.
 * Sources: AWS pricing pages for EKS, EC2, RDS, ElastiCache, VPC, ELB, KMS,
 * Secrets Manager and CloudWatch.
 */
const RATES = {
  eksControlPlaneHour: 0.10,       // per cluster, per hour — cannot be paused
  natGatewayHour: 0.045,
  natGatewayPerGB: 0.045,
  albHour: 0.02250,
  ec2: {
    't4g.small': 0.0184,
    't4g.medium': 0.0368,
  },
  // Spot is typically 60-70% off for these sizes. 0.32 of on-demand is a conservative
  // mid-point; actual savings vary by AZ and time.
  spotMultiplier: 0.32,
  rds: {
    'db.t4g.micro': 0.017,
    'db.t4g.small': 0.034,
  },
  rdsMultiAzMultiplier: 2.0,        // standby is billed at the same rate as the primary
  rdsStoragePerGB: 0.115,
  rdsBackupPerGB: 0.095,            // beyond the free allocation equal to instance storage
  elasticache: {
    'cache.t4g.micro': 0.017,
    'cache.t4g.small': 0.034,
  },
  kmsKeyMonth: 1.00,
  secretMonth: 0.40,
  cloudwatchIngestPerGB: 0.57,
  cloudwatchStoragePerGBMonth: 0.03,
  s3StoragePerGBMonth: 0.024,
  dataTransferOutPerGB: 0.09,
  route53ZoneMonth: 0.50,
  wafWebAclMonth: 5.00,
  wafManagedRuleGroupMonth: 1.00,
  wafRequestPerMillion: 0.60,
};

const hourly = (rate, qty = 1) => rate * HOURS_PER_MONTH * qty;

/** Each line: [component, spec, monthly USD]. */
function devEnvironment() {
  const lines = [];
  const add = (component, spec, monthly) => lines.push({ component, spec, monthly });

  add('EKS control plane', '1 cluster (fixed, cannot be paused)', hourly(RATES.eksControlPlaneHour));
  add(
    'EC2 worker nodes',
    '2 x t4g.small, SPOT',
    hourly(RATES.ec2['t4g.small'] * RATES.spotMultiplier, 2),
  );
  add('NAT gateway', '1 shared (single_nat_gateway = true)', hourly(RATES.natGatewayHour));
  add('NAT data processing', '~50 GB/month', 50 * RATES.natGatewayPerGB);
  add('RDS PostgreSQL', 'db.t4g.micro, single-AZ', hourly(RATES.rds['db.t4g.micro']));
  add('RDS storage', '20 GB gp3', 20 * RATES.rdsStoragePerGB);
  add('RDS backups', '1 day retention, ~5 GB over free tier', 5 * RATES.rdsBackupPerGB);
  add('ElastiCache Redis', 'cache.t4g.micro, no replica', hourly(RATES.elasticache['cache.t4g.micro']));
  add('Application Load Balancer', '1 ALB, hourly', hourly(RATES.albHour));
  add('ALB capacity units', 'light traffic, ~4 LCU-hours avg', 6.0);
  add('KMS', '1 customer-managed key', RATES.kmsKeyMonth);
  add('Secrets Manager', '2 secrets', 2 * RATES.secretMonth);
  add('CloudWatch Logs', '~5 GB ingest, 7-day retention', 5 * RATES.cloudwatchIngestPerGB + 1.5 * RATES.cloudwatchStoragePerGBMonth);
  add('VPC flow logs', 'REJECT only, ~1 GB', 1 * RATES.cloudwatchIngestPerGB);
  add('Container image storage', 'GHCR (free for public) / ECR', 1.0);
  add('Data transfer out', '~20 GB', 20 * RATES.dataTransferOutPerGB);

  return lines;
}

function prodEnvironment() {
  const lines = [];
  const add = (component, spec, monthly) => lines.push({ component, spec, monthly });

  add('EKS control plane', '1 cluster (fixed)', hourly(RATES.eksControlPlaneHour));
  add('EC2 worker nodes', '3 x t4g.medium, ON_DEMAND', hourly(RATES.ec2['t4g.medium'], 3));
  add('NAT gateways', '3, one per AZ', hourly(RATES.natGatewayHour, 3));
  add('NAT data processing', '~200 GB/month', 200 * RATES.natGatewayPerGB);
  add(
    'RDS PostgreSQL',
    'db.t4g.small, MULTI-AZ',
    hourly(RATES.rds['db.t4g.small']) * RATES.rdsMultiAzMultiplier,
  );
  add('RDS storage', '50 GB gp3, mirrored', 50 * RATES.rdsStoragePerGB * 2);
  add('RDS backups', '30 day retention, ~80 GB', 80 * RATES.rdsBackupPerGB);
  add('Performance Insights', '7-day retention (free tier)', 0);
  add(
    'ElastiCache Redis',
    '2 x cache.t4g.small (primary + replica)',
    hourly(RATES.elasticache['cache.t4g.small'], 2),
  );
  add('Application Load Balancer', '1 ALB, hourly', hourly(RATES.albHour));
  add('ALB capacity units', 'moderate traffic, ~17 LCU-hours avg', 25.0);
  add(
    'AWS WAF',
    'web ACL + 2 managed rule groups + ~10M requests',
    RATES.wafWebAclMonth + 2 * RATES.wafManagedRuleGroupMonth + 10 * RATES.wafRequestPerMillion,
  );
  add('KMS', '1 key + request volume', RATES.kmsKeyMonth + 1.0);
  add('Secrets Manager', '2 secrets', 2 * RATES.secretMonth);
  add(
    'CloudWatch Logs',
    '~40 GB ingest, 90-day retention',
    40 * RATES.cloudwatchIngestPerGB + 120 * RATES.cloudwatchStoragePerGBMonth,
  );
  add('ALB access logs', '~20 GB in S3', 20 * RATES.s3StoragePerGBMonth);
  add('Data transfer out', '~500 GB', 500 * RATES.dataTransferOutPerGB);
  add('Route 53', '1 hosted zone', RATES.route53ZoneMonth);
  add('ACM certificate', 'public certificate', 0);

  return lines;
}

const money = (n) => `$${n.toFixed(2)}`;
const total = (lines) => lines.reduce((sum, l) => sum + l.monthly, 0);

function printTable(title, lines, markdown) {
  const sum = total(lines);

  if (markdown) {
    console.log(`\n### ${title} — ~$${Math.round(sum)}/month\n`);
    console.log('| Component | Spec | Monthly |');
    console.log('|---|---|---:|');
    for (const l of lines) {
      console.log(`| ${l.component} | ${l.spec} | ${money(l.monthly)} |`);
    }
    console.log(`| **Total** | | **${money(sum)}** |`);
    return sum;
  }

  console.log(`\n${title}`);
  console.log('='.repeat(78));
  for (const l of lines) {
    const name = l.component.padEnd(28);
    const spec = l.spec.padEnd(38).slice(0, 38);
    console.log(`  ${name} ${spec} ${money(l.monthly).padStart(9)}`);
  }
  console.log('-'.repeat(78));
  console.log(`  ${'TOTAL'.padEnd(67)}${money(sum).padStart(9)}`);
  console.log(`  ${'per day'.padEnd(67)}${money(sum / 30).padStart(9)}`);
  console.log(`  ${'per hour'.padEnd(67)}${money(sum / HOURS_PER_MONTH).padStart(9)}`);

  return sum;
}

const markdown = process.argv.includes('--markdown');

const dev = devEnvironment();
const prod = prodEnvironment();

if (!markdown) {
  console.log('\nAWS cost estimate — eu-west-2, on-demand, USD ex. VAT, August 2026 rates.');
  console.log('No AWS API calls are made; this is arithmetic over a published rate table.');
}

const devTotal = printTable('DEV environment (infra/terraform/envs/dev)', dev, markdown);
const prodTotal = printTable('PRODUCTION environment (infra/terraform/envs/prod)', prod, markdown);

if (!markdown) {
  const fixedDev =
    hourly(RATES.eksControlPlaneHour) + hourly(RATES.natGatewayHour) + hourly(RATES.albHour);

  console.log(`
${'='.repeat(78)}
  Local docker compose                                                  $0.00

  The fixed floor in dev is ${money(fixedDev)}/month — EKS control plane, NAT
  gateway and ALB. That is ${((fixedDev / devTotal) * 100).toFixed(0)}% of the dev bill, and scaling every
  pod to zero does not reduce it.

  Running the dev environment for one hour costs about ${money(devTotal / HOURS_PER_MONTH)}.
  Running it for a working day costs about ${money((devTotal / HOURS_PER_MONTH) * 8)}.

  Stop paying:  make teardown       (see docs/teardown.md)
${'='.repeat(78)}
`);
}

if (markdown) {
  console.log(`\n**Dev:** ~$${Math.round(devTotal)}/month · **Production:** ~$${Math.round(prodTotal)}/month · **Local:** $0\n`);
}
