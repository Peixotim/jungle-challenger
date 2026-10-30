#!/bin/sh
set -eu

MAIN_QUEUE="wager-transactions.fifo"
DLQ="wager-transactions-dlq.fifo"
MAX_RECEIVES=5

awslocal sqs create-queue --queue-name "$DLQ" \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/$DLQ" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue --queue-name "$MAIN_QUEUE" --attributes "{
  \"FifoQueue\": \"true\",
  \"ContentBasedDeduplication\": \"true\",
  \"VisibilityTimeout\": \"30\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"$MAX_RECEIVES\\\"}\"
}"

echo "SQS queues ready: $MAIN_QUEUE (DLQ: $DLQ, maxReceiveCount=$MAX_RECEIVES)"
