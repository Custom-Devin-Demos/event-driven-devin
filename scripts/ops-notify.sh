#!/usr/bin/env bash
# Best-effort ops notification from the EC2 host: publishes to the
# devindemos-alerts SNS topic (email subscribers) using the instance role.
# Never fails the caller. Used by deploy-ec2.sh and vertical-guard.sh; the
# app's Slack channel is customer-facing and is not used for host ops.
#
#   scripts/ops-notify.sh <subject> <message>
set -u

SUBJECT=${1:?usage: ops-notify.sh <subject> <message>}
MESSAGE=${2:-}
TOPIC_ARN=${OPS_SNS_TOPIC_ARN:-arn:aws:sns:us-east-2:141287514968:devindemos-alerts}
REGION=${TOPIC_ARN#arn:aws:sns:}; REGION=${REGION%%:*}

command -v python3 >/dev/null 2>&1 || exit 0

SUBJECT="$SUBJECT" MESSAGE="$MESSAGE" TOPIC_ARN="$TOPIC_ARN" REGION="$REGION" \
timeout 20 python3 - <<'EOF' 2>/dev/null || true
import os
try:
    import boto3
except ImportError:
    raise SystemExit(0)
sns = boto3.client("sns", region_name=os.environ["REGION"])
sns.publish(
    TopicArn=os.environ["TOPIC_ARN"],
    Subject=os.environ["SUBJECT"][:100],
    Message=os.environ["MESSAGE"] or os.environ["SUBJECT"],
)
EOF
exit 0
