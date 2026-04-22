import { Queue, Worker, Job } from 'bullmq';
import { sendNotificationToUsers } from './FirebaseMessaging.js';
import { logError } from './Helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const connection: any = process.env.REDIS_URL 
  ? process.env.REDIS_URL 
  : {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    };

export const chatQueue = new Queue('chat-jobs', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

// Track Redis connection state for graceful degradation
let isRedisConnected = process.env.ENABLE_REDIS_QUEUE === 'true';

chatQueue.on('error', (err) => {
  if (isRedisConnected) {
    console.warn(`Redis Queue Connection Failed. Background jobs degrading to inline processing. Error: ${err.message}`);
    isRedisConnected = false;
  }
});

// Worker processes incoming chat jobs
const chatWorker = new Worker('chat-jobs', async (job: Job) => {
  if (job.name === 'sendPushNotification') {
    const { recipientIds, payload, type } = job.data;
    await sendNotificationToUsers(recipientIds, payload, type as "messages" | "shardInvites" | "shardUpdates" | "questDeadlines" | "friendRequests" | "achievements");
  }
  // Future jobs like mention processing or emails can be added here
}, { connection });

chatWorker.on('failed', (job, err) => {
  logError(`QueueJobFailed:${job?.name}`, err);
});

/**
 * Enqueues a push notification securely.
 * Will silently degrade to inline execution if Redis is unavailable.
 */
export const enqueuePushNotification = async (recipientIds: string[], payload: any, type: string) => {
  if (isRedisConnected) {
    try {
      await chatQueue.add('sendPushNotification', { recipientIds, payload, type });
      return;
    } catch (err) {
      console.warn('Failed to enqueue job, automatically falling back to inline execution.', err);
      isRedisConnected = false;
    }
  }
  
  // Graceful degradation: Process inline right now to prevent data loss
  try {
    await sendNotificationToUsers(recipientIds, payload, type as "messages" | "shardInvites" | "shardUpdates" | "questDeadlines" | "friendRequests" | "achievements");
  } catch (err) {
    logError('enqueuePushNotification:inline', err);
  }
};
