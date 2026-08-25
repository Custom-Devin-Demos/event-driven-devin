'use strict';

const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
} = require('@aws-sdk/client-sqs');
const { log } = require('./telemetry');

// Queue redrive policy (configured on the queue itself, documented here):
// maxReceiveCount=8, visibility timeout 120s. A message whose tick keeps
// failing is received 8 times before SQS moves it to the DLQ.

const MAX_RECEIVE_COUNT = 8;
const VISIBILITY_TIMEOUT_S = 120;

let client = null;

// In-memory fallback when SQS_QUEUE_URL is unset (local development, tests).
const local = {
  queue: [],
  dlq: [],
};

function sqs() {
  if (!client) client = new SQSClient({ region: process.env.AWS_REGION });
  return client;
}

async function publish(event) {
  if (!process.env.SQS_QUEUE_URL) {
    local.queue.push({ body: JSON.stringify(event), receiveCount: 0 });
    return;
  }
  await sqs().send(new SendMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MessageBody: JSON.stringify(event),
  }));
}

async function receive() {
  if (!process.env.SQS_QUEUE_URL) {
    const message = local.queue.shift();
    if (!message) return null;
    message.receiveCount += 1;
    return {
      body: message.body,
      receiveCount: message.receiveCount,
      ack: async () => {},
      nack: async () => {
        if (message.receiveCount >= MAX_RECEIVE_COUNT) {
          local.dlq.push(message);
        } else {
          local.queue.push(message);
        }
      },
    };
  }
  const result = await sqs().send(new ReceiveMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 5,
    AttributeNames: ['ApproximateReceiveCount'],
  }));
  const message = (result.Messages || [])[0];
  if (!message) return null;
  return {
    body: message.Body,
    receiveCount: Number(message.Attributes?.ApproximateReceiveCount || 1),
    ack: async () => {
      await sqs().send(new DeleteMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle,
      }));
    },
    // SQS redelivers on its own once the visibility timeout lapses.
    nack: async () => {},
  };
}

async function dlqDepth() {
  if (!process.env.SQS_DLQ_URL) return local.dlq.length;
  const result = await sqs().send(new GetQueueAttributesCommand({
    QueueUrl: process.env.SQS_DLQ_URL,
    AttributeNames: ['ApproximateNumberOfMessages'],
  }));
  return Number(result.Attributes?.ApproximateNumberOfMessages || 0);
}

async function purgeDlq() {
  if (!process.env.SQS_DLQ_URL) {
    const purged = local.dlq.length;
    local.dlq = [];
    return purged;
  }
  const depth = await dlqDepth();
  try {
    await sqs().send(new PurgeQueueCommand({ QueueUrl: process.env.SQS_DLQ_URL }));
  } catch (error) {
    log('error', 'Failed to purge DLQ', { error });
    throw error;
  }
  return depth;
}

function resetLocal() {
  local.queue = [];
  local.dlq = [];
}

module.exports = {
  publish,
  receive,
  dlqDepth,
  purgeDlq,
  resetLocal,
  MAX_RECEIVE_COUNT,
  VISIBILITY_TIMEOUT_S,
};
